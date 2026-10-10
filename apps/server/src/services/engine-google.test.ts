import { expect, test } from "bun:test";
import { googleEngineResponse } from "./engine-google";

const completed = { id: "resp_fixture", model: "fixture", status: "completed", access_programs: [],
  output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text: "Hello", annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
const stream = (events: unknown[]) => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
const lifecycle = [
  { type: "response.created", response: { id: completed.id, model: "fixture", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { ...completed.output[0], content: [], status: "in_progress" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0, item: completed.output[0] },
  { type: "response.completed", response: completed },
];

test("Gemini accepts engine final-answer and entitlement metadata with text and usage intact", async () => {
  const response = await googleEngineResponse(Response.json(completed), "Public model", "request_fixture");
  const body = await response.json() as any;
  expect(body.candidates[0].content.parts[0].text).toBe("Hello");
  expect(body.candidates[0].finishReason).toBe("STOP");
  expect(body.usageMetadata.totalTokenCount).toBe(5);
  expect(JSON.stringify(body)).not.toContain("access_programs");
});

test("Codex quota/header events do not interfere with Gemini streaming completion", async () => {
  const response = await googleEngineResponse(stream([
    { type: "codex.rate_limits", rate_limits: [] }, { type: "codex.response.metadata", headers: {} }, ...lifecycle,
  ]), "Public model", "request_fixture");
  const body = await response.text();
  expect(body).toContain('"text":"Hello"');
  expect(body).toContain('"finishReason":"STOP"');
  expect(body).not.toContain('"error"');
  expect(body).not.toContain("codex.");
});

test("metadata alone cannot make an incomplete Gemini stream successful", async () => {
  const response = await googleEngineResponse(stream([{ type: "codex.rate_limits" }, ...lifecycle.slice(0, 3)]), "fixture", "fixture");
  const body = await response.text();
  expect(body).toContain('"error"');
  expect(body).not.toContain('"finishReason":"STOP"');
});

test("unknown protocol events remain rejected and real errors remain visible", async () => {
  const unknown = await googleEngineResponse(stream([{ type: "codex.unknown" }]), "fixture", "fixture");
  await expect(unknown.text()).rejects.toThrow("Invalid engine stream event");
  const failed = await googleEngineResponse(stream([{ type: "error", error: { code: "context_length_exceeded", message: "Fixture context too long" } }]), "fixture", "fixture");
  await expect(failed.text()).rejects.toThrow("Invalid engine stream event");
});
