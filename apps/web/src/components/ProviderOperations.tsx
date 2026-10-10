"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
type Stats = { provider: string; requests: number; attemptCount: number; inputTokens?: number;
  outputTokens?: number; throughputTokensPerSec?: number; throughputSamples?: number;
  cacheHitRate?: number | null; estimatedCostUsd?: number; priceCoverageRatio?: number;
  pricedRequests?: number; unpricedRequests?: number };
export function ProviderOperations({ name, disabled, onChanged }: { name: string; disabled: boolean; onChanged: () => Promise<void> }) {
  const [stats, setStats] = useState<Stats | null | undefined>(undefined); const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const path = `/api/connections/providers?name=${encodeURIComponent(name)}`;
  useEffect(() => { void api.get<{ providers: Stats[] }>("/api/connections/usage?range=7d").then(data => setStats(data.providers.find(row => row.provider === name) ?? null)).catch(reason => setError(reason.message)); }, [name]);
  async function perform(task: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Operation failed."); } finally { setBusy(false); } }
  return <section className="card"><h2>Provider status and performance</h2>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>{disabled ? "Provider paused" : "Provider enabled"}</p>
    <div className="connection-model-actions"><button disabled={busy} onClick={() => void perform(async () => {
      const result = await api.post<{ ok?: boolean; applicable?: boolean; latencyMs?: number; message?: string; error?: string; reason?: string }>(`/api/connections/providers/test?name=${encodeURIComponent(name)}`, {});
      setNotice(result.applicable === false ? `No connectivity probe: ${result.reason || "not supported"}.` : result.ok ? result.message || `Catalog connection succeeded in ${result.latencyMs ?? "unknown"} ms. Inference must be tested separately.` : `Connection probe failed: ${result.error || "no successful response"}`);
    })}>Check connection</button><button disabled={busy} onClick={() => void perform(async () => { await api.patch(path, { disabled: !disabled }); await onChanged(); })}>{disabled ? "Resume provider" : "Pause provider"}</button>
    <Link className="btn" href="/diagnostics">Inspect requests and attempts</Link></div>
    <h3>Last 7 days</h3>{stats ? <>
      <p>{stats.requests} requests · {stats.attemptCount} attempts · {stats.inputTokens ?? "Unknown"} input / {stats.outputTokens ?? "Unknown"} output tokens</p>
      <p>Measured throughput: {stats.throughputTokensPerSec === undefined ? "Unknown" : `${stats.throughputTokensPerSec.toFixed(1)} tokens/sec (${stats.throughputSamples ?? 0} samples)`}</p>
      <p>Observed cache hit rate: {stats.cacheHitRate == null ? "Unknown" : `${(stats.cacheHitRate * 100).toFixed(1)}%`}</p>
      <p>API price estimate: {stats.estimatedCostUsd === undefined || !stats.pricedRequests ? "Unknown" : `$${stats.estimatedCostUsd.toFixed(5)} across priced requests`} · {stats.pricedRequests ?? 0} priced / {stats.unpricedRequests ?? "Unknown"} unpriced requests. Subscription billing is not inferred.</p>
    </> : stats === undefined ? <p role="status">{error ? "Measurements unavailable." : "Loading measurements…"}</p> : <p className="muted">No retained usage measurements for this provider.</p>}
  </section>;
}
