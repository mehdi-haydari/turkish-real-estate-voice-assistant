import type { SpeechEvent } from "../types/SpeechEvents";

const LISTEN_PATH = "/api/stt/v1/listen";

export class SttGateway {
  private socket: WebSocket | null = null;

  async connect(
    onEvent: (event: SpeechEvent) => void,
    onClose: () => void,
  ): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(this.buildListenUrl());
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => {
        socket.close();
        if (this.socket === socket) this.socket = null;
        reject(new Error("STT bağlantısı kurulamadı."));
      }, { once: true });
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      onClose();
    });
    socket.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(String(message.data)) as SpeechEvent;
        onEvent(event.type === "error" ? { ...event, message: this.toEnglishError(event.message) } : event);
      } catch {
        onEvent({ type: "error", message: "STT servisinden beklenmeyen yanıt alındı." });
      }
    });
  }

  sendAudioFrame(frame: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame);
  }

  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send("stop");
  }

  private toEnglishError(message: string): string {
    const knownErrors: Record<string, string> = {
      "Silero VAD başlatılamadı.": "Could not start Silero VAD.",
      "Ses paketi hatalı; dinleme durduruldu.": "Invalid audio frame. Listening stopped.",
      "Konuşma yazıya çevrilemedi; tekrar deneyin.": "Could not transcribe speech. Please try again.",
      "Konuşma bölümü çok uzun; dinlemeye devam ediyorum.": "The speech segment was too long. Listening will continue.",
    };
    return knownErrors[message] || "The STT service reported an error. Check its logs for details.";
  }

  private buildListenUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${LISTEN_PATH}`;
  }
}
