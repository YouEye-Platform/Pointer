"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/Modal";
import Link from "next/link";

interface Instance {
  id: string;
  name: string;
  color: string;
  modelGroupId: string | null;
}
interface Group {
  id: string;
  name: string;
}

export default function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [i, g] = await Promise.all([api.get<Instance[]>("/api/instances"), api.get<Group[]>("/api/groups")]);
      setInstances(i);
      setGroups(g);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    if (!confirm(`Delete instance "${id}"? Its API keys are removed too.`)) return;
    try {
      await api.del(`/api/instances/${id}`);
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  const groupName = (id: string | null) => (id ? groups.find((g) => g.id === id)?.name ?? id : "—");

  return (
    <div>
      <div className="spread page-head">
        <div>
          <h1>Instances</h1>
          <p className="muted">Workspaces that scope which models an API key can reach.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          New instance
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card table-scroll">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : instances.length === 0 ? (
          <p className="muted">No instances yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Model group</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.id}</td>
                  <td><Link href={`/instances/${encodeURIComponent(i.id)}`}><strong>{i.name}</strong></Link></td>
                  <td>{groupName(i.modelGroupId)}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn-sm" href={`/instances/${encodeURIComponent(i.id)}`}>Details</Link>{" "}
                    <button className="btn-sm btn-danger" onClick={() => remove(i.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateInstanceModal
          groups={groups}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateInstanceModal({
  groups,
  onClose,
  onCreated,
}: {
  groups: Group[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [modelGroupId, setModelGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/instances", { name, modelGroupId: modelGroupId || undefined });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New instance" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-instance-name">Name</label>
          <input id="new-instance-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="new-instance-group">Model group (optional — defaults to your default group)</label>
          <select id="new-instance-group" value={modelGroupId} onChange={(e) => setModelGroupId(e.target.value)}>
            <option value="">Default group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
