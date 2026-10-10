import type { PublicStreamEvent } from "./protocol/v1/stream";

/** Decode one SSE frame at a time, including multiline data and an EOF tail. */
export class SseEventDecoder {
  private event: string | undefined;
  private data: string[] = [];

  push(line: string): PublicStreamEvent | undefined {
    if (line === "") return this.finish();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
    return undefined;
  }

  finish(): PublicStreamEvent | undefined {
    const event = this.event;
    const text = this.data.join("\n");
    const hasData = this.data.length > 0;
    this.event = undefined;
    this.data = [];
    if (!hasData) return undefined;
    if (text === "[DONE]") return { event, data: text };
    try {
      return { event, data: JSON.parse(text) };
    } catch {
      return { event, data: null };
    }
  }
}
