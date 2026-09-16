import { describe, expect, test } from "bun:test";
import {
  calculateThroughput,
  calculateUsageCost,
  classifyUsageError,
  sanitizeErrorMessage,
} from "./usage-metrics";

describe("usage cost", () => {
  test("missing price remains unknown instead of becoming zero", () => {
    expect(calculateUsageCost(
      { inputPrice: null, outputPrice: null, source: null },
      1000,
      100,
      "openai-compatible"
    )).toEqual({ costUsd: null, status: "unknown" });
  });

  test("known prices produce reproducible cost", () => {
    const result = calculateUsageCost(
      { inputPrice: 2, outputPrice: 8, source: "provider_models" },
      1_000_000,
      500_000,
      "openai-compatible"
    );
    expect(result).toEqual({ costUsd: 6, status: "known" });
  });

  test("Anthropic cache pricing is applied to the input snapshot", () => {
    const result = calculateUsageCost(
      { inputPrice: 4, outputPrice: 10, source: "provider_models" },
      1000,
      0,
      "anthropic-compatible",
      { cacheCreationTokens: 200, cacheReadTokens: 300 }
    );
    expect(result.status).toBe("known");
    expect(result.costUsd).toBeCloseTo(0.00312, 8);
  });
});

describe("throughput", () => {
  test("trusted provider completion time wins", () => {
    expect(calculateThroughput(40, { completionTimeMs: 2000, observedGenerationMs: 4000 }))
      .toEqual({ generationMs: 2000, tokensPerSecond: 20 });
  });

  test("observed generation time is used when provider timing is absent", () => {
    expect(calculateThroughput(30, { observedGenerationMs: 1500 }))
      .toEqual({ generationMs: 1500, tokensPerSecond: 20 });
  });

  test("total request latency is never a throughput input", () => {
    expect(calculateThroughput(30)).toEqual({ generationMs: null, tokensPerSecond: null });
  });
});

describe("error privacy", () => {
  test("redacts bearer, Pointer, OpenAI, and JSON credential values", () => {
    const sanitized = sanitizeErrorMessage(
      'Bearer secret-token sk-abcdefghijk ptr_abcdefghijk {"access_token":"oauth-secret"}'
    );
    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("sk-abcdefghijk");
    expect(sanitized).not.toContain("ptr_abcdefghijk");
    expect(sanitized).not.toContain("oauth-secret");
  });

  test("classifies and truncates upstream errors", () => {
    const result = classifyUsageError(429, "x".repeat(700));
    expect(result.errorType).toBe("rate_limit");
    expect(result.errorMessage).toHaveLength(500);
  });
});
