"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { RecentActivity } from "@/components/RecentActivity";
import { metric, type StatsResponse } from "@/lib/stats";

type Breakdown = { group: string; items: Array<{ id: string | null; requests: number; inputTokens: number; outputTokens: number; totalCost: number | null; avgLatency: number | null; avgTtfb: number | null; successRate: number | null }> };

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [source, setSource] = useState("");
  const [outcome, setOutcome] = useState("");
  const [entity, setEntity] = useState("model");
  const [entityId, setEntityId] = useState("");
  const [group, setGroup] = useState("model");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams({ days: String(days) });
    if (source) params.set("source", source);
    if (outcome) params.set("outcome", outcome);
    if (entityId.trim()) params.set(entity, entityId.trim());
    const breakdownParams = new URLSearchParams(params); breakdownParams.set("group", group);
    setError("");
    Promise.all([api.get<StatsResponse>(`/api/stats/summary?${params}`), api.get<Breakdown>(`/api/stats/breakdown?${breakdownParams}`)])
      .then(([nextStats, nextBreakdown]) => { setStats(nextStats); setBreakdown(nextBreakdown); })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : "Failed to load usage"));
  }, [days, source, outcome, entity, entityId, group]);
  return <div>
    <div className="spread page-head"><div><p className="eyebrow">User-scoped telemetry</p><h1>Usage</h1></div><div className="segmented" aria-label="Usage range">{[1, 7, 30, 90].map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value}d</button>)}</div></div>
    <div className="catalog-controls card"><div className="field"><label htmlFor="usage-source">Source</label><select id="usage-source" value={source} onChange={(event) => setSource(event.target.value)}><option value="">All</option><option value="proxy">Proxy</option><option value="test">Test</option></select></div><div className="field"><label htmlFor="usage-outcome">Outcome</label><select id="usage-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">All</option><option value="success">Success</option><option value="upstream_error">Upstream error</option><option value="translation_error">Translation error</option><option value="timeout">Timeout</option><option value="aborted">Aborted</option></select></div><div className="field"><label htmlFor="usage-entity">Entity</label><select id="usage-entity" value={entity} onChange={(event) => setEntity(event.target.value)}>{["model","provider","instance","key"].map((value) => <option key={value}>{value}</option>)}</select></div><div className="field search-field"><label htmlFor="usage-entity-id">Entity ID</label><input id="usage-entity-id" value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder="Optional exact ID" /></div><div className="field"><label htmlFor="usage-group">Group table by</label><select id="usage-group" value={group} onChange={(event) => setGroup(event.target.value)}>{["model","provider","instance","key","source","outcome"].map((value) => <option key={value}>{value}</option>)}</select></div></div>
    {error && <div className="notice danger">{error}</div>}
    {stats && <><div className="kpi-grid"><article className="card"><small>Requests</small><strong>{stats.totals.requests}</strong><span className="muted">{stats.sample.confidence} confidence</span></article><article className="card"><small>Total tokens</small><strong>{Intl.NumberFormat().format(stats.totals.inputTokens + stats.totals.outputTokens)}</strong></article><article className="card"><small>Cost</small><strong>{stats.totals.totalCost == null ? "Unknown" : `$${stats.totals.totalCost.toFixed(4)}`}</strong><span className="muted">{stats.totals.knownCostSamples} priced samples</span></article><article className="card"><small>Latency p50 / p95</small><strong>{metric(stats.latency.p50, " ms")} / {metric(stats.latency.p95, " ms")}</strong></article></div>
      {breakdown && <><h2 style={{ marginTop: 24 }}>Grouped by {breakdown.group}</h2><div className="card table-scroll"><table><thead><tr><th>ID</th><th>Requests</th><th>Success</th><th>Tokens in / out</th><th>Cost</th><th>Latency / TTFB</th></tr></thead><tbody>{breakdown.items.length ? breakdown.items.map((row) => <tr key={row.id || "none"}><td className="mono">{row.id || "Unassigned"}</td><td>{row.requests}</td><td>{metric(row.successRate, "%")}</td><td>{row.inputTokens} / {row.outputTokens}</td><td>{row.totalCost == null ? "Unknown" : `$${row.totalCost.toFixed(5)}`}</td><td>{metric(row.avgLatency, " ms")} / {metric(row.avgTtfb, " ms")}</td></tr>) : <tr><td colSpan={6} className="muted">No matching usage.</td></tr>}</tbody></table></div></>}
      <h2 style={{ marginTop: 24 }}>Requests</h2><RecentActivity rows={stats.recent} /></>}
  </div>;
}
