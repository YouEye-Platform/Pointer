"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { ModelGroupStar } from "@/components/ModelGroupStar";
import { api, ApiError } from "@/lib/api";
import {
  benchmarkScore,
  formatPrice,
  formatTokens,
  type BenchmarkDescriptor,
  type CatalogListResponse,
  type CatalogModel,
} from "@/lib/catalog";
import type { GroupDetail, GroupSummary } from "@/lib/groups";

type ViewMode = "table" | "grid";

export default function ModelsPage() {
  const [data, setData] = useState<CatalogListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [availability, setAvailability] = useState("available");
  const [capability, setCapability] = useState("");
  const [creator, setCreator] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState("recommended");
  const [order, setOrder] = useState("asc");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ViewMode>("table");
  const [benchmarks, setBenchmarks] = useState<string[]>([]);
  const benchmarkSelectionInitialized = useRef(false);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [defaultGroup, setDefaultGroup] = useState<GroupDetail | null>(null);
  const [groupError, setGroupError] = useState("");

  const loadGroups = useCallback(async () => {
    setGroupError("");
    const selected = await api.get<GroupDetail>("/api/groups/default");
    const summaries = await api.get<GroupSummary[]>("/api/groups");
    setGroups(summaries.some((group) => group.id === selected.id)
      ? summaries
      : [{
        id: selected.id,
        name: selected.name,
        isDefault: true,
        position: selected.position,
        entryCount: selected.entries.length,
        enabledEntryCount: selected.entries.filter((entry) => entry.enabled).length,
        previewEntries: selected.entries.filter((entry) => entry.enabled).slice(0, 3),
        createdAt: selected.createdAt,
      }, ...summaries]);
    setDefaultGroup(selected);
  }, []);

  useEffect(() => {
    loadGroups().catch((reason) => {
      setGroups([]);
      setDefaultGroup(null);
      setGroupError(reason instanceof ApiError ? reason.message : "Model group controls are unavailable");
    });
  }, [loadGroups]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: "50", availability, sort, order });
    if (deferredSearch.trim()) params.set("search", deferredSearch.trim());
    if (capability) params.set("capability", capability);
    if (creator) params.set("creator", creator);
    if (provider) params.set("provider", provider);
    setLoading(true);
    setError("");
    api.get<CatalogListResponse>(`/api/catalog?${params}`).then((result) => {
      if (!cancelled) {
        setData(result);
        if (!benchmarkSelectionInitialized.current) {
          setBenchmarks((result.benchmarkDescriptors ?? []).filter((item) => item.defaultVisible).map((item) => item.id));
          benchmarkSelectionInitialized.current = true;
        }
      }
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Failed to load models");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [deferredSearch, availability, capability, creator, provider, sort, order, page]);

  useEffect(() => setPage(1), [deferredSearch, availability, capability, creator, provider, sort, order]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const sourceProblems = data?.sources.filter((source) => source.stale || source.status === "error") ?? [];
  const benchmarkDescriptors = data?.benchmarkDescriptors ?? [];
  const selectedDescriptors = benchmarks
    .map((id) => benchmarkDescriptors.find((descriptor) => descriptor.id === id))
    .filter((descriptor): descriptor is BenchmarkDescriptor => Boolean(descriptor));
  return (
    <div>
      <div className="spread page-head">
        <div>
          <p className="eyebrow">Canonical catalog</p>
          <h1>Models</h1>
          <p className="muted">Every provider model, one stable identity, source-specific evidence. Default order is a normalized consensus across available general benchmarks.</p>
        </div>
        <div className="segmented" aria-label="Model view">
          <button type="button" className={view === "table" ? "active" : ""} onClick={() => setView("table")}>Table</button>
          <button type="button" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>Grid</button>
        </div>
      </div>

      {sourceProblems.length > 0 && (
        <div className="notice warning" role="status">
          <strong>Partial or stale source data.</strong>{" "}
          {sourceProblems.map((source) => `${source.sourceId}${source.error ? `: ${source.error.message}` : " is stale"}`).join("; ")}
        </div>
      )}
      {error && <div className="notice danger" role="alert">{error}</div>}
      {groupError && <div className="notice warning" role="alert">Model group controls are unavailable: {groupError}. <button className="btn-sm" onClick={() => void loadGroups()}>Retry</button></div>}

      <div className="catalog-controls card">
        <div className="field search-field">
          <label htmlFor="model-search">Search names and raw aliases</label>
          <input id="model-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Claude, GPT, provider/model..." />
        </div>
        <label className="availability-toggle" htmlFor="availability-filter">
          <input id="availability-filter" type="checkbox" checked={availability === "all"} onChange={(event) => setAvailability(event.target.checked ? "all" : "available")} />
          Show all models
        </label>
        <div className="field"><label htmlFor="creator-filter">Creator</label><select id="creator-filter" value={creator} onChange={(event) => setCreator(event.target.value)}><option value="">Any creator</option>{data?.facets.creators.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="field"><label htmlFor="provider-filter">Provider</label><select id="provider-filter" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">Any provider</option>{data?.facets.providers.filter((value) => availability === "all" || value.available).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
        <div className="field">
          <label htmlFor="capability-filter">Capability</label>
          <select id="capability-filter" value={capability} onChange={(event) => setCapability(event.target.value)}>
            <option value="">Any capability</option>
            <option value="tools">Tools</option>
            <option value="vision">Vision</option>
            <option value="reasoning">Reasoning</option>
            <option value="streaming">Streaming</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort-models">Sort</label>
          <select id="sort-models" value={sort} onChange={(event) => {
            const nextSort = event.target.value;
            setSort(nextSort);
            if (nextSort === "recommended") setOrder("asc");
            else if (nextSort.startsWith("benchmark:")) setOrder("desc");
          }}>
            <option value="recommended">Recommended benchmark order</option>
            <option value="newest">Newest release</option>
            <option value="name">Name</option>
            <option value="price">Reference input price</option>
            <option value="context">Context</option>
            <option value="providers">Provider count</option>
            {benchmarkDescriptors.map((benchmark) => <option key={benchmark.id} value={`benchmark:${benchmark.id}`}>{benchmark.label}</option>)}
          </select>
        </div>
        <button type="button" className="order-button" disabled={sort === "recommended"} onClick={() => setOrder(order === "asc" ? "desc" : "asc")} aria-label={`Sort ${order === "asc" ? "descending" : "ascending"}`}>
          {order === "asc" ? "Ascending" : "Descending"}
        </button>
      </div>

      <fieldset className="benchmark-toggle">
        <legend>Benchmark columns</legend>
        {benchmarkDescriptors.map((benchmark) => (
          <label key={benchmark.id} title={benchmark.description}>
            <input type="checkbox" checked={benchmarks.includes(benchmark.id)} onChange={() => setBenchmarks((current) => current.includes(benchmark.id) ? current.filter((item) => item !== benchmark.id) : [...current, benchmark.id])} />
            {benchmark.label}
          </label>
        ))}
      </fieldset>
      {data && (
        <p className="catalog-result-summary" aria-live="polite">
          {availability === "available"
            ? `${data.total} models available from your added providers`
            : `${data.total} models in the full catalog`}
        </p>
      )}

      {loading && !data ? <ModelSkeleton /> : data?.items.length === 0 ? (
        <div className="card empty-state"><h2>No matching models</h2><p className="muted">Change the filters or refresh the Pointer source adapters.</p></div>
      ) : view === "grid" ? (
        <div className="model-grid">{data?.items.map((model) => <ModelCard key={model.id} model={model} benchmarks={selectedDescriptors} groups={groups} defaultGroup={defaultGroup} onChanged={loadGroups} />)}</div>
      ) : (
        <div className={`card table-scroll ${loading ? "is-refreshing" : ""}`}>
          <table className="model-table">
            <thead><tr><th>Model</th><th>Capabilities</th><th>Context</th><th>Input / output</th><th>Providers</th>{selectedDescriptors.map((benchmark) => <th key={benchmark.id}>{benchmark.label}</th>)}</tr></thead>
            <tbody>{data?.items.map((model) => <ModelRow key={model.id} model={model} benchmarks={selectedDescriptors} groups={groups} defaultGroup={defaultGroup} onChanged={loadGroups} />)}</tbody>
          </table>
        </div>
      )}

      <div className="pagination" aria-label="Model pages">
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button>
        <span>Page {page} of {pages} <span className="muted">({data?.total ?? 0} models)</span></span>
        <button type="button" disabled={page >= pages || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
      </div>
    </div>
  );
}

function ModelIdentity({ model, groups, defaultGroup, onChanged }: { model: CatalogModel; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  return <div className="model-identity"><ModelGroupStar model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} /><IconAvatar iconKey={model.modelIconKey ?? model.creatorIconKey} name={model.name} /><div><Link href={`/models/${encodeURIComponent(model.slug)}`}><strong>{model.name}</strong></Link></div></div>;
}

function ModelRow({ model, benchmarks, groups, defaultGroup, onChanged }: { model: CatalogModel; benchmarks: BenchmarkDescriptor[]; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  return <tr><td><ModelIdentity model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} />{model.releasedAt && <small className="muted">Released {new Date(model.releasedAt).toLocaleDateString()}</small>}</td><td><CapabilityBadges model={model} /></td><td>{formatTokens(model.contextWindow)}</td><td><span>{formatPrice(model.referencePricing.input)}</span><span className="muted"> / {formatPrice(model.referencePricing.output)}</span></td><td><span className={model.available ? "success" : "muted"}>{model.availableProviderCount}</span> / {model.providerCount}</td>{benchmarks.map((benchmark) => <td key={benchmark.id}>{benchmarkScore(model.benchmarks.find((item) => item.benchmarkId === benchmark.id))}</td>)}</tr>;
}

function ModelCard({ model, benchmarks, groups, defaultGroup, onChanged }: { model: CatalogModel; benchmarks: BenchmarkDescriptor[]; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  return <article className="card model-card"><ModelIdentity model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} /><p className="model-description">{model.description || "Provider-discovered model with no reference description."}</p><CapabilityBadges model={model} /><dl><div><dt>Context</dt><dd>{formatTokens(model.contextWindow)}</dd></div><div><dt>Providers</dt><dd>{model.availableProviderCount} available / {model.providerCount}</dd></div><div><dt>Input price</dt><dd>{formatPrice(model.referencePricing.input)}</dd></div></dl><div className="benchmark-strip">{benchmarks.map((benchmark) => { const value = model.benchmarks.find((item) => item.benchmarkId === benchmark.id); return <span key={benchmark.id}><small>{benchmark.label}</small><strong>{benchmarkScore(value)}</strong></span>; })}</div></article>;
}

function CapabilityBadges({ model }: { model: CatalogModel }) {
  const active = Object.entries(model.capabilities).filter(([, enabled]) => enabled).map(([name]) => name);
  return <div className="badge-row">{active.length ? active.map((name) => <span className="badge" key={name}>{name}</span>) : <span className="muted">Standard text</span>}</div>;
}

function ModelSkeleton() {
  return <div className="model-grid" aria-label="Loading models">{Array.from({ length: 8 }, (_, index) => <div className="card skeleton-card" key={index}><span className="skeleton line wide" /><span className="skeleton line" /><span className="skeleton block" /></div>)}</div>;
}
