"""Local Turkish text-to-speech API backed by the official FreyaTTS package."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
import wave
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool


SERVICE_DIR = Path(__file__).resolve().parent
FREYA_SOURCE = Path(os.getenv("FREYA_SOURCE", str(SERVICE_DIR / "vendor" / "FreyaTTS")))
if FREYA_SOURCE.is_dir():
    sys.path.insert(0, str(FREYA_SOURCE))

MODEL_ID = os.getenv("FREYA_MODEL_ID", "freyavoice/freya-tts")
DEVICE = os.getenv("TTS_DEVICE", "cpu").strip().lower()
STEPS = int(os.getenv("TTS_STEPS", "32"))
VOICE_SEED = int(os.getenv("FREYA_VOICE_SEED", "9"))
SAMPLE_RATE = 48_000
MAX_TEXT_CHARS = 500

logger = logging.getLogger(__name__)
model = None
synthesis_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    if DEVICE not in {"cpu", "mps"}:
        raise RuntimeError("TTS_DEVICE must be either 'cpu' or 'mps'.")
    try:
        from freyatts import FreyaTTS

        local_dir = os.getenv("FREYA_MODEL_DIR")
        vae_path = os.getenv("FREYA_VAE_PATH")
        if local_dir and vae_path:
            from local_model import load_local_freya
            model = await run_in_threadpool(load_local_freya, local_dir, vae_path, DEVICE)
        else:
            model = await run_in_threadpool(FreyaTTS.from_pretrained, MODEL_ID, device=DEVICE)
        logger.info("FreyaTTS model loaded (device=%s)", DEVICE)
    except Exception as exc:
        logger.exception("Could not load FreyaTTS model")
        raise RuntimeError(f"FreyaTTS could not be loaded: {type(exc).__name__}") from exc
    yield
    model = None


app = FastAPI(title="Local Turkish TTS", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8766", "http://localhost:8766"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


@app.get("/health")
async def health() -> dict[str, str]:
    if model is None:
        raise HTTPException(status_code=503, detail="FreyaTTS is not loaded")
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE}


def _synthesize(text: str) -> bytes:
    if model is None:
        raise RuntimeError("FreyaTTS is not loaded")
    samples = np.asarray(model.synthesize(text, steps=STEPS, seed=VOICE_SEED), dtype=np.float32).reshape(-1)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise ValueError("FreyaTTS returned empty or invalid audio")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()


@app.post("/v1/synthesize")
async def synthesize(request: SynthesisRequest) -> Response:
    if model is None:
        raise HTTPException(status_code=503, detail="FreyaTTS is not loaded")
    if not request.text.strip():
        raise HTTPException(status_code=422, detail="Text must not be blank")
    try:
        async with synthesis_lock:
            audio_bytes = await run_in_threadpool(_synthesize, request.text.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="FreyaTTS returned invalid audio") from exc
    except Exception as exc:
        logger.exception("FreyaTTS synthesis failed")
        raise HTTPException(status_code=502, detail="FreyaTTS could not synthesize this reply") from exc
    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
