import { MicrophoneCapture } from "../services/MicrophoneCapture";
import { SttGateway } from "../services/SttGateway";
import type { SpeechEvent, SpeechStatus, TranscriptionTiming } from "../types/SpeechEvents";

export interface LiveSpeechObserver {
  onStatus(status: SpeechStatus, message: string): void;
  onTranscript(text: string, timing?: TranscriptionTiming): void;
}

export class LiveSpeechController {
  private readonly microphone = new MicrophoneCapture();
  private readonly stt = new SttGateway();
  private active = false;

  constructor(private readonly observer: LiveSpeechObserver) {}

  async start(): Promise<void> {
    if (this.active) return;

    this.observer.onStatus("requesting_microphone", "Requesting microphone access…");
    try {
      await this.microphone.open();
      this.observer.onStatus("connecting", "Connecting to the speech recognition service…");
      await this.stt.connect(
        (event) => this.handleSttEvent(event),
        () => this.handleSocketClose(),
      );
      this.microphone.start((frame) => this.stt.sendAudioFrame(frame));
      this.active = true;
      this.observer.onStatus("listening", "Listening…");
    } catch (error) {
      this.stop();
      const message = error instanceof Error ? error.message : "The microphone or STT service is unavailable.";
      this.observer.onStatus("error", message);
    }
  }

  stop(): void {
    if (!this.active) {
      this.stt.stop();
      this.microphone.close();
      return;
    }

    this.observer.onStatus("stopping", "Stopping listening…");
    this.stt.stop();
    this.microphone.close();
    this.active = false;
    this.observer.onStatus("stopped", "Listening stopped.");
  }

  dispose(): void {
    this.stt.stop();
    this.microphone.close();
    this.active = false;
  }

  private handleSocketClose(): void {
    this.microphone.close();
    this.active = false;
    this.observer.onStatus("stopped", "The STT connection closed.");
  }

  private handleSttEvent(event: SpeechEvent): void {
    switch (event.type) {
      case "ready":
        return;
      case "speech_start":
        this.observer.onStatus("speech_detected", "Speech detected…");
        return;
      case "transcribing":
        this.observer.onStatus("transcribing", "Transcribing speech…");
        return;
      case "transcript":
        if (event.text.trim()) this.observer.onTranscript(event.text.trim(), event.timing);
        this.observer.onStatus(
          this.active ? "listening" : "stopped",
          this.active ? "Listening…" : "Listening stopped.",
        );
        return;
      case "discarded":
        this.observer.onStatus(
          this.active ? "listening" : "stopped",
          this.active ? "Short or unclear audio was ignored; listening…" : "Listening stopped.",
        );
        return;
      case "error":
        this.observer.onStatus("error", event.message);
    }
  }
}
