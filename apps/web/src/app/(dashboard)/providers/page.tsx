"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/Modal";
import { IconAvatar } from "@/components/IconAvatar";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/store";

interface Provider {
  id: string;
  name: string;
  type: string;
  status: string;
  hasOwnKey: boolean;
  modelCount: number;
  iconKey?: string;
  balance?: { supported: boolean; value?: number | null; updatedAt?: string | null };
  rateLimits?: { supported: boolean; updatedAt?: string | null };
}
interface Manifest {
  id: string;
  name: string;
  iconKey?: string;
  type: string;
  auth?: {
    type: string;
    keyPrefix?: string;
    connectLabel?: string;
    deviceFlowSupported?: boolean;
  };
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const user = useAuth((state) => state.user);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, m] = await Promise.all([
        api.get<Provider[]>("/api/providers"),
        api.get<Manifest[]>("/api/providers/manifests"),
      ]);
      setProviders(p);
      setManifests(m);
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
    if (!confirm(`Remove provider "${id}"? This deletes its stored key.`)) return;
    try {
      await api.del(`/api/providers/${id}`);
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  return (
    <div>
      <div className="spread page-head">
        <div>
          <h1>Providers</h1>
          <p className="muted">Active model providers and their account credentials.</p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          Add provider
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card table-scroll">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : providers.length === 0 ? (
          <p className="muted">No providers yet. Add one from a manifest to start routing models.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Models</th>
                <th>Credential</th>
                <th>Balance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td><div className="model-identity"><IconAvatar iconKey={p.iconKey || p.id.split("-")[0]} name={p.name} /><div><Link href={`/providers/${encodeURIComponent(p.id)}`}><strong>{p.name}</strong></Link><div className="mono muted raw-id">{p.id}</div></div></div></td>
                  <td>
                    <span className="badge">{p.type}</span>
                  </td>
                  <td>{p.modelCount}</td>
                  <td>{p.hasOwnKey ? <span className="success">✓ connected</span> : <span className="muted">none</span>}</td>
                  <td>{p.balance?.supported ? (p.balance.value == null ? "Unknown" : `$${p.balance.value.toFixed(2)}`) : <span className="muted">Not supported</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    <Link className="btn-sm" href={`/providers/${encodeURIComponent(p.id)}`}>Details</Link>{" "}
                    {user?.role === "admin" && (
                    <button className="btn-sm btn-danger" onClick={() => remove(p.id)}>
                      Remove
                    </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding && (
        <AddProviderModal
          manifests={manifests}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddProviderModal({
  manifests,
  onClose,
  onAdded,
}: {
  manifests: Manifest[];
  onClose: () => void;
  onAdded: (providerId: string) => void;
}) {
  const router = useRouter();
  const [manifestId, setManifestId] = useState(manifests[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = manifests.find((manifest) => manifest.id === manifestId);
  const isOAuth =
    selected?.auth?.type === "oauth-device-flow"
    || selected?.auth?.type === "oauth-pkce";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const added = await api.post<{ id: string }>(
        "/api/providers/from-manifest",
        isOAuth ? { manifestId } : { manifestId, apiKey, ...(label.trim() ? { label: label.trim() } : {}) }
      );
      onAdded(added.id);
      if (isOAuth) {
        router.push(`/providers/${encodeURIComponent(added.id)}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add provider" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="provider-manifest">Manifest</label>
          <select id="provider-manifest" value={manifestId} onChange={(e) => setManifestId(e.target.value)}>
            {manifests.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>
        </div>
        {isOAuth ? (
          <div className="notice">
            This provider connects through a browser sign-in. No password or
            subscription token is entered into Pointer.
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="provider-api-key">API key</label>
              <input
                id="provider-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selected?.auth?.keyPrefix
                  ? `${selected.auth.keyPrefix}…`
                  : "provider API key"}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="provider-key-label">Nickname <span className="muted">(optional)</span></label>
              <input id="provider-key-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={selected?.name ? `${selected.name} account` : "Work, personal…"} />
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Adding…" : isOAuth ? "Add and continue" : "Add provider"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
