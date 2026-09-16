import { describe, expect, test } from "bun:test";
import {
  parsePublicError,
  parsePublicRequest,
  renderPublicRequest,
  renderPublicResponse,
  type IrRequest,
  type IrResponse,
} from ".";
import {
  finishReasonForFormat,
  normalizeFinishReason,
  responseStatusForFinishReason,
} from "./normalize";

function requestWith(overrides: Partial<IrRequest> = {}): IrRequest {
  return {
    protocol: "pointer.gateway.ir",
    version: 1,
    kind: "request",
    sourceFormat: "chat-completions",
    compatibilityPolicy: "strict",
    compatibility: [],
    extensions: [],
    model: "model",
    stream: false,
    instructions: [],
    turns: [],
    tools: [],
    sampling: {},
    ...overrides,
  };
}

function responseWith(overrides: Partial<IrResponse> = {}): IrResponse {
  return {
    protocol: "pointer.gateway.ir",
    version: 1,
    kind: "response",
    sourceFormat: "messages",
    compatibilityPolicy: "strict",
    compatibility: [],
    extensions: [],
    id: "resp_contract_boundary",
    model: "model",
    status: "completed",
    output: [{ type: "text", text: "ok" }],
    finishReason: "stop",
    ...overrides,
  };
}

describe("Gateway V1 public contract remediation", () => {
  test("unbounded Retry-After values cannot escape trusted diagnostic limits", () => {
    const result = parsePublicError("responses", {
      status: 429,
      headers: { "retry-after": "1e308" },
      body: {},
    }, { requestId: "ptrreq_retry_boundary_01" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retryAfterMs).toBeUndefined();
    expect(result.value.diagnostics?.retryAfterMs).toBeNull();
  });

  test("role-incompatible Chat and Messages request fields are rejected", () => {
    const invalid = [
      parsePublicRequest("chat-completions", {
        model: "model",
        messages: [{
          role: "user",
          content: "hello",
          tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{}" } }],
        }],
      }),
      parsePublicRequest("chat-completions", {
        model: "model",
        messages: [{ role: "tool", content: "result" }],
      }),
      parsePublicRequest("messages", {
        model: "model",
        max_tokens: 16,
        messages: [{
          role: "user",
          content: [{ type: "thinking", thinking: "not valid on a user turn", signature: "sig" }],
        }],
      }),
      parsePublicRequest("messages", {
        model: "model",
        max_tokens: 16,
        messages: [{
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }],
        }],
      }),
    ];

    for (const result of invalid) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("pointer_invalid_request");
    }
  });

  test("tool choice objects are strict and format-specific", () => {
    const invalid = [
      parsePublicRequest("chat-completions", {
        model: "model",
        messages: [],
        tool_choice: { type: "auto", vendor_flag: true },
      }),
      parsePublicRequest("messages", {
        model: "model",
        max_tokens: 16,
        messages: [],
        tool_choice: { type: "auto", disable_parallel_tool_use: true, vendor_flag: true },
      }),
      parsePublicRequest("responses", {
        model: "model",
        input: "hello",
        tool_choice: { type: "function", name: "lookup", vendor_flag: true },
      }),
    ];
    expect(invalid.every((result) => !result.ok && result.error.code === "pointer_invalid_request")).toBe(true);

    expect(parsePublicRequest("chat-completions", {
      model: "model",
      messages: [],
      tool_choice: { type: "function", function: { name: "lookup" } },
    }).ok).toBe(true);
    expect(parsePublicRequest("messages", {
      model: "model",
      max_tokens: 16,
      messages: [],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    }).ok).toBe(true);
    expect(parsePublicRequest("responses", {
      model: "model",
      input: "hello",
      tool_choice: { type: "function", name: "lookup" },
    }).ok).toBe(true);
  });

  test("known terminal reasons normalize and render without collapsing to null", () => {
    expect(normalizeFinishReason("messages", "refusal")).toEqual({
      finishReason: "content_filter",
      rawFinishReason: "refusal",
    });
    expect(normalizeFinishReason("messages", "pause_turn")).toEqual({
      finishReason: "stop",
      rawFinishReason: "pause_turn",
    });
    expect(finishReasonForFormat("chat-completions", "content_filter", "refusal")).toBe("content_filter");
    expect(finishReasonForFormat("messages", "content_filter")).toBe("refusal");
    expect(responseStatusForFinishReason("error")).toBe("failed");
    expect(responseStatusForFinishReason("cancelled")).toBe("cancelled");
    expect(responseStatusForFinishReason("length")).toBe("incomplete");
  });

  test("P0.1 findings retain feature-specific identities", () => {
    const reasoning = parsePublicRequest("chat-completions", {
      model: "model",
      messages: [],
      reasoning_effort: "unbounded",
    });
    expect(reasoning.ok).toBe(false);
    if (!reasoning.ok) {
      expect(reasoning.error.findings[0]?.assessment.feature.id).toBe("reasoning-controls");
    }

    const caching = renderPublicResponse("chat-completions", responseWith({
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
        cacheCreationInputTokens: 1,
      },
    }), "strict");
    expect(caching.ok).toBe(false);
    if (!caching.ok) {
      const finding = caching.error.findings.find((entry) =>
        entry.detailCode === "pointer_chat_cache_creation_usage_dropped"
      );
      expect(finding?.assessment.feature.id).toBe("prompt-caching");
    }

    const defaultLimit = renderPublicRequest("messages", requestWith(), "strict");
    expect(defaultLimit.ok).toBe(false);
    if (!defaultLimit.ok) {
      const finding = defaultLimit.error.findings.find((entry) =>
        entry.detailCode === "pointer_messages_default_max_tokens"
      );
      expect(finding?.assessment.feature.id).toBe("stop-controls");
    }
  });
});
