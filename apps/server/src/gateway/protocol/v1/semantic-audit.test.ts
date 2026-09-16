import { describe, expect, test } from "bun:test";
import { parseChatResponse, renderChatRequest } from "./chat";
import { parseMessagesResponse, renderMessagesRequest } from "./messages";
import {
  irRequestSchema,
  type GatewayAdapterFailure,
  type GatewayAdapterResult,
  type IrRequest,
  type JsonObject,
} from "./schemas";

function request(overrides: Record<string, unknown> = {}): IrRequest {
  return irRequestSchema.parse({
    protocol: "pointer.gateway.ir",
    version: 1,
    kind: "request",
    sourceFormat: "responses",
    compatibilityPolicy: "best-effort",
    compatibility: [],
    extensions: [],
    model: "canonical-model",
    stream: false,
    instructions: [],
    turns: [],
    tools: [],
    sampling: { maxOutputTokens: 128 },
    ...overrides,
  });
}

function valueOf(result: GatewayAdapterResult<JsonObject>): JsonObject {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function failureOf(result: GatewayAdapterResult<JsonObject>): GatewayAdapterFailure {
  if (result.ok) throw new Error("Expected adapter failure");
  return result;
}

describe("Chat request semantic-loss audit", () => {
  test("reports unrepresentable instruction image references and extension blocks", () => {
    const input = request({
      instructions: [
        { type: "image", source: { type: "file", fileId: "file_instruction" } },
        {
          type: "extension",
          extension: {
            namespace: "responses",
            key: "prompt",
            value: { id: "prompt_fixture" },
          },
        },
      ],
    });

    expect(failureOf(renderChatRequest(input, "strict")).error.code).toBe("pointer_feature_lossy");
    const bestEffort = renderChatRequest(input, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (!bestEffort.ok) return;
    expect(bestEffort.findings.map((finding) => finding.detailCode)).toEqual([
      "pointer_chat_response_block_dropped",
      "pointer_cross_format_extension_dropped",
    ]);
    expect(bestEffort.value.messages).toEqual([]);
  });

  test("preserves mixed text/tool-result/text order while reporting the split", () => {
    const input = request({
      turns: [{
        role: "user",
        blocks: [
          { type: "text", text: "before" },
          { type: "tool_result", callId: "call_fixture", output: { ok: true }, isError: false },
          { type: "text", text: "after" },
        ],
      }],
    });

    expect(failureOf(renderChatRequest(input, "strict")).error.code).toBe("pointer_feature_lossy");
    const bestEffort = renderChatRequest(input, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (!bestEffort.ok) return;
    expect(bestEffort.value.messages).toEqual([
      { role: "user", content: "before" },
      { role: "tool", tool_call_id: "call_fixture", content: "{\"ok\":true}" },
      { role: "user", content: "after" },
    ]);
    expect(bestEffort.findings.map((finding) => finding.detailCode)).toContain(
      "pointer_chat_tool_result_split",
    );
  });

  test("reports reasoning budget and summary controls instead of dropping them silently", () => {
    const input = request({
      reasoning: {
        enabled: true,
        effort: "high",
        budgetTokens: 1024,
        summary: "concise",
      },
    });

    expect(failureOf(renderChatRequest(input, "strict")).error.code).toBe("pointer_feature_lossy");
    const bestEffort = renderChatRequest(input, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (!bestEffort.ok) return;
    expect(bestEffort.value.reasoning_effort).toBe("high");
    expect(bestEffort.findings.map((finding) => finding.assessment.path)).toEqual([
      "reasoning.budgetTokens",
      "reasoning.summary",
    ]);
  });
});

describe("Messages request semantic-loss audit", () => {
  test("rejects a mid-conversation instruction instead of reordering it", () => {
    const input = request({
      turns: [
        { role: "user", blocks: [{ type: "text", text: "first" }] },
        { role: "system", blocks: [{ type: "text", text: "late instruction" }] },
        { role: "user", blocks: [{ type: "text", text: "second" }] },
      ],
    });

    for (const mode of ["strict", "best-effort"] as const) {
      const failure = failureOf(renderMessagesRequest(input, mode));
      expect(failure.error.code).toBe("pointer_feature_unsupported");
      expect(failure.error.findings.map((finding) => finding.detailCode)).toContain(
        "pointer_messages_instruction_hoisted",
      );
    }
  });

  test("still hoists leading instructions without changing conversation order", () => {
    const input = request({
      turns: [
        { role: "developer", blocks: [{ type: "text", text: "leading instruction" }] },
        { role: "user", blocks: [{ type: "text", text: "hello" }] },
      ],
    });
    const rendered = valueOf(renderMessagesRequest(input, "strict"));
    expect(rendered.system).toEqual([{ type: "text", text: "leading instruction" }]);
    expect(rendered.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("rejects effort and summary controls without an exact Messages mapping", () => {
    const input = request({
      reasoning: {
        enabled: true,
        effort: "high",
        budgetTokens: 1024,
        summary: "detailed",
      },
    });

    for (const mode of ["strict", "best-effort"] as const) {
      const failure = failureOf(renderMessagesRequest(input, mode));
      expect(failure.error.code).toBe("pointer_feature_unsupported");
      expect(failure.error.findings.map((finding) => finding.assessment.path)).toEqual([
        "reasoning.effort",
        "reasoning.summary",
      ]);
    }
  });

  test("encodes parallelToolCalls false even when tool choice is omitted", () => {
    const rendered = valueOf(renderMessagesRequest(request({
      parallelToolCalls: false,
      tools: [{ type: "function", name: "lookup_fixture", parameters: {} }],
    })));
    expect(rendered.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  test("rejects invalid tool names instead of creating collisions or lossy aliases", () => {
    const input = request({
      tools: [
        { type: "function", name: "lookup.value", parameters: {} },
        { type: "function", name: "lookup_value", parameters: {} },
      ],
      toolChoice: { type: "function", name: "lookup.value" },
    });

    for (const mode of ["strict", "best-effort"] as const) {
      const failure = failureOf(renderMessagesRequest(input, mode));
      expect(failure.error.code).toBe("pointer_feature_unsupported");
      expect(failure.error.findings.every((finding) =>
        finding.detailCode === "pointer_messages_tool_name_sanitized"
      )).toBe(true);
    }
  });

  test("rejects unsigned reasoning instead of fabricating an empty signature", () => {
    const unsigned = request({
      turns: [{ role: "assistant", blocks: [{ type: "reasoning", text: "private reasoning" }] }],
    });
    for (const mode of ["strict", "best-effort"] as const) {
      const failure = failureOf(renderMessagesRequest(unsigned, mode));
      expect(failure.error.code).toBe("pointer_feature_unsupported");
      expect(failure.error.findings.map((finding) => finding.detailCode)).toContain(
        "pointer_messages_reasoning_signature_missing",
      );
    }

    const signed = valueOf(renderMessagesRequest(request({
      turns: [{
        role: "assistant",
        blocks: [{ type: "reasoning", text: "private reasoning", signature: "signature_fixture" }],
      }],
    })));
    expect(signed.messages).toEqual([{
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning", signature: "signature_fixture" }],
    }]);
  });
});

describe("terminal response statuses", () => {
  test("maps Chat error and cancellation finish reasons to terminal IR statuses", () => {
    for (const [finishReason, expectedStatus] of [
      ["error", "failed"],
      ["cancelled", "cancelled"],
    ] as const) {
      const parsed = parseChatResponse({
        id: `chat_${finishReason}`,
        model: "provider-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: finishReason,
        }],
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.status).toBe(expectedStatus);
    }
  });

  test("maps Messages error and cancellation stop reasons to terminal IR statuses", () => {
    for (const [stopReason, expectedStatus] of [
      ["error", "failed"],
      ["cancelled", "cancelled"],
    ] as const) {
      const parsed = parseMessagesResponse({
        id: `message_${stopReason}`,
        type: "message",
        role: "assistant",
        model: "provider-model",
        content: [],
        stop_reason: stopReason,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.status).toBe(expectedStatus);
    }
  });
});
