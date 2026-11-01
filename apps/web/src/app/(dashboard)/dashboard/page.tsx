"use client";
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";

import Link from "next/link";
import { IconAvatar } from "@/components/IconAvatar";
import { inventory, type Inventory } from "@/lib/provider-inventory";
import { CardsSkeleton, TableSkeleton } from "@/components/LoadingSkeleton";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { RecentActivity } from "@/components/RecentActivity";
import type { StatsResponse } from "@/lib/stats";

const ENTITY_LABELS: Record<string, string> = {model: "Model", provider: "Provider", instance: "Instance", key: "Key", source: "Source", outcome: "Outcome"};

type Breakdown = { group: string; items: Array<{ id: string | null; requests: number; inputTokens: number; outputTokens: number; totalCost: number | null; avgLatency: number | null; avgTtfb: number | null; successRate: number | null }> };

export default function OverviewPage() {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();
  const { metric } = format;
  const [connections, setConnections] = useState<Inventory | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadConnections = () => { setConnectionError(""); return inventory().then(setConnections).catch(() => setConnectionError(translateInterface("Provider connections could not load."))); };
  useEffect(() => { void loadConnections(); }, []);
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
    let current = true;
    setLoading(true); setStats(null); setBreakdown(null);
    const params = new URLSearchParams({ days: String(days) });
    if (source) params.set("source", source);
    if (outcome) params.set("outcome", outcome);
    if (entityId.trim()) params.set(entity, entityId.trim());
    const breakdownParams = new URLSearchParams(params); breakdownParams.set("group", group);
    setError("");
    Promise.all([api.get<StatsResponse>(`/api/stats/summary?${params}`), api.get<Breakdown>(`/api/stats/breakdown?${breakdownParams}`)])
      .then(([nextStats, nextBreakdown]) => { if (!current) return; setStats(nextStats); setBreakdown(nextBreakdown); })
      .catch((reason) => { if (current) setError(translateInterface("Failed to load overview")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [days, source, outcome, entity, entityId, group]);
  return <div>
    <div className="spread page-head"><div><p className="eyebrow">{translateInterface("User-scoped telemetry")}</p><h1>{translateInterface("Overview")}</h1><p className="muted">{translateInterface("Usage, performance and connected providers in one place.")}</p></div><div className="segmented" aria-label={translateInterface("Usage range")}>{[1, 7, 30, 90].map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{translateInterface("{count} days", {count: format.number(value)})}</button>)}</div></div>
    <div className="catalog-controls card"><div className="field"><label htmlFor="usage-source">{translateInterface("Source")}</label><select id="usage-source" value={source} onChange={(event) => setSource(event.target.value)}><option value="">{translateInterface("All")}</option><option value="proxy">{translateInterface("Proxy")}</option><option value="test">{translateInterface("Test")}</option></select></div><div className="field"><label htmlFor="usage-outcome">{translateInterface("Outcome")}</label><select id="usage-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">{translateInterface("All")}</option><option value="success">{translateInterface("Success")}</option><option value="upstream_error">{translateInterface("Upstream error")}</option><option value="translation_error">{translateInterface("Translation error")}</option><option value="timeout">{translateInterface("Timeout")}</option><option value="aborted">{translateInterface("Aborted")}</option></select></div><div className="field"><label htmlFor="usage-entity">{translateInterface("Entity")}</label><select id="usage-entity" value={entity} onChange={(event) => setEntity(event.target.value)}>{["model","provider","instance","key"].map((value) => <option key={value} value={value}>{translateInterface(ENTITY_LABELS[value] ?? value)}</option>)}</select></div><div className="field search-field"><label htmlFor="usage-entity-id">{translateInterface("Entity ID")}</label><input id="usage-entity-id" value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder={translateInterface("Optional exact ID")} /></div><div className="field"><label htmlFor="usage-group">{translateInterface("Group table by")}</label><select id="usage-group" value={group} onChange={(event) => setGroup(event.target.value)}>{["model","provider","instance","key","source","outcome"].map((value) => <option key={value} value={value}>{translateInterface(ENTITY_LABELS[value] ?? value)}</option>)}</select></div></div>
    {error && <div className="notice danger">{error}</div>}
    {loading && <><CardsSkeleton label={translateInterface("Loading usage summary")} count={4} className="kpi-grid" /><div className="detail-grid"><CardsSkeleton label={translateInterface("Loading request trend")} count={1} className="stack" /><CardsSkeleton label={translateInterface("Loading performance")} count={1} className="stack" /></div><TableSkeleton label={translateInterface("Loading grouped usage")} columns={[translateInterface("ID"), translateInterface("Requests"), translateInterface("Success"), translateInterface("Tokens in / out"), translateInterface("Cost"), translateInterface("Latency / TTFB")]} /><TableSkeleton label={translateInterface("Loading requests")} columns={[translateInterface("Time"), translateInterface("Model"), translateInterface("Provider"), translateInterface("Source"), translateInterface("Tokens"), translateInterface("Cost"), translateInterface("Latency / TTFB"), translateInterface("Throughput"), translateInterface("Outcome")]} /></>}
    {!loading && stats && <><div className="kpi-grid"><article className="card"><small>{translateInterface("Requests")}</small><strong>{format.number(stats.totals.requests)}</strong><span className="muted">{translateInterface("{confidence} confidence", {confidence: translateInterface(stats.sample.confidence)})}</span></article><article className="card"><small>{translateInterface("Total tokens")}</small><strong>{format.number(stats.totals.inputTokens + stats.totals.outputTokens)}</strong></article><article className="card"><small>{translateInterface("Cost")}</small><strong>{format.price(stats.totals.totalCost, 4)}</strong><span className="muted">{translateInterface("{count} priced samples", {count: format.number(stats.totals.knownCostSamples)})}</span></article><article className="card"><small>{translateInterface("Latency p50 / p95")}</small><strong>{metric(stats.latency.p50, " ms")} / {metric(stats.latency.p95, " ms")}</strong></article></div>
      <div className="detail-grid" style={{ marginTop: 16 }}><section className="card"><h2>{translateInterface("Request and cost trend")}</h2><div className="mini-chart" role="img" aria-label={translateInterface("Daily request counts")}>{stats.daily.map(day => <div key={day.date} className="mini-bar-wrap" title={translateInterface("{date}: {requests} requests, {cost}", {date: new Date(`${day.date}T00:00:00Z`).toLocaleDateString(translateInterface.locale, {timeZone: "UTC"}), requests: format.number(day.requests), cost: day.cost == null ? translateInterface("unknown cost") : format.price(day.cost, 5)})}><span className="mini-bar" style={{ height: `${Math.max(3, day.requests / Math.max(1, ...stats.daily.map(item => item.requests)) * 100)}%` }} /><small>{day.date.slice(5)}</small></div>)}</div><p className="muted">{translateInterface("Daily cost is included in each bar tooltip.")}</p></section><section className="card"><h2>{translateInterface("Performance")}</h2><dl><div><dt>{translateInterface("Success rate")}</dt><dd>{metric(stats.totals.successRate, "%")}</dd></div><div><dt>{translateInterface("Errors")}</dt><dd>{format.number(stats.totals.errors)}</dd></div><div><dt>{translateInterface("Throughput")}</dt><dd>{metric(stats.throughput.avg, " t/s")}</dd></div></dl></section></div>
      {breakdown && <><h2 style={{ marginTop: 24 }}>{translateInterface("Grouped by {group}", {group: translateInterface(breakdown.group)})}</h2><div className="card table-scroll"><table><thead><tr><th>{translateInterface("ID")}</th><th>{translateInterface("Requests")}</th><th>{translateInterface("Success")}</th><th>{translateInterface("Tokens in / out")}</th><th>{translateInterface("Cost")}</th><th>{translateInterface("Latency / TTFB")}</th></tr></thead><tbody>{breakdown.items.length ? breakdown.items.map((row) => <tr key={row.id || "none"}><td className="mono">{row.id || translateInterface("Unassigned")}</td><td>{format.number(row.requests)}</td><td>{metric(row.successRate, "%")}</td><td>{format.number(row.inputTokens)} / {format.number(row.outputTokens)}</td><td>{format.price(row.totalCost, 5)}</td><td>{metric(row.avgLatency, " ms")} / {metric(row.avgTtfb, " ms")}</td></tr>) : <tr><td colSpan={6} className="muted">{translateInterface("No matching usage.")}</td></tr>}</tbody></table></div></>}
      <h2 style={{ marginTop: 24 }}>{translateInterface("Requests")}</h2><RecentActivity rows={stats.recent} /></>}
    <section className="card" style={{ marginTop: 24 }}><div className="spread"><h2>{translateInterface("Provider connections")}</h2><Link href="/providers">{translateInterface("All providers")}</Link></div>
      {connectionError ? <p role="alert">{connectionError} <button onClick={() => void loadConnections()}>{translateInterface("Retry")}</button></p> : !connections ? <CardsSkeleton label={translateInterface("Loading provider connections")} count={1} className="stack" /> : <div className="stack">{connections.providers.filter(provider => provider.connection?.setup).map(provider => {
        const preset = connections.presets.find(item => (item.oauthProvider || item.id) === provider.name);
        return <Link href={`/providers/${encodeURIComponent(preset?.id || provider.name)}`} key={provider.name} className="provider-health-row"><IconAvatar iconKey={preset?.id || provider.name} name={preset?.label || provider.name} /><span><strong>{preset?.label || provider.name}</strong><small>{translateInterface("{count} discovered models", {count: format.number(connections.models.filter(model => model.provider === provider.name).length)})}</small></span><span>{translateInterface(provider.connection?.label ?? "Connection status unavailable")}</span></Link>;
      })}{!connections.providers.some(provider => provider.connection?.setup) && <p className="muted">{translateInterface("No connected providers.")} <Link href="/providers">{translateInterface("Connect a provider to discover models.")}</Link></p>}</div>}
    </section>
  </div>;
}
