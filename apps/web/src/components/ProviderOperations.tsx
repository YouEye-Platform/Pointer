"use client";
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
type Stats = { provider: string; requests: number; attemptCount: number; inputTokens?: number;
  outputTokens?: number; throughputTokensPerSec?: number; throughputSamples?: number;
  cacheHitRate?: number | null; estimatedCostUsd?: number; priceCoverageRatio?: number;
  pricedRequests?: number; unpricedRequests?: number };
export function ProviderOperations({ name, disabled, onChanged }: { name: string; disabled: boolean; onChanged: () => Promise<void> }) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();

  const [stats, setStats] = useState<Stats | null | undefined>(undefined); const [error, setError] = useState("");
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const path = `/api/connections/providers?name=${encodeURIComponent(name)}`;
  useEffect(() => { void api.get<{ providers: Stats[] }>("/api/connections/usage?range=7d").then(data => setStats(data.providers.find(row => row.provider === name) ?? null)).catch(reason => setError(translateInterface("The operation failed."))); }, [name]);
  async function perform(task: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await task(); } catch (reason) { setError(translateInterface("Operation failed.")); } finally { setBusy(false); } }
  return <section className="card"><h2>{translateInterface("Provider status and performance")}</h2>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>{disabled ? translateInterface("Provider paused") : translateInterface("Provider enabled")}</p>
    <div className="connection-model-actions"><button disabled={busy} onClick={() => void perform(async () => {
      const result = await api.post<{ ok?: boolean; applicable?: boolean; latencyMs?: number; message?: string; error?: string; reason?: string }>(`/api/connections/providers/test?name=${encodeURIComponent(name)}`, {});
      setNotice(result.applicable === false ? translateInterface("No connectivity probe: {reason}.", {reason: result.reason || translateInterface("not supported")}) : result.ok ? result.message ? translateInterface("Connection result: {details}", {details: result.message}) : translateInterface("Catalog connection succeeded in {latency} ms. Inference must be tested separately.", {latency: result.latencyMs == null ? translateInterface("Unknown") : format.number(result.latencyMs)}) : translateInterface("Connection probe failed: {error}", {error: result.error || translateInterface("no successful response")}));
    })}>{translateInterface("Check connection")}</button><button disabled={busy} onClick={() => void perform(async () => { await api.patch(path, { disabled: !disabled }); await onChanged(); })}>{disabled ? translateInterface("Resume provider") : translateInterface("Pause provider")}</button>
    <Link className="btn" href="/dashboard">{translateInterface("View usage overview")}</Link></div>
    <h3>{translateInterface("Last 7 days")}</h3>{stats ? <>
      <p>{translateInterface("{requests} requests · {attempts} attempts · {input} input / {output} output tokens", {requests: format.number(stats.requests), attempts: format.number(stats.attemptCount), input: stats.inputTokens == null ? translateInterface("Unknown") : format.number(stats.inputTokens), output: stats.outputTokens == null ? translateInterface("Unknown") : format.number(stats.outputTokens)})}</p>
      <p>{translateInterface("Measured throughput:")} {stats.throughputTokensPerSec === undefined ? translateInterface("Unknown") : translateInterface("{value0} tokens/sec ({value1} samples)", {value0: format.number(stats.throughputTokensPerSec, {minimumFractionDigits: 1, maximumFractionDigits: 1}), value1: format.number(stats.throughputSamples ?? 0)})}</p>
      <p>{translateInterface("Observed cache hit rate:")} {stats.cacheHitRate == null ? translateInterface("Unknown") : format.number(stats.cacheHitRate, {style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1})}</p>
      <p>{translateInterface("API price estimate:")} {stats.estimatedCostUsd === undefined || !stats.pricedRequests ? translateInterface("Unknown") : translateInterface("{cost} across priced requests", {cost: format.price(stats.estimatedCostUsd, 5)})} · {translateInterface("{priced} priced / {unpriced} unpriced requests. Subscription billing is not inferred.", {priced: format.number(stats.pricedRequests ?? 0), unpriced: stats.unpricedRequests == null ? translateInterface("Unknown") : format.number(stats.unpricedRequests)})}</p>
    </> : stats === undefined ? <p role="status">{error ? translateInterface("Measurements unavailable.") : translateInterface("Loading measurements…")}</p> : <p className="muted">{translateInterface("No retained usage measurements for this provider.")}</p>}
  </section>;
}
