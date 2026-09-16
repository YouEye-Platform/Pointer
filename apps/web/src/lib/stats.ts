export interface StatsResponse {
  days: number;
  sample: { requests: number; confidence: "low" | "medium" | "high" };
  totals: { requests: number; successful: number; errors: number; successRate: number | null; totalCost: number | null; knownCostSamples: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  latency: { samples: number; p50: number | null; p95: number | null; p99: number | null; avg: number | null };
  ttfb: { samples: number; p50: number | null; p95: number | null };
  throughput: { samples: number; avg: number | null; p50: number | null };
  daily: Array<{ date: string; requests: number; successful: number; cost: number | null; inputTokens: number; outputTokens: number; successRate: number | null }>;
  recent: Array<{ id: string; modelId: string; providerId: string; instanceId: string | null; apiKeyId: string | null; source: string; outcome: string; statusCode: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; latencyMs: number | null; ttfbMs: number | null; tokensPerSecond: number | null; createdAt: string }>;
}

export const metric = (value: number | null, suffix = "") => value == null ? "Unknown" : `${value.toFixed(value >= 100 ? 0 : 1)}${suffix}`;
