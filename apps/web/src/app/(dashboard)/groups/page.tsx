"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { api, ApiError } from "@/lib/api";
import type { GroupSummary } from "@/lib/groups";
import { IconAvatar } from "@/components/IconAvatar";

export default function GroupsPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setGroups(await api.get<GroupSummary[]>("/api/groups"));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to load groups");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setDefault(group: GroupSummary) {
    setError("");
    try {
      await api.put(`/api/groups/${encodeURIComponent(group.id)}/set-default`);
      setStatus(`${group.name} is now the default group.`);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to set default group");
    }
  }

  async function remove(group: GroupSummary) {
    if (!confirm(`Delete ${group.name}? Its model entries will be removed.`)) return;
    setError("");
    try {
      await api.del(`/api/groups/${encodeURIComponent(group.id)}`);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to delete group");
    }
  }

  return (
    <div>
      <div className="spread page-head">
        <div>
          <p className="eyebrow">Routing collections</p>
          <h1>Model Groups</h1>
          <p className="muted">Choose exact model and provider routes, then link groups to instances.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>New group</button>
      </div>
      <p className="sr-only" aria-live="polite">{status}</p>
      {error && <div className="notice danger" role="alert">{error}</div>}
      {error && !loading && <button className="btn-sm" onClick={load}>Retry</button>}
      {loading ? (
        <div className="model-grid" aria-label="Loading groups">{Array.from({ length: 3 }, (_, index) => <div className="card skeleton-card" key={index}><span className="skeleton line wide" /><span className="skeleton line" /></div>)}</div>
      ) : groups.length === 0 ? (
        <div className="card empty-state"><h2>No model groups</h2><p className="muted">Create a group to organize provider-backed models.</p></div>
      ) : (
        <div className="group-grid">
          {groups.map((group) => (
            <article className="card group-card" key={group.id}>
              <Link className="group-card-main" href={`/groups/${encodeURIComponent(group.id)}`} aria-label={`Open ${group.name}`}>
              <div className="spread">
                <div>
                  <h2>{group.name}</h2>
                  <p className="muted">{group.entryCount} models · {group.enabledEntryCount} enabled</p>
                </div>
                {group.isDefault && <span className="badge default-badge">★ Default</span>}
              </div>
              <div className="group-card-models">
                {group.previewEntries.map((entry) => <span key={entry.id}><IconAvatar iconKey={entry.modelIconKey} name={entry.modelName} size={22} />{entry.alias || entry.modelName}</span>)}
                {group.enabledEntryCount > group.previewEntries.length && <span className="muted">+{group.enabledEntryCount - group.previewEntries.length} more</span>}
              </div>
              </Link>
              <div className="row">
                {!group.isDefault && <button className="btn-sm" onClick={() => setDefault(group)}>Set as default</button>}
                <button className="btn-sm btn-danger" disabled={group.isDefault} title={group.isDefault ? "The default group cannot be deleted" : "Delete group"} onClick={() => remove(group)}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {creating && <CreateGroupModal onClose={() => setCreating(false)} onCreated={(group) => {
        setCreating(false);
        router.push(`/groups/${encodeURIComponent(group.id)}`);
      }} />}
    </div>
  );
}

function CreateGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (group: GroupSummary) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(await api.post<GroupSummary>("/api/groups", { name }));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Failed to create group");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="New model group" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field"><label htmlFor="group-name">Name</label><input id="group-name" autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}><button type="button" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create group"}</button></div>
      </form>
    </Modal>
  );
}
