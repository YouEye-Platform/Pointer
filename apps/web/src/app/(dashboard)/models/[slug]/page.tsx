"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { api, ApiError } from "@/lib/api";
import { benchmarkScore, formatPrice, formatTokens, type CatalogDetailResponse } from "@/lib/catalog";
import { metric, type StatsResponse } from "@/lib/stats";

export default function ModelDetailPage() {
  const params = useParams<{ slug: string }>();
  const [model, setModel] = useState<CatalogDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const slug = decodeURIComponent(params.slug);
    setLoading(true);
    api.get<CatalogDetailResponse>(`/api/catalog/detail?slug=${encodeURIComponent(slug)}`).then(async (result) => {
      if (!cancelled) setModel(result);
      const performance = await api.get<StatsResponse>(`/api/stats/model/${encodeURIComponent(result.id)}?days=30`);
      if (!cancelled) setStats(performance);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Failed to load model");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [params.slug]);

  if (loading) return <div className="detail-skeleton"><span className="skeleton line wide" /><span className="skeleton block" /></div>;
  if (error || !model) return <div className="notice danger" role="alert">{error || "Model not found"}</div>;

  return (
    <div>
      <Link href="/models" className="back-link">Back to models</Link>
      <header className="model-hero">
        <IconAvatar iconKey={model.modelIconKey ?? model.creatorIconKey} name={model.name} size={54} />
        <div><p className="eyebrow">{model.creator || "Unknown creator"}</p><h1>{model.name}</h1><p className="mono muted">{model.id}</p>{model.releasedAt && <p className="muted">Released {new Date(model.releasedAt).toLocaleDateString()}</p>}</div>
        <span className={`availability-pill ${model.available ? "available" : "unavailable"}`}>{model.available ? `${model.availableProviderCount} available` : "Not currently available"}</span>
      </header>
      <p className="model-lede">{model.description || (model.metadataSource === "benchmark"
        ? "No provider or reference description is available for this benchmark-only model."
        : "No reference description is currently available for this provider-discovered model.")}</p>

      <section className="stat-band" aria-label="Model specifications">
        <div><span>Context</span><strong>{formatTokens(model.contextWindow)}</strong></div>
        <div><span>Max output</span><strong>{formatTokens(model.maxOutput)}</strong></div>
        <div><span>Reference input</span><strong>{formatPrice(model.referencePricing.input)}</strong><small>/ 1M tokens</small></div>
        <div><span>Reference output</span><strong>{formatPrice(model.referencePricing.output)}</strong><small>/ 1M tokens</small></div>
      </section>
      {stats && <section className="stat-band" aria-label="Observed model performance"><div><span>Observed requests</span><strong>{stats.sample.requests}</strong><small>{stats.sample.confidence} confidence</small></div><div><span>Success</span><strong>{metric(stats.totals.successRate, "%")}</strong></div><div><span>Latency p50</span><strong>{metric(stats.latency.p50, " ms")}</strong></div><div><span>Throughput</span><strong>{metric(stats.throughput.avg, " t/s")}</strong><small>{stats.throughput.samples} samples</small></div></section>}

      <div className="detail-grid">
        <section className="card detail-main"><div className="section-head"><div><p className="eyebrow">Routing choices</p><h2>Providers and pricing</h2></div><span className="badge">{model.providers.length} catalogs</span></div>
          {model.providers.length === 0 ? <p className="muted">No provider currently lists this benchmark-only model.</p> : <div className="provider-price-list">{model.providers.map((provider) => (
            <article key={`${provider.providerId}:${provider.rawModelId}`} className="provider-price-row">
              <IconAvatar iconKey={provider.providerIconKey} name={provider.providerName} />
              <div className="provider-price-name"><Link href={`/providers/${encodeURIComponent(provider.providerId)}`}><strong>{provider.providerName}</strong></Link><span className="mono muted">{provider.rawModelId}</span></div>
              <div><small>Input</small><strong>{formatPrice(provider.pricing.input)}</strong></div>
              <div><small>Output</small><strong>{formatPrice(provider.pricing.output)}</strong></div>
              <div><small>Availability</small><strong className={provider.available ? "success" : "muted"}>{provider.available ? "Available" : "Provider not added"}</strong></div>
            </article>
          ))}</div>}
        </section>

        <aside className="stack">
          <section className="card"><p className="eyebrow">Capabilities</p><h2>What it supports</h2><div className="badge-row">{Object.entries(model.capabilities).map(([name, enabled]) => <span key={name} className={`badge ${enabled ? "enabled" : "disabled"}`}>{name}: {enabled ? "supported" : "not supported"}</span>)}</div></section>
          <section className="card"><p className="eyebrow">Identity</p><h2>Aliases and sources</h2>{model.metadataFetchedAt && <p className="muted">Catalog metadata refreshed {new Date(model.metadataFetchedAt).toLocaleString()}</p>}<div className="alias-list">{model.aliases.map((alias) => <div key={`${alias.source}:${alias.alias}`}><span>{alias.source}</span><code>{alias.alias}</code></div>)}</div></section>
        </aside>
      </div>

      <section className="benchmark-section"><div className="section-head"><div><p className="eyebrow">No blended score</p><h2>Benchmarks, side by side</h2></div></div>
        {model.benchmarks.length === 0 ? <div className="card empty-state"><p className="muted">No approved benchmark has matched this model.</p></div> : <div className="benchmark-grid">{model.benchmarks.map((benchmark) => (
          <article className="card benchmark-card" key={`${benchmark.benchmarkId}:${benchmark.sourceModel}`}>
            <div className="spread">
              <h3>{model.benchmarkDescriptors.find((item) => item.id === benchmark.benchmarkId)?.label ?? benchmark.presentation.label}</h3>
              <strong className="benchmark-score">{benchmarkScore(benchmark)}</strong>
            </div>
            <p className="mono muted">{benchmark.sourceModel}</p>
            <dl>{Object.entries(benchmark.metrics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? "-" : String(value)}</dd></div>)}</dl>
            <footer>
              <span>{model.benchmarkDescriptors.find((item) => item.id === benchmark.benchmarkId)?.attribution ?? benchmark.provenance.license}</span>
              <time dateTime={benchmark.fetchedAt}>{new Date(benchmark.fetchedAt).toLocaleDateString()}</time>
            </footer>
          </article>
        ))}</div>}
      </section>
    </div>
  );
}
