export type UsageOutcome =
  | "success"
  | "upstream_error"
  | "translation_error"
  | "timeout"
  | "client_abort"
  | "incomplete_stream";

export interface ExtendedMetrics {
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  queueTimeMs?: number;
  promptTimeMs?: number;
  completionTimeMs?: number;
  observedGenerationMs?: number;
  processingMs?: number;
  errorType?: string;
  errorMessage?: string;
  outcome?: UsageOutcome;
}

export interface PriceSnapshot {
  inputPrice: number | null;
  outputPrice: number | null;
  source: string | null;
}

export interface CostResult {
  costUsd: number | null;
  status: "known" | "unknown";
}

export const finitePrice = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function sanitizeErrorMessage(value?: string): string {
  return (value || "")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|ptr_)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

export function classifyUsageError(statusCode: number, errorText?: string) {
  let errorType: string;
  if (statusCode === 429) errorType = "rate_limit";
  else if (statusCode === 401 || statusCode === 403) errorType = "auth";
  else if (statusCode === 408 || statusCode === 504) errorType = "timeout";
  else if (statusCode >= 500) errorType = "server";
  else if (statusCode >= 400) errorType = "client";
  else errorType = "unknown";
  return { errorType, errorMessage: sanitizeErrorMessage(errorText) };
}

export function calculateUsageCost(
  pricing: PriceSnapshot,
  inputTokens: number,
  outputTokens: number,
  providerType: string,
  metrics?: ExtendedMetrics
): CostResult {
  const inputPrice = finitePrice(pricing.inputPrice);
  const outputPrice = finitePrice(pricing.outputPrice);
  if ((inputTokens > 0 && inputPrice === null) || (outputTokens > 0 && outputPrice === null)) {
    return { costUsd: null, status: "unknown" };
  }

  const cacheCreation = metrics?.cacheCreationTokens || 0;
  const cacheRead = metrics?.cacheReadTokens || 0;
  const cachedOpenAI = metrics?.cachedTokens || 0;
  let inputCost = 0;

  if (inputPrice !== null && providerType === "anthropic-compatible" && (cacheCreation > 0 || cacheRead > 0)) {
    const regularInput = Math.max(0, inputTokens - cacheCreation - cacheRead);
    inputCost = (regularInput / 1_000_000) * inputPrice
      + (cacheCreation / 1_000_000) * inputPrice * 1.25
      + (cacheRead / 1_000_000) * inputPrice * 0.1;
  } else if (inputPrice !== null && cachedOpenAI > 0) {
    const regularInput = Math.max(0, inputTokens - cachedOpenAI);
    inputCost = (regularInput / 1_000_000) * inputPrice
      + (cachedOpenAI / 1_000_000) * inputPrice * 0.5;
  } else if (inputPrice !== null) {
    inputCost = (inputTokens / 1_000_000) * inputPrice;
  }

  const outputCost = outputPrice === null ? 0 : (outputTokens / 1_000_000) * outputPrice;
  return { costUsd: inputCost + outputCost, status: "known" };
}

export function calculateThroughput(outputTokens: number, metrics?: ExtendedMetrics) {
  const generationMs = metrics?.completionTimeMs && metrics.completionTimeMs > 0
    ? metrics.completionTimeMs
    : metrics?.observedGenerationMs && metrics.observedGenerationMs > 0
      ? metrics.observedGenerationMs
      : null;
  const tokensPerSecond = generationMs && outputTokens > 0 ? outputTokens / (generationMs / 1000) : null;
  return { generationMs, tokensPerSecond };
}
