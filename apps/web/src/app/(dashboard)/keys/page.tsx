"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/Modal";
import Link from "next/link";

interface ApiKey {
  id: string;
  name: string;
  keyPreview: string;
  instanceId: string;
  requestCount: number;
  revoked: boolean;
}
interface Instance {
  id: string;
  name: string;
}

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [k, i] = await Promise.all([api.get<ApiKey[]>("/api/keys"), api.get<Instance[]>("/api/instances")]);
      setKeys(k);
      setInstances(i);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string) {
    if (!confirm("Revoke this key? It will stop working immediately.")) return;
    try {
      await api.del(`/api/keys/${id}`);
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Revoke failed");
    }
  }

  const instanceName = (id: string) => instances.find((i) => i.id === id)?.name ?? id;

  return (
    <div>
      <div className="spread page-head">
        <div>
          <h1>API Keys</h1>
          <p className="muted">
            <code>ptr_</code> keys authenticate proxy requests to <code>/v1/*</code>.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)} disabled={instances.length === 0}>
          New key
        </button>
      </div>

      {instances.length === 0 && !loading && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Create an instance first — every key is bound to one.
        </p>
      )}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card table-scroll">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="muted">No API keys yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Instance</th>
                <th>Requests</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><Link href={`/keys/${encodeURIComponent(k.id)}`}><strong>{k.name}</strong></Link></td>
                  <td className="mono">{k.keyPreview}</td>
                  <td>{instanceName(k.instanceId)}</td>
                  <td>{k.requestCount}</td>
                  <td>{k.revoked ? <span className="error">revoked</span> : <span className="success">active</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn-sm" href={`/keys/${encodeURIComponent(k.id)}`}>Details</Link>{" "}
                    {!k.revoked && (
                      <button className="btn-sm btn-danger" onClick={() => revoke(k.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateKeyModal
          instances={instances}
          onClose={() => setCreating(false)}
          onCreated={(rawKey) => {
            setCreating(false);
            setNewKey(rawKey);
            load();
          }}
        />
      )}

      {newKey && (
        <Modal title="API key created" onClose={() => setNewKey(null)}>
          <p className="muted" style={{ marginBottom: 10 }}>
            Copy this key now — it is stored only as a hash and cannot be shown again.
          </p>
          <div className="card mono" style={{ wordBreak: "break-all", background: "var(--bg)" }}>
            {newKey}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn-primary" onClick={() => navigator.clipboard?.writeText(newKey).catch(() => {})}>
              Copy
            </button>
            <button onClick={() => setNewKey(null)}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateKeyModal({
  instances,
  onClose,
  onCreated,
}: {
  instances: Instance[];
  onClose: () => void;
  onCreated: (rawKey: string) => void;
}) {
  const [name, setName] = useState("");
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? "");
  const [allowed, setAllowed] = useState("*");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const allowedModels = allowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.post<{ key: string }>("/api/keys", {
        name: name || "API Key",
        instanceId,
        allowedModels: allowedModels.length ? allowedModels : ["*"],
      });
      onCreated(res.key);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New API key" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-key-name">Name</label>
          <input id="new-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" autoFocus />
        </div>
        <div className="field">
          <label htmlFor="new-key-instance">Instance</label>
          <select id="new-key-instance" value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.id})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="new-key-models">Allowed models (comma-separated globs, default *)</label>
          <input id="new-key-models" value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="*" />
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
