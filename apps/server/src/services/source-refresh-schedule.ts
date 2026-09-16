const DEFAULT_RETRY_BASE_MS = 5 * 60 * 1000;

export function sourceRefreshDelayMs(
  normalIntervalMs: number,
  consecutiveFailures: number,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
): number {
  if (!Number.isFinite(normalIntervalMs) || normalIntervalMs <= 0) {
    throw new Error("normal source refresh interval must be positive");
  }
  if (consecutiveFailures <= 0) return normalIntervalMs;
  const exponent = Math.min(8, Math.max(0, Math.trunc(consecutiveFailures) - 1));
  return Math.min(normalIntervalMs, retryBaseMs * (2 ** exponent));
}

