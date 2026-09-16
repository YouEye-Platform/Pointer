"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { BenchmarkDescriptor, SourceState } from "@/lib/catalog";

interface Overview {
  counts: { users: number; providers: number; instances: number; apiKeys: number; usageRows: number };
  users: Array<{ id: string; name: string; email: string; role: string; createdAt: string }>;
  providers: Array<{ id: string; name: string; status: string; updatedAt: string }>;
}

interface Setting {
  key: string;
  value: string;
  updatedAt: string;
}

interface BenchmarkSource extends BenchmarkDescriptor {
  optionalCredential: boolean;
  hasCredential: boolean | null;
  state: SourceState | null;
}

interface BenchmarkSourcesResponse {
  contractVersion: "1";
  sources: BenchmarkSource[];
}

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [benchmarkSources, setBenchmarkSources] = useState<BenchmarkSource[]>([]);
  const [artificialAnalysisKey, setArtificialAnalysisKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cleanup, setCleanup] = useState<unknown>(null);
  async function maintenance(run: boolean) {
    setBusy(true); setError("");
    try { setCleanup(run ? await api.post("/api/admin/catalog/cleanup") : await api.get("/api/admin/catalog/cleanup")); }
    catch (e) { setError(e instanceof Error ? e.message : "Maintenance failed"); }
    finally { setBusy(false); }
  }

  async function load() {
    try {
      const [summary, rows, benchmarkSourceResponse] = await Promise.all([
        api.get<Overview>("/api/admin/overview"),
        api.get<Setting[]>("/api/admin/settings"),
        api.get<BenchmarkSourcesResponse>("/api/admin/benchmark-sources"),
      ]);
      setOverview(summary);
      setSettings(Object.fromEntries(rows.map((row) => [row.key, row.value])));
      setBenchmarkSources(benchmarkSourceResponse.sources);
      setError("");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Admin data failed");
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveSettings() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.put("/api/admin/settings", { settings: Object.fromEntries(Object.entries(settings).filter(([,v])=>v!=="")) });
      setMessage("Settings saved.");
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Settings failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveArtificialAnalysisCredential() {
    const apiKey = artificialAnalysisKey;
    setArtificialAnalysisKey("");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.put("/api/admin/benchmark-sources/artificial-analysis/credential", { apiKey });
      setMessage("Artificial Analysis enabled. The key was validated, encrypted, and the catalog was refreshed.");
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Artificial Analysis setup failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeArtificialAnalysisCredential() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.del("/api/admin/benchmark-sources/artificial-analysis/credential");
      setArtificialAnalysisKey("");
      setMessage("Artificial Analysis disabled. Its stored credential and active ranking evidence were removed.");
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Artificial Analysis removal failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !overview) return <div className="notice danger" role="alert">{error}</div>;
  if (!overview) return <div>Loading admin overview...</div>;

  const artificialAnalysis = benchmarkSources.find((source) => source.id === "artificial-analysis");

  return (
    <div>
      <div className="page-head">
        <p className="eyebrow">Restricted operations</p>
        <h1>Admin</h1>
        <p className="muted">Global settings and benchmark sources. Credentials are write-only and are never returned to the browser.</p>
      </div>

      {error && <div className="notice danger" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}

      <div className="kpi-grid">
        {Object.entries(overview.counts).map(([key, value]) => <article className="card" key={key}><small>{key}</small><strong>{value}</strong></article>)}
      </div>
      <section className="card" style={{marginTop:24}}>
        <h2>Catalog maintenance</h2>
        <p className="muted">Preserves active, rollback and in-progress generations. Retired generations are disposable; failed diagnostics default to seven days / fifty generations. Cleanup is bounded and retryable.</p>
        <button disabled={busy} onClick={() => void maintenance(false)}>Refresh cleanup status</button>{" "}
        <button disabled={busy} onClick={() => void maintenance(true)}>Run bounded cleanup</button>
        {cleanup != null && <pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(cleanup,null,2)}</pre>}
      </section>

      <div className="detail-grid" style={{ marginTop: 24 }}>
        <section className="card">
          <h2>Settings</h2>
          {["source_refresh_hours", "balance_refresh_minutes", "usage_retention_days", "catalog_diagnostic_days"].map((key) => (
            <div className="field" key={key}>
              <label htmlFor={`setting-${key}`}>{key.replaceAll("_", " ")}</label>
              <input id={`setting-${key}`} inputMode="numeric" value={settings[key] || ""} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} placeholder="Default" />
            </div>
          ))}
          <button type="button" className="btn-primary" disabled={busy} onClick={saveSettings}>Save settings</button>
        </section>

        <section className="card">
          <p className="eyebrow">Optional benchmark source</p>
          <div className="spread">
            <h2>Artificial Analysis</h2>
            <span className={`badge ${artificialAnalysis?.hasCredential ? "success" : ""}`}>
              {artificialAnalysis?.hasCredential ? "Enabled" : "Not configured"}
            </span>
          </div>
          <p className="muted">Add a server-side API key to use Artificial Analysis as the preferred model order. Without it, Pointer automatically falls back to BenchLM and LMArena.</p>
          <div className="field">
            <label htmlFor="artificial-analysis-api-key">Artificial Analysis API key</label>
            <input
              id="artificial-analysis-api-key"
              type="password"
              autoComplete="off"
              value={artificialAnalysisKey}
              onChange={(event) => setArtificialAnalysisKey(event.target.value)}
              placeholder={artificialAnalysis?.hasCredential ? "Enter a replacement key" : "Paste API key"}
            />
          </div>
          <div className="button-row">
            <button type="button" className="btn-primary" disabled={busy || artificialAnalysisKey.trim().length < 8} onClick={saveArtificialAnalysisCredential}>
              Save Artificial Analysis API key
            </button>
            {artificialAnalysis?.hasCredential && (
              <button type="button" className="btn-danger" disabled={busy} onClick={removeArtificialAnalysisCredential}>
                Remove Artificial Analysis API key
              </button>
            )}
          </div>
          <small className="muted">The free API is currently limited to 100 requests per key per day, is for internal use, and requires attribution; confirm your audience fits those terms. Pointer never returns this key to browser clients.</small>
        </section>
      </div>

      <section style={{ marginTop: 24 }}>
        <div className="section-head">
          <div><p className="eyebrow">Automated ingestion</p><h2>Benchmark sources</h2></div>
        </div>
        <div className="model-grid">
          {benchmarkSources.map((source) => (
            <article className="card" key={source.id} data-testid="benchmark-source" data-source-id={source.id}>
              <div className="spread"><h3>{source.label}</h3><span className={`badge ${source.state?.status === "ok" ? "success" : ""}`}>{source.state?.status ?? "not synced"}</span></div>
              <p className="muted">{source.description}</p>
              <p><strong>{source.state?.recordCount ?? 0}</strong> records</p>
              <small className="muted">{source.license}</small>
            </article>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Provider status</h2>
        <div className="card">{overview.providers.map((provider) => <p key={provider.id}><strong>{provider.name}</strong> <span className={`badge ${provider.status === "active" ? "success" : "danger"}`}>{provider.status}</span></p>)}</div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Users</h2>
        <div className="card table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th></tr></thead><tbody>{overview.users.map((user) => <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{user.role}</td><td>{new Date(user.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
