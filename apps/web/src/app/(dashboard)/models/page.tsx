"use client";
import { TableSkeleton, LoadingSkeleton } from "@/components/LoadingSkeleton";
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";


import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { ModelGroupStar } from "@/components/ModelGroupStar";
import { api, ApiError } from "@/lib/api";
import {
  benchmarkScore,
  type BenchmarkDescriptor,
  type CatalogListResponse,
  type CatalogModel,
} from "@/lib/catalog";
import type { GroupDetail, GroupSummary } from "@/lib/groups";
import { syncConnectedCatalog } from "@/lib/catalog-sync";

type ViewMode = "table" | "grid";

export default function ModelsPage() {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();

  const [data, setData] = useState<CatalogListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionWarning, setConnectionWarning] = useState("");
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState("");
  async function refreshConnected() {
    setLoading(true);
    try {
      await syncConnectedCatalog(true);
      setConnectionWarning("");
    } catch {
      setConnectionWarning(translateInterface("Connected models could not be refreshed. Showing saved catalog data. Try again shortly."));
    } finally {
      setRefreshVersion(value => value + 1);
    }
  }
  async function refreshEvidence() {
    setRefreshing(true); setRefreshNotice("");
    try {
      const result = await api.post<{ results: Array<{ status: string; sourceId: string }> }>("/api/sources/refresh", {});
      const failed = result.results.filter(row => row.status === "error").map(row => row.sourceId);
      setRefreshNotice(failed.length ? translateInterface("Refreshed available evidence. Sources unavailable: {sources}. Previous evidence is retained.", {sources: failed.join(", ")}) : translateInterface("Model metadata and benchmark evidence refreshed."));
      setRefreshVersion(value => value + 1);
    } catch (reason) { setRefreshNotice(translateInterface("Evidence refresh failed.")); }
    finally { setRefreshing(false); }
  }

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
    // Existing/migrated engine connections can predate their catalog binding.
    // Repair that projection before filtering by availability; retain the last
    // catalog and a visible warning if discovery is temporarily unavailable.
    syncConnectedCatalog().then(() => {
      if (!cancelled) setConnectionWarning("");
    }).catch(() => {
      if (!cancelled) setConnectionWarning(translateInterface("Connected models could not be refreshed. Showing saved catalog data. Use Refresh connected models to try again."));
    }).then(() => api.get<CatalogListResponse>(`/api/catalog?${params}`)).then((result) => {
      if (!cancelled) {
        setData(result);
        if (!benchmarkSelectionInitialized.current) {
          setBenchmarks((result.benchmarkDescriptors ?? []).filter((item) => item.defaultVisible).map((item) => item.id));
          benchmarkSelectionInitialized.current = true;
        }
      }
    }).catch((reason) => {
      if (!cancelled) setError(translateInterface("Failed to load models"));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [deferredSearch, availability, capability, creator, provider, sort, order, page, refreshVersion]);

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
          <h1>{translateInterface("Models")}</h1>
          <p className="muted">{translateInterface("Explore models across providers and add your choices to groups.")}</p>
        </div>
        <div className="segmented" aria-label={translateInterface("Model view")}>
          <button type="button" aria-pressed={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>{translateInterface("Table")}</button>
          <button type="button" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>{translateInterface("Grid")}</button>
        </div>
      </div>

      {sourceProblems.length > 0 && (
        <div className="notice warning" role="status">
          <strong>{translateInterface("Partial or stale source data.")}</strong>{" "}
          {sourceProblems.map((source) => `${source.sourceId}${source.error ? `: ${source.error.message}` : " is stale"}`).join("; ")}
        </div>
      )}
      {error && <div className="notice danger" role="alert">{error}</div>}
      {connectionWarning && <div className="notice warning" role="status">{connectionWarning}</div>}
      <div className="catalog-refresh">
        <button disabled={loading} onClick={() => void refreshConnected()}>{loading ? translateInterface("Loading models…") : translateInterface("Refresh connected models")}</button>
        <button disabled={refreshing} onClick={() => void refreshEvidence()}>{refreshing ? translateInterface("Refreshing evidence…") : translateInterface("Refresh benchmarks and metadata")}</button>
        {refreshNotice && <p role="status">{refreshNotice}</p>}
      </div>
      {groupError && <div className="notice warning" role="alert">{translateInterface("Model group controls are unavailable:")} {groupError}. <button className="btn-sm" onClick={() => void loadGroups()}>{translateInterface("Retry")}</button></div>}

      <div className="catalog-controls card">
        <div className="field search-field">
          <label htmlFor="model-search">{translateInterface("Search names and raw aliases")}</label>
          <input id="model-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Claude, GPT, provider/model..." />
        </div>
        <label className="availability-toggle" htmlFor="availability-filter">
          <input id="availability-filter" type="checkbox" checked={availability === "all"} onChange={(event) => setAvailability(event.target.checked ? "all" : "available")} />
          {translateInterface("Show all models")}</label>
        <div className="field"><label htmlFor="creator-filter">{translateInterface("Creator")}</label><select id="creator-filter" value={creator} onChange={(event) => setCreator(event.target.value)}><option value="">{translateInterface("Any creator")}</option>{data?.facets.creators.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="field"><label htmlFor="provider-filter">{translateInterface("Provider")}</label><select id="provider-filter" value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">{translateInterface("Any provider")}</option>{data?.facets.providers.filter((value) => availability === "all" || value.available).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
        <div className="field">
          <label htmlFor="capability-filter">{translateInterface("Capability")}</label>
          <select id="capability-filter" value={capability} onChange={(event) => setCapability(event.target.value)}>
            <option value="">{translateInterface("Any capability")}</option>
            <option value="tools">{translateInterface("Tools")}</option>
            <option value="vision">{translateInterface("Vision")}</option>
            <option value="reasoning">{translateInterface("Reasoning")}</option>
            <option value="streaming">{translateInterface("Streaming")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort-models">{translateInterface("Sort")}</label>
          <select id="sort-models" value={sort} onChange={(event) => {
            const nextSort = event.target.value;
            setSort(nextSort);
            if (nextSort === "recommended") setOrder("asc");
            else if (nextSort.startsWith("benchmark:")) setOrder("desc");
          }}>
            <option value="recommended">{translateInterface("Recommended benchmark order")}</option>
            <option value="newest">{translateInterface("Newest release")}</option>
            <option value="name">{translateInterface("Name")}</option>
            <option value="price">{translateInterface("Reference input price")}</option>
            <option value="context">{translateInterface("Context")}</option>
            <option value="providers">{translateInterface("Provider count")}</option>
            {benchmarkDescriptors.map((benchmark) => <option key={benchmark.id} value={`benchmark:${benchmark.id}`}>{benchmark.label}</option>)}
          </select>
        </div>
        <button type="button" className="order-button" disabled={sort === "recommended"} onClick={() => setOrder(order === "asc" ? "desc" : "asc")} aria-label={translateInterface("Sort {value0}", { value0: order === "asc" ? translateInterface("descending") : translateInterface("ascending") })}>
          {order === "asc" ? translateInterface("Ascending") : translateInterface("Descending")}
        </button>
      </div>

      <details className="catalog-benchmarks">
      <summary>{translateInterface("Benchmark columns")} <span className="muted">({translateInterface("{count} selected", {count: format.number(benchmarks.length)})})</span></summary>
      <fieldset className="benchmark-toggle">
        <legend>{translateInterface("Benchmark columns")}</legend>
        {benchmarkDescriptors.map((benchmark) => (
          <label key={benchmark.id} title={benchmark.description}>
            <input type="checkbox" checked={benchmarks.includes(benchmark.id)} onChange={() => setBenchmarks((current) => current.includes(benchmark.id) ? current.filter((item) => item !== benchmark.id) : [...current, benchmark.id])} />
            {benchmark.label}
          </label>
        ))}
      </fieldset>
      </details>
      {data && (
        <p className="catalog-result-summary" aria-live="polite">
          {availability === "available"
            ? translateInterface("{value0} models available from your added providers", { value0: data.total })
            : translateInterface("{value0} models in the full catalog", { value0: data.total })}
        </p>
      )}

      {loading && !data ? <ModelSkeleton view={view} benchmarks={selectedDescriptors} /> : data?.items.length === 0 ? (
        <div className="card empty-state"><h2>{translateInterface("No matching models")}</h2><p className="muted">{translateInterface("Change the filters, or connect a provider to make its models available.")}</p><Link className="btn" href="/providers">{translateInterface("Manage providers")}</Link></div>
      ) : view === "grid" ? (
        <div className="model-grid">{data?.items.map((model) => <ModelCard key={model.id} model={model} benchmarks={selectedDescriptors} groups={groups} defaultGroup={defaultGroup} onChanged={loadGroups} />)}</div>
      ) : (
        <div className={`card table-scroll ${loading ? "is-refreshing" : ""}`}>
          <table className="model-table">
            <thead><tr><th>{translateInterface("Model")}</th><th>{translateInterface("Capabilities")}</th><th>{translateInterface("Context")}</th><th>{translateInterface("Input / output")}</th><th>{translateInterface("Providers")}</th>{selectedDescriptors.map((benchmark) => <th key={benchmark.id}>{benchmark.label}</th>)}</tr></thead>
            <tbody>{data?.items.map((model) => <ModelRow key={model.id} model={model} benchmarks={selectedDescriptors} groups={groups} defaultGroup={defaultGroup} onChanged={loadGroups} />)}</tbody>
          </table>
        </div>
      )}

      <div className="pagination" aria-label={translateInterface("Model pages")}>
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>{translateInterface("Previous")}</button>
        <span>{translateInterface("Page {page} of {pages} ({count} models)", {page: format.number(page), pages: format.number(pages), count: format.number(data?.total ?? 0)})}</span>
        <button type="button" disabled={page >= pages || loading} onClick={() => setPage((current) => current + 1)}>{translateInterface("Next")}</button>
      </div>
    </div>
  );
}

function ModelIdentity({ model, groups, defaultGroup, onChanged }: { model: CatalogModel; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  return <div className="model-identity"><ModelGroupStar model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} /><IconAvatar iconKey={model.modelIconKey ?? model.creatorIconKey} name={model.name} /><div><Link href={`/models/${encodeURIComponent(model.slug)}`}><strong>{model.name}</strong></Link></div></div>;
}

function ModelRow({ model, benchmarks, groups, defaultGroup, onChanged }: { model: CatalogModel; benchmarks: BenchmarkDescriptor[]; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();

  return <tr><td><ModelIdentity model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} />{model.releasedAt && <small className="muted">{translateInterface("Released {date}", {date: new Date(model.releasedAt).toLocaleDateString(translateInterface.locale)})}</small>}</td><td><CapabilityBadges model={model} /></td><td>{format.tokens(model.contextWindow)}</td><td><span>{format.price(model.referencePricing.input)}</span><span className="muted"> / {format.price(model.referencePricing.output)}</span></td><td><span className={model.available ? "success" : "muted"}>{model.availableProviderCount}</span> / {model.providerCount}</td>{benchmarks.map((benchmark) => <td key={benchmark.id}>{benchmarkScore(model.benchmarks.find((item) => item.benchmarkId === benchmark.id))}</td>)}</tr>;
}

function ModelCard({ model, benchmarks, groups, defaultGroup, onChanged }: { model: CatalogModel; benchmarks: BenchmarkDescriptor[]; groups: GroupSummary[]; defaultGroup: GroupDetail | null; onChanged: () => Promise<void> }) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();

  return <article className="card model-card"><ModelIdentity model={model} groups={groups} defaultGroup={defaultGroup} onChanged={onChanged} /><p className="model-description">{model.description || translateInterface("Provider-discovered model with no reference description.")}</p><CapabilityBadges model={model} /><dl><div><dt>{translateInterface("Context")}</dt><dd>{format.tokens(model.contextWindow)}</dd></div><div><dt>{translateInterface("Providers")}</dt><dd>{translateInterface("{available} available / {total}", {available: format.number(model.availableProviderCount), total: format.number(model.providerCount)})}</dd></div><div><dt>{translateInterface("Input price")}</dt><dd>{format.price(model.referencePricing.input)}</dd></div></dl><div className="benchmark-strip">{benchmarks.map((benchmark) => { const value = model.benchmarks.find((item) => item.benchmarkId === benchmark.id); return <span key={benchmark.id}><small>{benchmark.label}</small><strong>{benchmarkScore(value)}</strong></span>; })}</div></article>;
}

function CapabilityBadges({ model }: { model: CatalogModel }) {
  const translateInterface = usePointerTranslations();

  const active = Object.entries(model.capabilities).filter(([, enabled]) => enabled).map(([name]) => name);
  return <div className="badge-row">{active.length ? active.map((name) => <span className="badge" key={name}>{name}</span>) : <span className="muted">{translateInterface("Standard text")}</span>}</div>;
}

function ModelSkeleton({ view, benchmarks }: { view: "table" | "grid"; benchmarks: BenchmarkDescriptor[] }) {
  const translateInterface = usePointerTranslations();
  if (view === "table") return <TableSkeleton label={translateInterface("Loading models")} columns={[translateInterface("Model"), translateInterface("Capabilities"), translateInterface("Context"), translateInterface("Input / output"), translateInterface("Providers"), ...benchmarks.map(item => item.label)]} rows={8} />;
  return <LoadingSkeleton label={translateInterface("Loading models")}><div className="model-grid">{Array.from({ length: 8 }, (_, index) => <div className="card skeleton-card" key={index}><span className="skeleton line wide" /><span className="skeleton line" /><span className="skeleton block" /></div>)}</div></LoadingSkeleton>;
}
