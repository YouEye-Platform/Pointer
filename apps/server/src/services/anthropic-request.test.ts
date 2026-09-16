import { describe, expect, test } from "bun:test";
import { sanitizeAnthropicRequestBody } from "./anthropic-request";

describe("Anthropic request compatibility", () => {
  test("moves anthropic-version out of the JSON body without dropping beta request fields", () => {
    const contextManagement = {
      edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 10_000 } }],
    };
    const result = sanitizeAnthropicRequestBody({
      model: "opus",
      messages: [{ role: "user", content: "hello" }],
      "anthropic-version": "2023-06-01",
      context_management: contextManagement,
      output_config: { effort: "high" },
    });

    expect(result["anthropic-version"]).toBeUndefined();
    expect(result.context_management).toEqual(contextManagement);
    expect(result.output_config).toEqual({ effort: "high" });
  });
});
