"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
type Log = { requestId: string; timestamp: number; provider: string; requestedModel?: string; model: string;
  resolvedModel?: string; servedModel?: string; accountLogLabel?: string; status: number; durationMs: number;
  effectiveEffort?: string; requestedEffort?: string; errorCode?: string; upstreamError?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
  displayMetrics?: { cost?: { kind: "value" | "unavailable"; estimate?: { cost: { total: number }; estimated: boolean; price?: { source: string } }; reason?: string; estimateReasons?: string[] } };
  attempts?: Array<{ provider: string; model: string; status: number; durationMs: number; accountLogLabel?: string }> };
export default function Diagnostics() {
  const [data, setData] = useState<{ total: number; logs: Log[] } | null>(null); const [error, setError] = useState("");
  const [provider, setProvider] = useState(""); const [status, setStatus] = useState(""); const [offset, setOffset] = useState(0); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setBusy(true); setError(""); try {
    const query = new URLSearchParams({ limit: "25", offset: String(offset) }); if (provider.trim()) query.set("provider", provider.trim()); if (status) query.set("status", status);
    setData(await api.get(`/api/connections/logs?${query}`));
  } catch (reason) { setError(reason instanceof Error ? reason.message : "Request history unavailable."); } finally { setBusy(false); } }, [provider, status, offset]);
  useEffect(() => { void load(); }, [load]);
  return <div><div className="spread page-head"><div><h1>Request diagnostics</h1><p className="muted">Recent engine requests for your accounts. Actual routes, attempts and reported usage; request contents are not shown.</p></div><button disabled={busy} onClick={() => void load()}>Refresh requests</button></div>
    <div className="catalog-controls card"><label>Provider ID<input value={provider} onChange={event => { setOffset(0); setProvider(event.target.value); }} /></label><label htmlFor="diagnostic-status">Status<select id="diagnostic-status" aria-label="Status" value={status} onChange={event => { setOffset(0); setStatus(event.target.value); }}><option value="">All</option><option value="2xx">Success</option><option value="4xx">Request rejections</option><option value="5xx">Server errors</option></select></label></div>
    {error && <p role="alert" className="error">{error}</p>}{!data && !error && <p role="status">Loading requests…</p>}{data?.logs.length === 0 && <p>No recorded requests in the retained engine history.</p>}
    {data?.logs.map(log => <article className="card" key={log.requestId}><div className="spread"><strong>{log.requestedModel || log.model}</strong><span>{log.status} · {log.durationMs} ms</span></div><p>{new Date(log.timestamp).toLocaleString()} · {log.provider} · {log.accountLogLabel || "Account attribution unavailable"}</p><p>Resolved: {log.resolvedModel || log.model} · Served: {log.servedModel || "Not reported"}</p><p>Effort: {log.requestedEffort || "Client default"} requested / {log.effectiveEffort || "Not reported"} effective</p>
      <p>Reported tokens: {log.usage?.inputTokens ?? "Unknown"} input / {log.usage?.outputTokens ?? "Unknown"} output / {log.usage?.cachedInputTokens ?? "Unknown"} cached / {log.usage?.reasoningOutputTokens ?? "Unknown"} reasoning</p>
      <p className="muted">Cost: {log.displayMetrics?.cost?.kind === "value" && log.displayMetrics.cost.estimate ? `$${log.displayMetrics.cost.estimate.cost.total.toFixed(5)} API price estimate (${log.displayMetrics.cost.estimate.price?.source || "combined attempt pricing"}; not subscription billing)` : `Unknown (${log.displayMetrics?.cost?.reason || "no complete pricing evidence"})`}</p>
      {(log.errorCode || log.upstreamError) && <p className="error">{log.errorCode} {log.upstreamError}</p>}
      {log.attempts?.length ? <details><summary>{log.attempts.length} routing attempts</summary><ol>{log.attempts.map((attempt, i) => <li key={i}>{attempt.provider}/{attempt.model} · {attempt.status} · {attempt.durationMs} ms · {attempt.accountLogLabel || "Account unknown"}</li>)}</ol></details> : null}
    </article>)}
    {data && <div className="spread"><button disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer requests</button><span>{data.total} matching retained requests</span><button disabled={offset + 25 >= data.total || busy} onClick={() => setOffset(offset + 25)}>Older requests</button></div>}
  </div>;
}
