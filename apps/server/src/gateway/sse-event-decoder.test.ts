import { expect, test } from "bun:test";
import { SseEventDecoder } from "./sse-event-decoder";
import { SseLineDecoder } from "./sse-line-decoder";

for (const newline of ["\n", "\r\n"]) {
  test(`bytewise UTF-8 and multiline SSE data (${JSON.stringify(newline)})`, () => {
    const frames = new SseEventDecoder();
    const lines = new SseLineDecoder();
    const events = [];
    const bytes = new TextEncoder().encode([
      ": comment", "event: response.output_text.delta", 'data: {"type":"response.output_text.delta",',
      'data: "delta":"hello 🌍"}', "", "data:[DONE]", "",
    ].join(newline));
    for (const byte of bytes) for (const line of lines.push(new Uint8Array([byte]))) {
      const event = frames.push(line);
      if (event) events.push(event);
    }
    for (const line of lines.finish()) {
      const event = frames.push(line);
      if (event) events.push(event);
    }
    const tail = frames.finish();
    if (tail) events.push(tail);
    expect(events).toEqual([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "hello 🌍" } },
      { event: undefined, data: "[DONE]" },
    ]);
  });
}

test("malformed data remains an explicit adapter failure input", () => {
  const decoder = new SseEventDecoder();
  decoder.push("event: response.completed");
  decoder.push("data: invalid-json");
  expect(decoder.push("")).toEqual({event:"response.completed",data:null});
  expect(decoder.finish()).toBeUndefined();
});
