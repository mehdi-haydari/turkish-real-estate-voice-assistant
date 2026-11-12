export interface TranscriptionTiming {
  endpointing_ms: number | null;
  transcription_ms: number;
  total_ms: number | null;
}

export type SpeechEvent =
  | { type: "ready" }
  | { type: "speech_start" }
  | { type: "transcribing" }
  | { type: "transcript"; text: string; timing?: TranscriptionTiming }
  | { type: "discarded" }
  | { type: "error"; message: string };

export type SpeechStatus =
  | "idle"
  | "requesting_microphone"
  | "connecting"
  | "listening"
  | "speech_detected"
  | "transcribing"
  | "stopping"
  | "stopped"
  | "error";
