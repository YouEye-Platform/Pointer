export function sourceTimeoutMs(fallback: number): number {
  const value = Number(process.env.SOURCE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function sourceTtlMs(): number {
  const value = Number(process.env.SOURCE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 6 * 60 * 60 * 1000;
}

export function sourceRefreshIntervalMs(): number {
  const value = Number(process.env.SOURCE_REFRESH_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? value : 6 * 60 * 60 * 1000;
}
