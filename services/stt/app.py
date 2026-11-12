"""Local speech-to-text API backed by whisper.cpp."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import wave
from collections import deque
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel


app = FastAPI(title="Local STT", version="0.1.0")
logger = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"

WHISPER_CPP_BIN = Path(os.getenv("WHISPER_CPP_BIN", "whisper-cli"))
WHISPER_MODEL = Path(os.getenv("WHISPER_MODEL", ""))
VAD_MODEL = Path(
    os.getenv("SILERO_VAD_MODEL", str(Path(__file__).parent / "models" / "silero_vad.onnx"))
)
STT_TIMEOUT_SECONDS = float(os.getenv("STT_TIMEOUT_SECONDS", "20"))
WHISPER_THREADS = int(os.getenv("WHISPER_THREADS", "6"))
MAX_AUDIO_BYTES = int(os.getenv("STT_MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))
VAD_SAMPLE_RATE = 16_000
VAD_FRAME_SAMPLES = 512
VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * 2
VAD_MIN_SILENCE_MS = int(os.getenv("VAD_MIN_SILENCE_MS", "1000"))
VAD_THRESHOLD = float(os.getenv("VAD_THRESHOLD", "0.65"))
VAD_MIN_SPEECH_MS = int(os.getenv("VAD_MIN_SPEECH_MS", "250"))
VAD_START_CONFIRM_MS = int(os.getenv("VAD_START_CONFIRM_MS", "120"))


class TranscriptionResponse(BaseModel):
    text: str
    language: str = "tr"


@app.get("/")
async def browser_demo() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/flow")
async def system_flow() -> FileResponse:
    return FileResponse(STATIC_DIR / "system-flow.html")


@app.get("/health")
async def health() -> dict[str, str]:
    configured = bool(str(WHISPER_MODEL)) and WHISPER_MODEL.is_file()
    executable = (
        WHISPER_CPP_BIN.is_file()
        if WHISPER_CPP_BIN.parent != Path(".")
        else shutil.which(str(WHISPER_CPP_BIN)) is not None
    )
    if not configured or not executable or not VAD_MODEL.is_file():
        raise HTTPException(
            status_code=503,
            detail="Whisper or Silero model/executable is not configured",
        )
    return {"status": "ok"}


@lru_cache(maxsize=1)
def _vad_session() -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    return ort.InferenceSession(
        str(VAD_MODEL),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )


class SileroStream:
    """Small streaming adapter for the official Silero ONNX model."""

    def __init__(self) -> None:
        self.session = _vad_session()
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, 64), dtype=np.float32)
        self.current_sample = 0
        self.silence_start: int | None = None
        self.silence_started_at: float | None = None
        self.last_silence_started_at: float | None = None
        self.in_speech = False
        self.speech_start_sample: int | None = None
        self.start_candidate_samples = 0
        self.speech_samples = 0
        self.min_silence_samples = VAD_SAMPLE_RATE * VAD_MIN_SILENCE_MS // 1000
        self.min_speech_samples = VAD_SAMPLE_RATE * VAD_MIN_SPEECH_MS // 1000
        self.start_confirm_samples = VAD_SAMPLE_RATE * VAD_START_CONFIRM_MS // 1000
        self.speech_pad_samples = 30 * VAD_SAMPLE_RATE // 1000

    def process(self, pcm_frame: bytes) -> str | None:
        samples = np.frombuffer(pcm_frame, dtype="<i2").astype(np.float32) / 32768.0
        audio = samples.reshape(1, VAD_FRAME_SAMPLES)
        model_input = np.concatenate((self.context, audio), axis=1)
        probability, self.state = self.session.run(
            None,
            {
                "input": model_input,
                "state": self.state,
                "sr": np.array(VAD_SAMPLE_RATE, dtype=np.int64),
            },
        )
        self.context = model_input[:, -64:]
        self.current_sample += VAD_FRAME_SAMPLES
        speech_probability = float(np.asarray(probability).reshape(-1)[0])

        if not self.in_speech:
            if speech_probability >= VAD_THRESHOLD:
                self.start_candidate_samples += VAD_FRAME_SAMPLES
                if self.start_candidate_samples >= self.start_confirm_samples:
                    self.in_speech = True
                    self.speech_start_sample = self.current_sample - self.start_candidate_samples
                    self.speech_samples = self.start_candidate_samples
                    self.start_candidate_samples = 0
                    return "speech_start"
            else:
                self.start_candidate_samples = 0
            return None

        if speech_probability >= VAD_THRESHOLD:
            self.speech_samples += VAD_FRAME_SAMPLES
            if self.silence_start is not None:
                self.silence_start = None
                self.silence_started_at = None

        if speech_probability < max(VAD_THRESHOLD - 0.15, 0.01) and self.in_speech:
            if self.silence_start is None:
                self.silence_start = self.current_sample
                self.silence_started_at = time.perf_counter()
            if self.current_sample - self.silence_start >= self.min_silence_samples:
                self.in_speech = False
                self.silence_start = None
                self.last_silence_started_at = self.silence_started_at
                self.silence_started_at = None
                duration = self.speech_samples
                self.speech_start_sample = None
                self.speech_samples = 0
                return "speech_end" if duration >= self.min_speech_samples else "speech_discarded"

        return None


def _transcribe_pcm(pcm_audio: bytes) -> str:
    with tempfile.TemporaryDirectory(prefix="vad-stt-") as temp_dir:
        root = Path(temp_dir)
        audio_path = root / "utterance.wav"
        with wave.open(str(audio_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(VAD_SAMPLE_RATE)
            wav.writeframes(pcm_audio)
        return _run_whisper(audio_path, root / "transcription")


async def _send_transcription(
    websocket: WebSocket,
    pcm_audio: bytes,
    silence_started_at: float | None = None,
) -> None:
    endpoint_detected_at = time.perf_counter()
    endpointing_ms = (
        round((endpoint_detected_at - silence_started_at) * 1000, 1)
        if silence_started_at is not None
        else None
    )
    await websocket.send_json({"type": "transcribing"})
    transcription_started_at = time.perf_counter()
    try:
        text = await asyncio.to_thread(_transcribe_pcm, pcm_audio)
        completed_at = time.perf_counter()
        timing = {
            "endpointing_ms": endpointing_ms,
            "transcription_ms": round((completed_at - transcription_started_at) * 1000, 1),
            "total_ms": (
                round((completed_at - silence_started_at) * 1000, 1)
                if silence_started_at is not None
                else None
            ),
        }
        await websocket.send_json({"type": "transcript", "text": text, "timing": timing})
    except HTTPException as exc:
        await websocket.send_json({"type": "error", "message": exc.detail})
    except Exception:
        logger.exception("VAD utterance transcription failed")
        await websocket.send_json(
            {"type": "error", "message": "Konuşma yazıya çevrilemedi; tekrar deneyin."}
        )


@app.websocket("/v1/listen")
async def listen_for_speech(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        vad = SileroStream()
    except Exception:
        logger.exception("Silero VAD could not be initialized")
        await websocket.send_json({"type": "error", "message": "Silero VAD başlatılamadı."})
        await websocket.close(code=1011)
        return

    await websocket.send_json({"type": "ready"})
    pre_roll: deque[bytes] = deque(maxlen=8)
    utterance = bytearray()
    recording = False

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") == "stop":
                if recording and utterance:
                    await _send_transcription(websocket, bytes(utterance))
                break

            pcm_frame = message.get("bytes")
            if pcm_frame is None:
                continue
            if len(pcm_frame) != VAD_FRAME_BYTES:
                await websocket.send_json(
                    {"type": "error", "message": "Ses paketi hatalı; dinleme durduruldu."}
                )
                break

            event = vad.process(pcm_frame)
            if recording:
                utterance.extend(pcm_frame)
            else:
                pre_roll.append(pcm_frame)

            if event == "speech_start" and not recording:
                utterance = bytearray(b"".join(pre_roll))
                recording = True
                await websocket.send_json({"type": "speech_start"})
            elif event == "speech_end" and recording:
                recording = False
                await _send_transcription(
                    websocket, bytes(utterance), vad.last_silence_started_at
                )
                utterance.clear()
                pre_roll.clear()
            elif event == "speech_discarded" and recording:
                recording = False
                utterance.clear()
                pre_roll.clear()
                await websocket.send_json({"type": "discarded"})

            if recording and len(utterance) > MAX_AUDIO_BYTES:
                recording = False
                utterance.clear()
                pre_roll.clear()
                await websocket.send_json(
                    {"type": "error", "message": "Konuşma bölümü çok uzun; dinlemeye devam ediyorum."}
                )
    except WebSocketDisconnect:
        pass
    finally:
        if websocket.client_state.name == "CONNECTED":
            await websocket.close()


def _validate_wav(path: Path) -> None:
    try:
        with wave.open(str(path), "rb") as wav:
            valid = (
                wav.getnchannels() == 1
                and wav.getsampwidth() == 2
                and wav.getframerate() == 16_000
                and wav.getcomptype() == "NONE"
                and wav.getnframes() > 0
            )
    except (wave.Error, EOFError) as exc:
        raise HTTPException(status_code=415, detail="Audio must be a valid PCM WAV file") from exc
    if not valid:
        raise HTTPException(
            status_code=422,
            detail="Expected non-empty 16 kHz, mono, 16-bit PCM WAV audio",
        )


def _run_whisper(audio_path: Path, output_base: Path) -> str:
    command = [
        str(WHISPER_CPP_BIN),
        "-t",
        str(WHISPER_THREADS),
        "-m",
        str(WHISPER_MODEL),
        "-f",
        str(audio_path),
        "-l",
        "tr",
        "--prompt",
        "Emlak telefon görüşmesi: sahibinden.com, Sahibinden, ilan numarası, emlak danışmanı, daire, villa, kiralık, satılık.",
        "--carry-initial-prompt",
        "-oj",
        "-of",
        str(output_base),
        "-np",
    ]
    if os.getenv("WHISPER_USE_GPU", "0") != "1":
        command.append("-ng")
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=STT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Speech recognition timed out") from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="whisper.cpp could not be started") from exc

    if result.returncode != 0:
        logger.error(
            "whisper.cpp exited with code %s: %s",
            result.returncode,
            result.stderr[-2000:].strip(),
        )
        raise HTTPException(status_code=502, detail="whisper.cpp failed to transcribe audio")

    output_json = output_base.with_suffix(".json")
    try:
        payload = json.loads(output_json.read_text(encoding="utf-8"))
        segments = payload.get("transcription", [])
        text = " ".join(segment.get("text", "").strip() for segment in segments).strip()
    except (OSError, json.JSONDecodeError, AttributeError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="whisper.cpp returned an unreadable result") from exc
    return text


@app.post("/v1/transcriptions", response_model=TranscriptionResponse)
async def transcribe(audio: Annotated[UploadFile, File()]) -> TranscriptionResponse:
    if not WHISPER_MODEL.is_file():
        raise HTTPException(status_code=503, detail="Whisper model is not configured")

    with tempfile.TemporaryDirectory(prefix="stt-") as temp_dir:
        root = Path(temp_dir)
        audio_path = root / "input.wav"
        output_base = root / "transcription"
        size = 0
        try:
            with audio_path.open("wb") as destination:
                while chunk := await audio.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_AUDIO_BYTES:
                        raise HTTPException(status_code=413, detail="Audio file is too large")
                    destination.write(chunk)
        finally:
            await audio.close()

        _validate_wav(audio_path)
        text = await asyncio.to_thread(_run_whisper, audio_path, output_base)
        return TranscriptionResponse(text=text)
