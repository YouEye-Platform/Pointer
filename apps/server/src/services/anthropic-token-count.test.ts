import { describe, expect, test } from "bun:test";
import { countAnthropicRequestTokens } from "./anthropic-token-count";

describe("Anthropic token count compatibility", () => {
  test("accepts the count_tokens request shape without max_tokens", () => {
    const result = countAnthropicRequestTokens({
      model: "google/gemini",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      context_management: { edits: [] },
      cache_control: { type: "ephemeral" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.response)).toEqual(["input_tokens"]);
      expect(result.response.input_tokens).toBeGreaterThan(0);
    }
  });

  test("counts tool schemas and multiple structured tool results", () => {
    const base = countAnthropicRequestTokens({
      model: "google/gemini",
      messages: [{ role: "user", content: "check both cities" }],
    });
    const toolLoop = countAnthropicRequestTokens({
      model: "google/gemini",
      tools: [{
        name: "weather",
        description: "Get weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      messages: [
        { role: "user", content: "check both cities" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_a", name: "weather", input: { city: "Paris" } },
            { type: "tool_use", id: "call_b", name: "weather", input: { city: "Rome" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "sunny" }] },
            { type: "tool_result", tool_use_id: "call_b", content: "failed", is_error: true },
          ],
        },
      ],
    });

    expect(base.ok).toBe(true);
    expect(toolLoop.ok).toBe(true);
    if (base.ok && toolLoop.ok) {
      expect(toolLoop.response.input_tokens).toBeGreaterThan(base.response.input_tokens);
    }
  });

  test("rejects malformed Messages input without exposing validation details", () => {
    expect(countAnthropicRequestTokens({
      model: "google/gemini",
      messages: [{ role: "assistant", content: [{ type: "tool_result", tool_use_id: "call_a" }] }],
    })).toEqual({ ok: false });
  });
});
