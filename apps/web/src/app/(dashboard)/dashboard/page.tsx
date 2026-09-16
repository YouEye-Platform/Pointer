"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { metric, type StatsResponse } from "@/lib/stats";
import { RecentActivity } from "@/components/RecentActivity";
import { IconAvatar } from "@/components/IconAvatar";

type Provider = { id: string; name: string; iconKey: string | null; status: string; modelCount: number; hasOwnKey: boolean; balance: { supported: boolean; value?: number | null; status?: string; updatedAt?: string | null }; rateLimits: { supported: boolean; updatedAt?: string | null } };

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null); const [providers, setProviders] = useState<Provider[]>([]); const [error, setError] = useState("");
  useEffect(() => { Promise.all([api.get<StatsResponse>("/api/stats/summary?days=30&source=proxy"), api.get<Provider[]>("/api/providers")]).then(([usage, providerRows]) => { setStats(usage); setProviders(providerRows); }).catch((reason) => setError(reason instanceof ApiError ? reason.message : "Failed to load dashboard")); }, []);
  if (error) return <div className="notice danger">{error}</div>; if (!stats) return <div className="center-screen">Loading dashboard...</div>;
  const max = Math.max(1, ...stats.daily.map((day) => day.requests));
  return <div><div className="page-head"><p className="eyebrow">Last 30 days</p><h1>Dashboard</h1><p className="muted">Proxy traffic only. Metrics show sample confidence rather than invented certainty.</p></div>
    <div className="kpi-grid"><article className="card"><small>Requests</small><strong>{stats.totals.requests}</strong><span className="muted">{stats.sample.confidence} confidence</span></article><article className="card"><small>Success rate</small><strong>{metric(stats.totals.successRate, "%")}</strong><span className="muted">{stats.totals.errors} errors</span></article><article className="card"><small>Known cost</small><strong>{stats.totals.totalCost == null ? "Unknown" : `$${stats.totals.totalCost.toFixed(4)}`}</strong><span className="muted">{stats.totals.knownCostSamples} priced requests</span></article><article className="card"><small>Throughput</small><strong>{metric(stats.throughput.avg, " t/s")}</strong><span className="muted">{stats.throughput.samples} samples</span></article></div>
    <div className="detail-grid" style={{ marginTop: 16 }}><section className="card"><div className="spread"><h2>Request and cost trend</h2><span className="muted">Daily totals</span></div><div className="mini-chart" role="img" aria-label="Daily request counts">{stats.daily.map((day) => <div key={day.date} className="mini-bar-wrap" title={`${day.date}: ${day.requests} requests, ${day.cost == null ? "unknown cost" : `$${day.cost.toFixed(5)}`}`}><span className="mini-bar" style={{ height: `${Math.max(3, day.requests / max * 100)}%` }} /><small>{day.date.slice(5)}</small></div>)}</div><div className="spread muted"><span>Daily cost is included in each bar tooltip.</span><Link href="/usage">Open usage filters</Link></div></section>
      <section className="card"><div className="spread"><h2>Provider health</h2><Link href="/providers">All providers</Link></div><div className="stack">{providers.map((provider) => <Link href={`/providers/${provider.id}`} key={provider.id} className="provider-health-row"><IconAvatar iconKey={provider.iconKey} name={provider.name} /><span><strong>{provider.name}</strong><small>{provider.modelCount} models · {provider.hasOwnKey ? "credential set" : "no credential"}</small></span><span className={provider.status === "active" ? "success" : "danger"}>{provider.status}</span><span>{provider.balance.supported ? (provider.balance.value == null ? provider.balance.status || "Pending" : `$${provider.balance.value.toFixed(2)}`) : "Balance N/A"}</span></Link>)}</div></section></div>
    <section style={{ marginTop: 24 }}><h2>Recent activity</h2><RecentActivity rows={stats.recent.slice(0, 10)} /></section>
  </div>;
}
