export class TtsGateway {
  async synthesize(text: string, signal: AbortSignal): Promise<ArrayBuffer[]> {
    const chunks: string[] = [];
    let chunk = "";
    for (const word of text.split(/\s+/)) {
      if (chunk.length + word.length + 1 > 500) { chunks.push(chunk); chunk = ""; }
      chunk += (chunk ? " " : "") + word;
    }
    if (chunk) chunks.push(chunk);
    const audio: ArrayBuffer[] = [];
    for (const part of chunks) audio.push(await this.request(part, signal));
    return audio;
  }

  private async request(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch("/api/tts/v1/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!response.ok) {
      let detail = `Voice generation failed (${response.status}).`;
      try {
        const payload = await response.json();
        if (typeof payload.detail === "string") detail = payload.detail;
      } catch { /* A proxy error may not have a JSON body. */ }
      throw new Error(detail);
    }
    return response.arrayBuffer();
  }
}
