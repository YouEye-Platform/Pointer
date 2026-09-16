import { describe, expect, test } from "bun:test";
import { buildUsageValues, type UsageOutcome } from "./usage-telemetry";

const formats = ["chat-completions", "messages", "responses", "google-generate-content"] as const;

describe("sixteen-path proxy telemetry matrix", () => {
  for (const client of formats) for (const native of formats) for (const stream of [false, true]) {
    test(`${client} -> ${native} (${stream ? "stream" : "non-stream"}) writes one attributed row`, () => {
      const row = buildUsageValues(
        { apiKeyId: "key_1", userId: "user_1", instanceId: "inst_1", modelId: `model/${client}`, catalogEntityId: `entity/${client}`, providerId: `provider-${native}` },
        { inputPrice: 2, outputPrice: 6, source: "provider_models" },
        native === "messages" ? "anthropic-compatible" : "openai-compatible",
        120, 30, 200, stream ? 900 : 1200, stream ? 180 : null, "proxy",
        { cachedTokens: native === "chat-completions" ? 20 : undefined, reasoningTokens: native === "responses" ? 5 : undefined, cacheCreationTokens: native === "messages" ? 10 : undefined, cacheReadTokens: native === "messages" ? 15 : undefined, completionTimeMs: 300 },
      );
      expect(row).toMatchObject({ apiKeyId: "key_1", userId: "user_1", instanceId: "inst_1", modelId: `model/${client}`, catalogEntityId: `entity/${client}`, providerId: `provider-${native}`, inputTokens: 120, outputTokens: 30, outcome: "success", source: "proxy", generationMs: 300 });
      expect(Number(row.tokensPerSecond)).toBeCloseTo(100, 5);
      expect(row.costStatus).toBe("known");
      if (stream) expect(row.ttfbMs).toBe(180); else expect(row.ttfbMs).toBeNull();
    });
  }
});

describe("telemetry outcomes remain queryable", () => {
  const outcomes: UsageOutcome[] = ["success", "upstream_error", "translation_error", "timeout", "client_abort", "incomplete_stream"];
  for (const outcome of outcomes) test(outcome, () => {
    const row = buildUsageValues(
      { userId: "user_1", instanceId: "inst_1", modelId: "model_1", providerId: "provider_1" },
      { inputPrice: null, outputPrice: null, source: null }, "openai-compatible", 3, 2,
      outcome === "success" ? 200 : outcome === "client_abort" ? 499 : 502, 50, 10, "test",
      { outcome, errorType: outcome === "success" ? undefined : outcome, errorMessage: outcome },
    );
    expect(row.outcome).toBe(outcome);
    expect(row.source).toBe("test");
    expect(row.apiKeyId).toBeNull();
    expect(row.costStatus).toBe("unknown");
  });
});
