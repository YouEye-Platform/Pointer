import { expect, test } from "bun:test";
import { normalizeEngineInput } from "./engine-request";

test("Responses string shorthand becomes one user text message, including empty strings", () => {
  for (const text of ["hello", ""]) {
    const body: Record<string, unknown> = { input: text };
    normalizeEngineInput("/responses", body);
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text }] }]);
  }
});
test("native message and tool arrays, compact input and other protocols remain intact", () => {
  const input = [{ type: "function_call_output", call_id: "fixture", output: "ok" }];
  const body = { input };
  normalizeEngineInput("/responses", body);
  expect(body.input).toBe(input);
  for (const path of ["/responses/compact", "/messages", "/chat/completions"]) {
    const body = { input: "fixture" };
    normalizeEngineInput(path, body);
    expect(body.input).toBe("fixture");
  }
});
