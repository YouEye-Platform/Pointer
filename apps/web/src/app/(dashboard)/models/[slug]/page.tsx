"use client";
import { DetailSkeleton } from "@/components/LoadingSkeleton";
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";


import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { api, ApiError } from "@/lib/api";
import { benchmarkScore, type CatalogDetailResponse } from "@/lib/catalog";
import type { StatsResponse } from "@/lib/stats";

export default function ModelDetailPage() {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();
  const { metric } = format;

  const params = useParams<{ slug: string }>();
  const [model, setModel] = useState<CatalogDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsWarning, setStatsWarning] = useState("");

  useEffect(() => {
    let cancelled = false;
    const slug = decodeURIComponent(params.slug);
    setLoading(true);
    setError("");
    setStats(null);
    setStatsWarning("");
    api.get<CatalogDetailResponse>(`/api/catalog/detail?slug=${encodeURIComponent(slug)}`).then(async (result) => {
      if (!cancelled) setModel(result);
      try {
        const performance = await api.get<StatsResponse>(`/api/stats/summary?days=30&model=${encodeURIComponent(result.id)}`);
        if (!cancelled) setStats(performance);
      } catch {
        if (!cancelled) setStatsWarning(translateInterface("Observed performance is unavailable. Model details are still shown. Reload to try again."));
      }
    }).catch((reason) => {
      if (!cancelled) setError(translateInterface("Failed to load model"));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [params.slug]);

  if (loading) return <DetailSkeleton label={translateInterface("Loading model")} kind="model" />;
  if (error || !model) return <div className="notice danger" role="alert">{error || translateInterface("Model not found")}</div>;

  return (
    <div>
      <Link href="/models" className="back-link">{translateInterface("Back to models")}</Link>
      <header className="model-hero">
        <IconAvatar iconKey={model.modelIconKey ?? model.creatorIconKey} name={model.name} size={54} />
        <div><p className="eyebrow">{model.creator || translateInterface("Unknown creator")}</p><h1>{model.name}</h1><p className="mono muted">{model.id}</p>{model.releasedAt && <p className="muted">{translateInterface("Released")}{new Date(model.releasedAt).toLocaleDateString()}</p>}</div>
        <span className={`availability-pill ${model.available ? "available" : "unavailable"}`}>{model.available ? translateInterface("{value0} available", { value0: model.availableProviderCount }) : translateInterface("Not currently available")}</span>
      </header>
      <p className="model-lede">{model.description || (model.metadataSource === "benchmark"
        ? translateInterface("No provider or reference description is available for this benchmark-only model.")
        : translateInterface("No reference description is currently available for this provider-discovered model."))}</p>

      <section className="stat-band" aria-label={translateInterface("Model specifications")}>
        <div><span>{translateInterface("Context")}</span><strong>{format.tokens(model.contextWindow)}</strong></div>
        <div><span>{translateInterface("Max output")}</span><strong>{format.tokens(model.maxOutput)}</strong></div>
        <div><span>{translateInterface("Reference input")}</span><strong>{format.price(model.referencePricing.input)}</strong><small>{translateInterface("/ 1M tokens")}</small></div>
        <div><span>{translateInterface("Reference output")}</span><strong>{format.price(model.referencePricing.output)}</strong><small>{translateInterface("/ 1M tokens")}</small></div>
      </section>
      {statsWarning && <p className="notice" role="status">{statsWarning}</p>}
      {stats && <section className="stat-band" aria-label={translateInterface("Observed model performance")}><div><span>{translateInterface("Observed requests")}</span><strong>{format.number(stats.sample.requests)}</strong><small>{translateInterface("{confidence} confidence", {confidence: translateInterface(stats.sample.confidence)})}</small></div><div><span>{translateInterface("Success")}</span><strong>{metric(stats.totals.successRate, "%")}</strong></div><div><span>{translateInterface("Latency p50")}</span><strong>{metric(stats.latency.p50, " ms")}</strong></div><div><span>{translateInterface("Throughput")}</span><strong>{metric(stats.throughput.avg, " t/s")}</strong><small>{translateInterface("{count} samples", {count: format.number(stats.throughput.samples)})}</small></div></section>}

      <div className="detail-grid">
        <section className="card detail-main"><div className="section-head"><div><p className="eyebrow">{translateInterface("Routing choices")}</p><h2>{translateInterface("Providers and pricing")}</h2></div><span className="badge">{model.providers.length} {translateInterface("catalogs")}</span></div>
          {model.providers.length === 0 ? <p className="muted">{translateInterface("No provider currently lists this benchmark-only model.")}</p> : <div className="provider-price-list">{model.providers.map((provider) => (
            <article key={`${provider.providerId}:${provider.rawModelId}`} className="provider-price-row">
              <IconAvatar iconKey={provider.providerIconKey} name={provider.providerName} />
              <div className="provider-price-name"><Link href={`/providers/${encodeURIComponent(provider.providerName)}`}><strong>{provider.providerName}</strong></Link><span className="mono muted">{provider.rawModelId}</span></div>
              <div><small>{translateInterface("Input")}</small><strong>{format.price(provider.pricing.input)}</strong></div>
              <div><small>{translateInterface("Output")}</small><strong>{format.price(provider.pricing.output)}</strong></div>
              <div><small>{translateInterface("Availability")}</small><strong className={provider.available ? "success" : "muted"}>{provider.available ? translateInterface("Available") : translateInterface("Provider not added")}</strong></div>
            </article>
          ))}</div>}
        </section>

        <aside className="stack">
          <section className="card"><p className="eyebrow">{translateInterface("Capabilities")}</p><h2>{translateInterface("What it supports")}</h2><div className="badge-row">{Object.entries(model.capabilities).map(([name, enabled]) => <span key={name} className={`badge ${enabled ? "enabled" : "disabled"}`}>{name}: {enabled ? translateInterface("supported") : translateInterface("not supported")}</span>)}</div></section>
          <section className="card"><p className="eyebrow">{translateInterface("Identity")}</p><h2>{translateInterface("Aliases and sources")}</h2>{model.metadataFetchedAt && <p className="muted">{translateInterface("Catalog metadata refreshed {date}", {date: new Date(model.metadataFetchedAt).toLocaleString(translateInterface.locale)})}</p>}<div className="alias-list">{model.aliases.map((alias) => <div key={`${alias.source}:${alias.alias}`}><span>{alias.source}</span><code>{alias.alias}</code></div>)}</div></section>
        </aside>
      </div>

      <section className="benchmark-section"><div className="section-head"><div><p className="eyebrow">{translateInterface("No blended score")}</p><h2>{translateInterface("Benchmarks, side by side")}</h2></div></div>
        {model.benchmarks.length === 0 ? <div className="card empty-state"><p className="muted">{translateInterface("No approved benchmark has matched this model.")}</p></div> : <div className="benchmark-grid">{model.benchmarks.map((benchmark) => (
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
