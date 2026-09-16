"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { Modal } from "@/components/Modal";
import { api, ApiError } from "@/lib/api";
import { formatPrice, formatTokens, type CatalogDetailResponse, type CatalogListResponse, type CatalogModel } from "@/lib/catalog";
import type { GroupDetail, GroupEntry } from "@/lib/groups";

export default function GroupDetailPage() {
  const id = decodeURIComponent(String(useParams<{ id: string }>().id));
  const router = useRouter();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [changingProvider, setChangingProvider] = useState<GroupEntry | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setGroup(await api.get<GroupDetail>(`/api/groups/${encodeURIComponent(id)}`));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to load group");
      setGroup(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function setDefault() {
    setBusy("default");
    try {
      await api.put(`/api/groups/${encodeURIComponent(id)}/set-default`);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to set default group");
    } finally {
      setBusy("");
    }
  }

  async function rename(name: string) {
    if (!group || name === group.name) {
      setRenaming(false);
      return;
    }
    setBusy("rename");
    try {
      await api.put(`/api/groups/${encodeURIComponent(id)}`, { name });
      await load();
      setRenaming(false);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to rename group");
    } finally {
      setBusy("");
    }
  }

  async function removeGroup() {
    if (!group || group.isDefault || !confirm(`Delete ${group.name}?`)) return;
    setBusy("delete");
    try {
      await api.del(`/api/groups/${encodeURIComponent(id)}`);
      router.push("/groups");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to delete group");
      setBusy("");
    }
  }

  async function updateEntry(entry: GroupEntry, changes: { alias?: string | null; enabled?: boolean; providerModelKey?: string; providerAccountId?: string }) {
    setBusy(entry.id);
    setError("");
    try {
      await api.put(`/api/groups/${encodeURIComponent(id)}/entries/${encodeURIComponent(entry.id)}`, changes);
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to update model");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function removeEntry(entry: GroupEntry) {
    if (!confirm(`Remove ${entry.modelName} from ${group?.name}?`)) return;
    setBusy(entry.id);
    try {
      await api.del(`/api/groups/${encodeURIComponent(id)}/entries/${encodeURIComponent(entry.id)}`);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to remove model");
    } finally {
      setBusy("");
    }
  }

  async function move(entryId: string, delta: -1 | 1) {
    if (!group) return;
    const ids = group.entries.map((entry) => entry.id);
    const from = ids.indexOf(entryId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setBusy("reorder");
    try {
      await api.put(`/api/groups/${encodeURIComponent(id)}/entries/reorder`, { entryIds: ids });
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to reorder models");
      await load();
    } finally {
      setBusy("");
    }
  }

  if (loading) return <div className="detail-skeleton"><span className="skeleton line wide" /><span className="skeleton block" /></div>;
  if (!group) return <div><Link href="/groups" className="back-link">Back to groups</Link><div className="notice danger" role="alert">{error || "Group not found"}</div></div>;

  return (
    <div>
      <Link href="/groups" className="back-link">Back to groups</Link>
      <div className="spread page-head">
        <div>
          <p className="eyebrow">Model group</p>
          <div className="row"><h1>{group.name}</h1>{group.isDefault && <span className="badge default-badge">★ Default</span>}</div>
          <p className="muted">{group.entries.length} models · {group.entries.filter((entry) => entry.enabled).length} enabled</p>
        </div>
        <div className="row">
          {!group.isDefault && <button disabled={busy === "default"} onClick={setDefault}>Set as default</button>}
          <button disabled={busy === "rename"} onClick={() => setRenaming(true)}>Rename</button>
          <button className="btn-primary" onClick={() => setAdding(true)}>Add model</button>
          <button className="btn-danger" disabled={group.isDefault || busy === "delete"} title={group.isDefault ? "The default group cannot be deleted" : "Delete group"} onClick={removeGroup}>Delete</button>
        </div>
      </div>
      <div className="notice" role="note"><strong>Automatic routing aliases:</strong> the first enabled model receives big / opus / default, the second medium / sonnet / secondary, and the third small / haiku / utility. They are accepted by the gateway but not listed by the models API.</div>
      {error && <div className="notice danger" role="alert">{error}</div>}
      {group.entries.length === 0 ? (
        <div className="card empty-state"><h2>No models in this group</h2><p className="muted">Add an available model to establish the first routing slot.</p><button className="btn-primary" onClick={() => setAdding(true)}>Add model</button></div>
      ) : (
        <div className="card table-scroll">
          <table className="group-entry-table">
            <thead><tr><th>Position</th><th>Model</th><th>Provider</th><th>Alias</th><th>Enabled</th><th>Hidden routes</th><th>Price / context</th><th></th></tr></thead>
            <tbody>
              {group.entries.map((entry, index) => (
                <tr key={entry.id} className={!entry.enabled ? "disabled-row" : ""}>
                  <td><div className="row compact"><strong>{index + 1}</strong><button className="btn-sm" aria-label={`Move ${entry.modelName} up`} disabled={index === 0 || busy === "reorder"} onClick={() => move(entry.id, -1)}>↑</button><button className="btn-sm" aria-label={`Move ${entry.modelName} down`} disabled={index === group.entries.length - 1 || busy === "reorder"} onClick={() => move(entry.id, 1)}>↓</button></div></td>
                  <td><div className="model-identity"><IconAvatar iconKey={entry.modelIconKey} name={entry.modelName} /><div><strong>{entry.modelName}</strong>{entry.creator && <small className="muted">{entry.creator}</small>}{entry.needsReview && <span className="badge danger">Needs review</span>}</div></div></td>
                  <td><div className="model-identity"><IconAvatar iconKey={entry.providerIconKey} name={entry.providerName} /><div><strong>{entry.providerName}</strong><small className="mono muted" title={entry.rawModelId}>{entry.rawModelId}</small>{!entry.providerAvailable && <span className="error">Provider not added</span>} {entry.catalogEntityId && <button className="btn-sm provider-change-button" disabled={busy === entry.id} onClick={() => setChangingProvider(entry)}>Change provider</button>}</div></div></td>
                  <td><input aria-label={`Alias for ${entry.modelName}`} defaultValue={entry.alias ?? ""} disabled={busy === entry.id} onBlur={(event) => {
                    const value = event.target.value.trim() || null;
                    if (value !== entry.alias) updateEntry(entry, { alias: value });
                  }} /></td>
                  <td><input className="checkbox" type="checkbox" checked={entry.enabled} disabled={busy === entry.id} aria-label={`Enable ${entry.modelName}`} onChange={(event) => updateEntry(entry, { enabled: event.target.checked })} /></td>
                  <td><div className="badge-row">{entry.hiddenAliases.length ? entry.hiddenAliases.map((alias) => <span className="badge" key={alias}>{alias}</span>) : <span className="muted">—</span>}</div></td>
                  <td>{formatPrice(entry.inputPrice == null ? null : Number(entry.inputPrice))} / {formatPrice(entry.outputPrice == null ? null : Number(entry.outputPrice))}<small className="muted">{formatTokens(entry.contextWindow)} context</small></td>
                  <td><button className="btn-sm btn-danger" disabled={busy === entry.id} onClick={() => removeEntry(entry)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddModelModal group={group} onClose={() => setAdding(false)} onAdded={async () => { setAdding(false); await load(); }} />}
      {renaming && <RenameGroupModal group={group} busy={busy === "rename"} onClose={() => setRenaming(false)} onRename={rename} />}
      {changingProvider && <ChangeProviderModal
        entry={changingProvider}
        onClose={() => setChangingProvider(null)}
        onChange={async (providerModelKey, providerAccountId) => {
          const updated = await updateEntry(changingProvider, { providerModelKey, providerAccountId });
          if (updated) setChangingProvider(null);
          return updated;
        }}
      />}
    </div>
  );
}

function AddModelModal({ group, onClose, onAdded }: { group: GroupDetail; onClose: () => void; onAdded: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [providerModelKey, setProviderModelKey] = useState("");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [alias, setAlias] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
      setModels([]);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      availability: "available",
      sort: "recommended",
      order: "asc",
      page: String(page),
      pageSize: "50",
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    setLoading(true);
    setError("");
    api.get<CatalogListResponse>(`/api/catalog?${params}`).then((result) => {
      if (!cancelled) {
        setModels((current) => page === 1 ? result.items : [
          ...current,
          ...result.items.filter((model) => !current.some((existing) => existing.id === model.id)),
        ]);
        setTotal(result.total);
      }
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Failed to load models");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [debouncedSearch, page, reloadKey]);

  function choose(model: CatalogModel) {
    setSelected(model);
    const providers = model.providers.filter((provider) => provider.available);
    setProviderModelKey(providers.length === 1 ? providers[0].providerModelKey : "");
    const accounts = providers.length === 1 ? providers[0].accounts : [];
    setProviderAccountId(accounts.length === 1 ? accounts[0].id : "");
    setAlias("");
    setError("");
  }

  async function add() {
    if (!selected || !providerModelKey || !providerAccountId) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/groups/${encodeURIComponent(group.id)}/entries`, {
        catalogEntityId: selected.id,
        providerModelKey,
        providerAccountId,
        ...(alias.trim() ? { alias: alias.trim() } : {}),
      });
      await onAdded();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to add model");
    } finally {
      setBusy(false);
    }
  }

  const duplicateCanonical = selected ? group.entries.some((entry) => entry.catalogEntityId === selected.id) : false;
  return (
    <Modal title={selected ? `Choose provider for ${selected.name}` : "Add model"} onClose={onClose}>
      {!selected ? (
        <div>
          <div className="field"><label htmlFor="group-model-search">Search available models</label><input id="group-model-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Claude, GPT, Gemini…" /></div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="group-model-results" aria-busy={loading}>
            {loading && models.length === 0 ? <p className="muted">Loading models…</p> : models.length === 0 ? <p className="muted">No matching available models.</p> : models.map((model) => {
              const added = group.entries.some((entry) => entry.catalogEntityId === model.id);
              return <button type="button" key={model.id} onClick={() => choose(model)}><IconAvatar iconKey={model.modelIconKey ?? model.creatorIconKey} name={model.name} /><span><strong>{model.name}</strong><small>{model.creator || "Unknown creator"} · {model.availableProviderCount} available provider{model.availableProviderCount === 1 ? "" : "s"}</small></span><span>{added ? "Add another route" : "Choose"}</span></button>;
            })}
          </div>
          {models.length < total && <button className="group-load-more" type="button" disabled={loading} onClick={() => setPage((value) => value + 1)}>{loading ? "Loading…" : "Load more models"}</button>}
          {error && <button className="btn-sm" type="button" onClick={() => setReloadKey((value) => value + 1)}>Retry</button>}
        </div>
      ) : (
        <div>
          <button className="btn-sm" type="button" onClick={() => { setSelected(null); setProviderModelKey(""); setProviderAccountId(""); setAlias(""); }}>← Back to models</button>
          <div className="field"><label htmlFor="group-model-provider">Provider route</label><select id="group-model-provider" autoFocus value={providerModelKey} onChange={(event) => { const next = event.target.value; setProviderModelKey(next); const accounts = selected.providers.find((provider) => provider.providerModelKey === next)?.accounts ?? []; setProviderAccountId(accounts.length === 1 ? accounts[0].id : ""); }}><option value="">Choose provider</option>{selected.providers.filter((provider) => provider.available).map((provider) => <option key={provider.providerModelKey} value={provider.providerModelKey}>{provider.providerName} · {provider.rawModelId}</option>)}</select></div>
          {providerModelKey && <div className="field"><label htmlFor="group-model-account">Account</label><select id="group-model-account" value={providerAccountId} onChange={(event) => setProviderAccountId(event.target.value)}><option value="">Choose account</option>{(selected.providers.find((provider) => provider.providerModelKey === providerModelKey)?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.nickname || account.id.slice(-6)}</option>)}</select></div>}
          <div className="field"><label htmlFor="group-model-alias">Public alias{duplicateCanonical ? " (required for another route)" : " (optional)"}</label><input id="group-model-alias" value={alias} onChange={(event) => setAlias(event.target.value)} required={duplicateCanonical} placeholder={duplicateCanonical ? `A unique name for this ${selected.name} route` : selected.name} /></div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row" style={{ justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!providerModelKey || !providerAccountId || (duplicateCanonical && !alias.trim()) || busy} onClick={add}>{busy ? "Adding…" : "Add to group"}</button></div>
        </div>
      )}
    </Modal>
  );
}

function RenameGroupModal({
  group,
  busy,
  onClose,
  onRename,
}: {
  group: GroupDetail;
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  return (
    <Modal title={`Rename ${group.name}`} onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = name.trim();
        if (value) void onRename(value);
      }}>
        <div className="field"><label htmlFor="rename-group">Group name</label><input id="rename-group" maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="row modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save name"}</button></div>
      </form>
    </Modal>
  );
}

function ChangeProviderModal({
  entry,
  onClose,
  onChange,
}: {
  entry: GroupEntry;
  onClose: () => void;
  onChange: (providerModelKey: string, providerAccountId: string) => Promise<boolean>;
}) {
  const [detail, setDetail] = useState<CatalogDetailResponse | null>(null);
  const initialChoice = entry.providerModelKey && entry.providerAccountId
    ? `${entry.providerModelKey}\u0000${entry.providerAccountId}`
    : "";
  const [routeChoice, setRouteChoice] = useState(initialChoice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!entry.catalogEntityId) return;
    let cancelled = false;
    api.get<CatalogDetailResponse>(`/api/catalog/detail?slug=${encodeURIComponent(entry.catalogEntityId)}`)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Failed to load provider routes");
      });
    return () => { cancelled = true; };
  }, [entry.catalogEntityId]);

  const available = (detail?.providers.filter((provider) => provider.available) ?? []).flatMap((provider) =>
    provider.accounts.map((account) => ({
      providerModelKey: provider.providerModelKey,
      providerAccountId: account.id,
      label: `${provider.providerName} · ${account.nickname || account.id.slice(-6)} · ${provider.rawModelId}`,
    })),
  );
  return (
    <Modal title={`Provider for ${entry.modelName}`} onClose={onClose}>
      {!detail && !error ? <p className="muted">Loading available providers…</p> : (
        <div className="field">
          <label htmlFor="change-entry-provider">Provider</label>
          <select id="change-entry-provider" autoFocus value={routeChoice} onChange={(event) => setRouteChoice(event.target.value)}>
            <option value="">Choose provider account</option>
            {available.map((route) => <option key={`${route.providerModelKey}:${route.providerAccountId}`} value={`${route.providerModelKey}\u0000${route.providerAccountId}`}>{route.label}</option>)}
          </select>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {detail && available.length === 0 && <p className="muted">Add a provider offering this model before changing its route.</p>}
      <div className="row modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="btn-primary" type="button" disabled={busy || !routeChoice || routeChoice === initialChoice} onClick={async () => {
        setBusy(true);
        setError("");
        try {
          const [providerModelKey, providerAccountId] = routeChoice.split("\u0000");
          const updated = await onChange(providerModelKey!, providerAccountId!);
          if (!updated) setError("The provider could not be changed. Review the group error and try again.");
        } catch (reason) {
          setError(reason instanceof ApiError ? reason.message : "Failed to change provider");
        } finally {
          setBusy(false);
        }
      }}>{busy ? "Updating…" : "Update provider"}</button></div>
    </Modal>
  );
}
