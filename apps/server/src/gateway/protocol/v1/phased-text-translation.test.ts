import { expect, test } from "bun:test";
import { createGatewayProxyStreamSelector, selectGatewayProxyResponse } from "./runtime-proxy";

const items = ["commentary", "final_answer"].map((phase, index) => ({
  type: "message", id: `msg_${index}`, role: "assistant", phase, status: "completed",
  content: [{ type: "output_text", text: index ? "Done." : "Working.", annotations: [] }],
}));
for (const targetFormat of ["messages", "chat-completions", "google-generate-content"] as const) {
  test(`phased provider text translates to ${targetFormat} without rejecting visible output`, () => {
    const payload = { id: "resp", object: "response", model: "provider", status: "completed", output: items, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } };
    const selected = selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat, model: "public", payload });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(JSON.stringify(selected.response)).toContain("Working.");
      expect(JSON.stringify(selected.response)).toContain("Done.");
    }
    const selector = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat, model: "public", requestId: "phase-cross" });
    const lines: string[] = [];
    const send = (data: any) => lines.push(...selector.push({ event: data.type, data }).lines);
    send({ type: "response.created", response: { id: "resp", model: "provider" } });
    for (const [index, item] of items.entries()) {
      send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } });
      send({ type: "response.content_part.added", output_index: index, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", output_index: index, item_id: item.id, content_index: 0, delta: item.content[0]!.text });
      send({ type: "response.output_text.done", output_index: index, item_id: item.id, content_index: 0, text: item.content[0]!.text });
      send({ type: "response.content_part.done", output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
      send({ type: "response.output_item.done", output_index: index, item });
    }
    send({ type: "response.completed", response: payload });
    expect(selector.failed()).toBe(false);
    expect(selector.ended()).toBe(true);
    expect(selector.usage()?.inputTokens).toBe(12);
    expect(lines.join("")).toContain("Working.");
    expect(lines.join("")).toContain("Done.");
    expect(selector.finish().lines).toEqual([]);
    expect(items.map(item => item.phase)).toEqual(["commentary", "final_answer"]);
  });
}

test("phased messages with unsupported content remain rejected across APIs", () => {
  const item = { ...items[0], content: [{ type: "unknown_private_block", value: "must not be projected" }] };
  expect(selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat: "messages", model: "public", payload: { id: "resp", model: "provider", status: "completed", output: [item] } }).ok).toBe(false);
  const selector = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "messages", model: "public", requestId: "unsupported" });
  const output = selector.push({ data: { type: "response.output_item.added", output_index: 0, item } });
  expect(selector.failed()).toBe(true);
  expect(output.lines.join("")).not.toContain("must not be projected");
});
