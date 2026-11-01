"use client";
import { usePointerTranslations } from "@/lib/i18n";
import { TableSkeleton } from "@/components/LoadingSkeleton";
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

export function InstanceApiKeys({ instanceId, instanceName }: { instanceId: string; instanceName: string }) {
  const translateInterface = usePointerTranslations();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const detail = await api.get<{ keys: ApiKey[] }>(`/api/instances/${encodeURIComponent(instanceId)}`);
      setKeys(detail.keys);
    } catch (err) {
      setError(translateInterface("Failed to load"));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api.del(`/api/keys/${encodeURIComponent(id)}`);
      setRevoking(null);
      await load();
    } catch (err) {
      setError(translateInterface("Revoke failed"));
    } finally { setBusy(false); }
  }


  return (
    <section className="instance-keys" id="api-keys" aria-labelledby="instance-keys-title">
      <div className="section-head">
        <div>
          <h2 id="instance-keys-title">{translateInterface("API keys")}</h2>
          <p className="muted">
            {translateInterface("Keys for {instance}. Use them to authenticate requests to {endpoint}.", {instance: instanceName, endpoint: "/v1/*"})}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          {translateInterface("New key")}
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card table-scroll">
        {loading ? (
          <TableSkeleton label={translateInterface("Loading instance API keys")} bare columns={[translateInterface("Name"), translateInterface("Key"), translateInterface("Requests"), translateInterface("Status"), ""]} />
        ) : keys.length === 0 ? (
          <p className="muted">{translateInterface("No API keys yet.")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{translateInterface("Name")}</th>
                <th>{translateInterface("Key")}</th>
                <th>{translateInterface("Requests")}</th>
                <th>{translateInterface("Status")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><Link href={`/keys/${encodeURIComponent(k.id)}`}><strong>{k.name}</strong></Link></td>
                  <td className="mono">{k.keyPreview}</td>
                  <td>{new Intl.NumberFormat(translateInterface.locale).format(k.requestCount)}</td>
                  <td>{k.revoked ? <span className="error">{translateInterface("revoked")}</span> : <span className="success">{translateInterface("active")}</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn-sm" href={`/keys/${encodeURIComponent(k.id)}`}>{translateInterface("Details")}</Link>{" "}
                    {!k.revoked && (
                      <button className="btn-sm btn-danger" onClick={() => setRevoking(k)}>
                        {translateInterface("Revoke")}
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
          instanceId={instanceId}
          instanceName={instanceName}
          onClose={() => setCreating(false)}
          onCreated={(rawKey) => {
            setCreating(false);
            setNewKey(rawKey);
            setCopyNotice("");
            load();
          }}
        />
      )}

      {newKey && (
        <Modal title={translateInterface("API key created")} onClose={() => setNewKey(null)}>
          <p className="muted" style={{ marginBottom: 10 }}>
            {translateInterface("Copy this key now — it is stored only as a hash and cannot be shown again.")}
          </p>
          <div className="card mono" style={{ wordBreak: "break-all", background: "var(--bg)" }}>
            {newKey}
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn-primary" onClick={() => {
              if (!navigator.clipboard) { setCopyNotice(translateInterface("Copy is unavailable in this browser. Select the key to copy it.")); return; }
              void navigator.clipboard.writeText(newKey).then(() => setCopyNotice(translateInterface("Key copied.")))
                .catch(() => setCopyNotice(translateInterface("Copy failed. Select the key to copy it.")));
            }}>
              {translateInterface("Copy")}
            </button>
            <button onClick={() => setNewKey(null)}>{translateInterface("Done")}</button>
          </div>
          <p role="status" className="muted">{copyNotice}</p>
        </Modal>
      )}
      {revoking && <Modal title={translateInterface("Revoke {name}?", {name: revoking.name})} onClose={() => { if (!busy) setRevoking(null); }}>
        <p>{translateInterface("This key for {instance} will stop accepting requests immediately. Existing request history is kept.", {instance: instanceName})}</p>
        <div className="row dialog-actions">
          <button disabled={busy} onClick={() => setRevoking(null)}>{translateInterface("Cancel")}</button>
          <button className="btn-danger" disabled={busy} onClick={() => void revoke(revoking.id)}>{busy ? translateInterface("Revoking…") : translateInterface("Revoke key")}</button>
        </div>
      </Modal>}
    </section>
  );
}

function CreateKeyModal({
  instanceId,
  instanceName,
  onClose,
  onCreated,
}: {
  instanceId: string;
  instanceName: string;
  onClose: () => void;
  onCreated: (rawKey: string) => void;
}) {
  const translateInterface = usePointerTranslations();
  const [name, setName] = useState("");
  const [allowed, setAllowed] = useState("*");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
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
      setError(translateInterface("Failed to create key"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={translateInterface("New API key")} onClose={() => { if (!busy) onClose(); }}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-key-name">{translateInterface("Name")}</label>
          <input id="new-key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={translateInterface("e.g. laptop")} required autoFocus />
        </div>
        <p className="muted">{translateInterface("Instance: {name}", {name: instanceName})}</p>
        <div className="field">
          <label htmlFor="new-key-models">{translateInterface("Allowed models (comma-separated globs, default *)")}</label>
          <input id="new-key-models" value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="*" />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" disabled={busy} onClick={onClose}>
            {translateInterface("Cancel")}
          </button>
          <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? translateInterface("Creating…") : translateInterface("Create key")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
