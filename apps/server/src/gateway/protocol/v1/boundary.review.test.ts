import { describe, expect, test } from "bun:test";
import {
  parsePublicError,
  parsePublicRequest,
  parsePublicResponse,
  renderPublicError,
} from ".";

describe("Gateway V1 hostile public boundaries", () => {
  test("rejects malformed nested public request and response shapes without throwing", () => {
    const malformed = [
      parsePublicRequest("responses", { model: "m", input: [42, true, null] }),
      parsePublicRequest("chat-completions", {
        model: "m",
        messages: [{ role: "admin", content: "no" }],
      }),
      parsePublicRequest("messages", {
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "text", text: "ok", private_api_key: "secret" }] }],
      }),
      parsePublicResponse("chat-completions", {
        id: "chatcmpl_bad",
        model: "m",
        choices: [{}],
      }),
    ];

    for (const result of malformed) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("pointer_invalid_request");
        expect(result.error.message).toBe("Invalid gateway payload.");
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
    expect(JSON.stringify(malformed)).not.toContain("private_api_key");
  });

  test("sanitizes attacker-controlled extension paths and discriminator content", () => {
    const secretKey = `sk_${"credential".repeat(80)}`;
    const secretValue = `bearer_${"private".repeat(160)}`;
    const result = parsePublicRequest("chat-completions", {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      [secretKey]: secretValue,
    });

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(secretValue);
    if (!result.ok) {
      expect(result.error.code).toBe("pointer_feature_unsupported");
      expect(result.error.issues[0]?.path).toMatch(/^field_[a-z0-9]+$/);
      expect(result.error.findings[0]?.assessment.bestEffortAllowed).toBe(false);
    }
  });

  test("never exposes raw upstream bodies or credential headers", () => {
    const secret = "sk_upstream_body_must_never_escape";
    const parsed = parsePublicError("responses", {
      status: 429,
      headers: {
        authorization: `Bearer ${secret}`,
        "x-private-debug": secret,
        "retry-after": "2",
      },
      body: {
        error: {
          type: secret,
          code: secret,
          message: secret,
          param: secret,
        },
      },
    }, {
      requestId: "ptrreq_hostile_error_01",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.code).toBe("pointer_upstream_rate_limit");
    expect(parsed.value.message).toBe("Upstream HTTP request failed");
    expect(parsed.value.retryAfterMs).toBe(2000);
    const rendered = renderPublicError("responses", parsed.value);
    expect(JSON.stringify({ parsed, rendered })).not.toContain(secret);
  });

  test("does not silently discard unknown reasoning controls or usage dimensions", () => {
    const controls = [
      parsePublicRequest("messages", {
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "enabled", budget_tokens: 8, private_control: true },
      }),
      parsePublicRequest("responses", {
        model: "m",
        input: "hello",
        reasoning: { effort: "medium", private_control: true },
      }),
    ];
    for (const result of controls) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("pointer_feature_unsupported");
    }

    const providerResponse = {
      id: "chatcmpl_usage_unknown",
      model: "m",
      choices: [{ message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        private_usage_dimension: 99,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      },
    };
    const usage = parsePublicResponse("chat-completions", providerResponse, "best-effort");
    expect(usage.ok).toBe(true);
    if (usage.ok) {
      expect(usage.findings.map((entry) => entry.detailCode)).toEqual([
        "pointer_chat_usage_detail_dropped",
        "pointer_chat_usage_detail_dropped",
      ]);
      expect(usage.value.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: 0 });
    }
    const strictUsage = parsePublicResponse("chat-completions", providerResponse, "strict");
    expect(strictUsage.ok).toBe(false);
    if (!strictUsage.ok) expect(strictUsage.error.code).toBe("pointer_feature_lossy");
    expect(JSON.stringify({ usage, strictUsage })).not.toContain("private_usage_dimension");

    const refusal = parsePublicResponse("chat-completions", {
      id: "chatcmpl_refusal",
      model: "m",
      choices: [{ message: { role: "assistant", content: null, refusal: "Cannot comply." }, finish_reason: "content_filter" }],
    });
    expect(refusal.ok).toBe(true);
    if (refusal.ok) expect(refusal.value.output).toEqual([{ type: "refusal", text: "Cannot comply." }]);
  });
});
