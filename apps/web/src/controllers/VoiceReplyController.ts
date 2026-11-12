import { TtsGateway } from "../services/TtsGateway";

export interface VoiceReplyState {
  turnId: number;
  status: "generating" | "playing" | "done" | "cancelled" | "error";
  synthesisMs: number | null;
  audioDurationMs: number | null;
  playbackStartedAt: number | null;
  error: string | null;
}

type FinishReason = "done" | "error" | "interrupted" | "stopped";
interface VoiceTask {
  turnId: number;
  text: string;
  abort: AbortController;
  cancelReason?: "interrupted" | "stopped";
}
interface VoiceReplyObserver {
  onState(state: VoiceReplyState): void;
  onFinished(turnId: number, reason: FinishReason): void;
}

export class VoiceReplyController {
  private readonly gateway = new TtsGateway();
  private readonly seen = new Set<number>();
  private readonly queue: VoiceTask[] = [];
  private context: AudioContext | null = null;
  private current: VoiceTask | null = null;
  private source: AudioBufferSourceNode | null = null;

  constructor(private readonly observer: VoiceReplyObserver) {}

  async enable(): Promise<void> {
    if (!this.context || this.context.state === "closed") this.context = new AudioContext();
    await this.context.resume();
  }

  enqueue(turnId: number, text: string): void {
    if (this.seen.has(turnId)) return;
    this.seen.add(turnId);
    this.queue.push({ turnId, text, abort: new AbortController() });
    void this.playNext();
  }

  cancel(reason: "interrupted" | "stopped" = "stopped"): void {
    for (const task of this.queue.splice(0)) {
      this.observer.onState({ turnId: task.turnId, status: "cancelled", synthesisMs: null, audioDurationMs: null, playbackStartedAt: null, error: null });
      this.observer.onFinished(task.turnId, reason);
    }
    if (!this.current) return;
    this.current.cancelReason = reason;
    this.current.abort.abort();
    this.source?.stop();
  }

  dispose(): void {
    this.cancel();
    if (this.context) void this.context.close();
    this.context = null;
  }

  private async playNext(): Promise<void> {
    if (this.current) return;
    const task = this.queue.shift();
    if (!task) return;
    this.current = task;
    const state: VoiceReplyState = { turnId: task.turnId, status: "generating", synthesisMs: null, audioDurationMs: null, playbackStartedAt: null, error: null };
    const startedAt = performance.now();
    let reason: FinishReason = "done";
    this.observer.onState({ ...state });
    try {
      if (!this.context || this.context.state !== "running") throw new Error("Audio is not enabled. Stop and start listening again to enable voice replies.");
      const waves = await this.gateway.synthesize(task.text, task.abort.signal);
      state.synthesisMs = performance.now() - startedAt;
      const segments: AudioBuffer[] = [];
      for (const wav of waves) {
        if (task.abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        segments.push(await this.context.decodeAudioData(wav));
      }
      const audio = this.context.createBuffer(1, segments.reduce((sum, segment) => sum + segment.length, 0), this.context.sampleRate);
      let offset = 0;
      for (const segment of segments) {
        audio.copyToChannel(segment.getChannelData(0), 0, offset);
        offset += segment.length;
      }
      if (task.abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const source = this.context.createBufferSource();
      this.source = source;
      source.buffer = audio;
      source.connect(this.context.destination);
      state.audioDurationMs = audio.duration * 1000;
      state.playbackStartedAt = Date.now();
      state.status = "playing";
      this.observer.onState({ ...state });
      await new Promise<void>((resolve) => {
        source.onended = () => { source.disconnect(); resolve(); };
        source.start();
      });
      state.status = task.abort.signal.aborted ? "cancelled" : "done";
    } catch (error) {
      if (task.abort.signal.aborted) {
        state.status = "cancelled";
      } else {
        state.status = "error";
        state.error = error instanceof Error ? error.message : "Voice playback failed.";
        reason = "error";
      }
    } finally {
      if (task.abort.signal.aborted) reason = task.cancelReason ?? "stopped";
      this.observer.onState({ ...state });
      this.current = null;
      this.source = null;
      this.observer.onFinished(task.turnId, reason);
      void this.playNext();
    }
  }
}
