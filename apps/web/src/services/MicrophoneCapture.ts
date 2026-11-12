export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.context = new AudioContext({ sampleRate: 16_000 });
    await this.context.resume();

    if (this.context.sampleRate !== 16_000) {
      this.close();
      throw new Error("The browser could not open 16 kHz audio.");
    }
  }

  start(onFrame: (frame: ArrayBuffer) => void): void {
    if (!this.stream || !this.context) {
      throw new Error("The microphone is not ready yet.");
    }

    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(512, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      onFrame(this.toPcm16(event.inputBuffer.getChannelData(0)));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  close(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") void this.context.close();

    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.stream = null;
    this.context = null;
  }

  private toPcm16(samples: Float32Array): ArrayBuffer {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm.buffer;
  }
}
