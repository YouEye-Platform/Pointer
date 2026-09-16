export class SseLineDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): string[] {
    return this.extract(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): string[] {
    const lines = this.extract(this.decoder.decode());
    if (!this.buffer) return lines;
    lines.push(this.normalize(this.buffer));
    this.buffer = "";
    return lines;
  }

  private extract(decoded: string): string[] {
    this.buffer += decoded;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((line) => this.normalize(line));
  }

  private normalize(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}
