import { describe, expect, test } from "bun:test";
import { SseLineDecoder } from "./sse-line-decoder";

describe("SseLineDecoder", () => {
  test("decodes CRLF, LF, Unicode, blank lines, and an unterminated final line byte by byte", () => {
    const input = "data: {\"delta\":\"héllo 🌍\"}\r\n\r\nevent: done\ndata: [DONE]";
    const bytes = new TextEncoder().encode(input);
    const decoder = new SseLineDecoder();
    const lines: string[] = [];

    for (const byte of bytes) lines.push(...decoder.push(Uint8Array.of(byte)));
    lines.push(...decoder.finish());

    expect(lines).toEqual([
      "data: {\"delta\":\"héllo 🌍\"}",
      "",
      "event: done",
      "data: [DONE]",
    ]);
  });

  test("does not invent a line for an empty or fully terminated stream", () => {
    const empty = new SseLineDecoder();
    expect(empty.finish()).toEqual([]);

    const terminated = new SseLineDecoder();
    expect(terminated.push(new TextEncoder().encode("data: one\n"))).toEqual(["data: one"]);
    expect(terminated.finish()).toEqual([]);
  });
});
