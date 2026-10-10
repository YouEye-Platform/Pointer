"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { modelLabel } from "@pointer/contracts/model-label";
import { ProviderOperations } from "./ProviderOperations";
import { ProviderSettings } from "./ProviderSettings";
import { ProviderModelControls } from "./ProviderModelControls";
import { ProviderAccounts } from "./ProviderAccounts";
import { IconAvatar } from "@/components/IconAvatar";

type Preset = { id: string; label: string; adapter: string; baseUrl: string; auth: string;
  oauthProvider?: string; keyOptional?: boolean; dashboardUrl?: string; provider?: Record<string, unknown>;
  responsesPath?: string; chatCompletionsPath?: string; defaultModel?: string;
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }> };
type Provider = { name: string; adapter: string; baseUrl: string; hasApiKey: boolean; disabled: boolean };
type Model = { provider: string; id: string; namespaced: string; displayName?: string; displayNameSource?: string };
type Account = { id: string; email?: string; alias?: string; label?: string; plan?: string; hasCredential?: boolean; isMain?: boolean };
type Login = { flowId?: string; url: string; deviceCode?: string; instructions?: string };
type Inventory = { providers: Provider[]; presets: Preset[]; oauth: string[]; models: Model[] };
const message = (error: unknown) => error instanceof Error ? error.message : "The request could not finish. Try again.";
function webLink(value?: string) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}
async function inventory(): Promise<Inventory> {
  const [providers, choices, oauth, models] = await Promise.all([
    api.get<Provider[]>("/api/connections/providers"),
    api.get<{ providers: Preset[] }>("/api/connections/provider-presets"),
    api.get<{ providers: string[] }>("/api/connections/oauth/providers"),
    api.get<Model[]>("/api/connections/models"),
  ]);
  const presets = [...choices.providers];
  for (const id of oauth.providers) if (!presets.some(row => row.oauthProvider === id))
    presets.push({ id, label: id, adapter: "", baseUrl: "", auth: "oauth", oauthProvider: id });
  for (const provider of providers) if (!presets.some(row => row.id === provider.name || row.oauthProvider === provider.name))
    presets.push({ id: provider.name, label: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl, auth: "key" });
  return { providers, presets, oauth: oauth.providers, models };
}
const providerName = (preset: Preset) => preset.oauthProvider || preset.id;

export function Providers() {
  const [data, setData] = useState<Inventory | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await inventory()), []);
  useEffect(() => { void load().catch(error => setError(message(error))); }, [load]);
  async function refresh() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.post<{ models: number; catalogWarning?: string }>("/api/connections/sync", {});
      setNotice(result.catalogWarning || `${result.models} provider model routes refreshed. Add models to groups to use them in your apps.`);
      await load();
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  const connected = (preset: Preset) => data?.providers.find(row => row.name === providerName(preset));
  const choices = data?.presets.filter(row => row.id !== "custom" && `${row.label} ${row.id}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(Boolean(connected(b))) - Number(Boolean(connected(a))) || a.label.localeCompare(b.label)) ?? [];
  return <div className="connections-page">
    <header className="connections-heading"><div><h1>Providers</h1><p className="muted">Connect a provider, then add its models to groups for your apps.</p></div>
      <div className="connection-model-actions"><Link className="btn btn-primary" href="/providers/custom">Add custom provider</Link>
        <button disabled={busy || !data} onClick={() => void refresh()}>{busy ? "Refreshing models…" : "Refresh models"}</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="connection-notice" role="status">{notice}</p>}
    <label className="connection-search">Find a provider<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {!data ? <p role="status">Loading providers…</p> : choices.length === 0 ? <p role="status">No providers match your search.</p> :
      <ul className="provider-card-grid">{choices.map(preset => {
        const configured = connected(preset);
        const count = data.models.filter(row => row.provider === providerName(preset)).length;
        return <li className="card" key={preset.id}><Link href={`/providers/${encodeURIComponent(preset.id)}`}>
          <div className="model-identity"><IconAvatar iconKey={preset.id} name={preset.label} /><strong>{preset.label}</strong></div>
          <span className="muted">{configured ? `${count} models · Configured` : "Not connected"}</span>
          <span>{preset.auth === "forward" || preset.auth === "oauth" ? "Sign in to connect" : preset.auth === "local" ? "Connect an endpoint" : "Connect with an API key"}</span>
        </Link></li>;
      })}</ul>}
  </div>;
}

export function ProviderDetail({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Inventory | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState("");
  const [key, setKey] = useState(""); const [label, setLabel] = useState(""); const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState(""); const [adapter, setAdapter] = useState("openai-chat");
  const [privateNetwork, setPrivateNetwork] = useState(false);
  const [flow, setFlow] = useState<Login | null>(null); const [code, setCode] = useState(""); const [search, setSearch] = useState("");
  const preset = data?.presets.find(row => row.id === id);
  const provider = preset ? providerName(preset) : id;
  const current = data?.providers.find(row => row.name === provider);
  const auth = preset?.auth ?? "key";
  const load = useCallback(async () => {
    const next = await inventory(); setData(next);
    const chosen = next.presets.find(row => row.id === id);
    if (!chosen) return;
    setRevision(value => value + 1);
  }, [id]);
  useEffect(() => { void load().catch(error => setError(message(error))); }, [load]);
  useEffect(() => { setEndpoint(current?.baseUrl || preset?.baseUrl || ""); setAdapter(current?.adapter || preset?.adapter || "openai-chat"); }, [current?.baseUrl, current?.adapter, preset?.baseUrl, preset?.adapter]);
  const refresh = useCallback(async () => {
    const result = await api.post<{ models: number; catalogWarning?: string }>("/api/connections/sync", {});
    setNotice(result.catalogWarning || "Models refreshed. Add them to groups to use them in your apps.");
    await load();
  }, [load]);
  async function perform(action: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(action); setError(""); setNotice("");
    try { await task(); } catch (error) { setError(message(error)); } finally { setBusy(""); }
  }
  useEffect(() => {
    if (!flow) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const path = auth === "forward" ? `codex-auth/login-status?flowId=${encodeURIComponent(flow.flowId || "")}` : `oauth/status?provider=${encodeURIComponent(provider)}`;
        const status = await api.get<{ status?: string; done?: boolean; error?: string }>(`/api/connections/${path}`);
        if (cancelled) return;
        if (status.error || ["error", "expired", "cancelled"].includes(status.status || "")) {
          setError(status.error || "Sign-in expired. Start again to continue."); setFlow(null); return;
        }
        if (status.done || status.status === "done") { setFlow(null); await refresh(); return; }
      } catch (error) { if (!cancelled) setError(message(error)); }
      if (!cancelled) timer = setTimeout(poll, 2500);
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [flow, auth, provider, refresh]);
  async function connectKey(event: React.FormEvent) {
    event.preventDefault();
    await perform("save", async () => {
      const target = id === "custom" ? name.trim() : provider;
      if (!target) throw new Error("Name this provider.");
      if (current) {
        if (!key.trim()) throw new Error("Enter an API key to add to this provider.");
        await api.post("/api/connections/providers/keys", { name: target, key: key.trim(), label: label.trim() || undefined });
      } else {
        await api.post("/api/connections/providers", { name: target, provider: {
          ...preset?.provider, adapter, baseUrl: endpoint.trim(), allowPrivateNetwork: privateNetwork,
          responsesPath: preset?.responsesPath, chatCompletionsPath: preset?.chatCompletionsPath, defaultModel: preset?.defaultModel,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        } });
      }
      setKey(""); setLabel(""); await refresh();
      if (id === "custom") router.push(`/providers/${encodeURIComponent(target)}`);
    });
  }
  const models = data?.models.filter(row => row.provider === provider && `${modelLabel(row)} ${row.id}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="connections-page">
    <Link href="/providers">← Providers</Link>
    <header className="connections-heading"><div><h1>{preset?.label || id}</h1><p className="muted">{current ? "Provider configured" : "Connect this provider to make its models available."}</p></div>
      <button disabled={Boolean(busy) || !data} onClick={() => void perform("refresh", refresh)}>{busy === "refresh" ? "Refreshing models…" : "Refresh models"}</button></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="connection-notice" role="status">{notice}</p>}
    {!data ? <p role="status">Loading provider…</p> : !preset ? <p role="status">Provider not found. Choose a provider or add a custom endpoint.</p> : <>
      <section className="card"><h2>Accounts</h2>
        <ProviderAccounts provider={provider} auth={auth} configured={Boolean(current)} revision={revision} onChanged={refresh} onReauthenticate={account => { void perform("login", async () => {
          setFlow(await api.post<Login>(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login`, auth === "forward" ? { accountId: account.id, reauth: true } : { provider, accountId: account.id, reauth: true, addAccount: true, openBrowser: false }));
        }); }} />
        {auth === "forward" || auth === "oauth" ? <>
          {!flow && <button className="btn-primary" disabled={Boolean(busy) || auth === "oauth" && !data.oauth.includes(provider)} onClick={() => void perform("login", async () => {
            setFlow(await api.post<Login>(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login`, auth === "forward" ? {} : { provider, addAccount: true, openBrowser: false }));
          })}>{busy === "login" ? "Starting sign-in…" : "Connect account"}</button>}
          {auth === "oauth" && !data.oauth.includes(provider) && <p className="muted">This provider's sign-in is not available through the installed engine's supported management interface.</p>}
          {flow && <div className="connection-login"><p role="status">Finish signing in with the provider.</p>
            {flow.deviceCode && <strong className="connection-code mono">{flow.deviceCode}</strong>}
            {webLink(flow.url) && <a className="btn btn-primary" href={webLink(flow.url)} target="_blank" rel="noreferrer">Open sign-in page</a>}
            {flow.instructions && <p>{flow.instructions}</p>}
            {!flow.deviceCode && <form className="connection-form" onSubmit={event => { event.preventDefault(); void perform("code", async () => {
              await api.post(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login/code`, auth === "forward" ? { flowId: flow.flowId, code } : { provider, input: code }); setCode("");
            }); }}><label>Redirect URL or authorization code<input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" required /></label><button disabled={Boolean(busy)}>Complete sign-in</button></form>}
            <button disabled={Boolean(busy)} onClick={() => void perform("cancel", async () => {
              await api.post(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login/cancel`, auth === "forward" ? { flowId: flow.flowId } : { provider }); setFlow(null); setCode("");
            })}>Cancel sign-in</button>
          </div>}
        </> : <form className="connection-form" onSubmit={connectKey}>
          {id === "custom" && <label>Provider name<input value={name} onChange={event => setName(event.target.value)} pattern="[A-Za-z0-9._-]+" required /></label>}
          {!current && <>
            {preset.baseUrlChoices?.length ? <label>Endpoint option<select value={endpoint} onChange={event => setEndpoint(event.target.value)}><option value={endpoint}>Current endpoint</option>{preset.baseUrlChoices.filter(row => row.baseUrl).map(row => <option key={row.id} value={row.baseUrl}>{row.label}</option>)}</select></label> : null}
            <label>Endpoint URL<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} required placeholder="https://your-provider.example/v1" /></label>
            {id === "custom" && <label>Compatible API<select value={adapter} onChange={event => setAdapter(event.target.value)}><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></label>}
            <label className="connection-checkbox"><input type="checkbox" checked={privateNetwork} onChange={event => setPrivateNetwork(event.target.checked)} />Allow an endpoint on a private network</label>
          </>}
          {current && <p className="muted">{current.hasApiKey ? "An API key is configured. Add another key to the provider's account pool." : "This provider is configured without an API key."}</p>}
          <label>API key{preset.keyOptional || auth === "local" || id === "custom" ? " (if required)" : ""}<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} required={Boolean(current) || !(preset.keyOptional || auth === "local" || id === "custom")} /></label>
          {current && <label>Key label (optional)<input value={label} onChange={event => setLabel(event.target.value)} /></label>}
          {webLink(preset.dashboardUrl) && <a href={webLink(preset.dashboardUrl)} target="_blank" rel="noreferrer">Open provider dashboard</a>}
          <button className="btn-primary" disabled={Boolean(busy)} type="submit">{busy === "save" ? "Connecting…" : current ? "Add API key" : "Connect provider"}</button>
        </form>}
      </section>
      {current && <ProviderOperations name={provider} disabled={current.disabled === true} onChanged={refresh} />}
      {current && <ProviderSettings name={provider} models={data.models.filter(row => row.provider === provider)} onChanged={refresh} />}
      {current && <ProviderModelControls key={provider} name={provider} models={data.models.filter(row => row.provider === provider)} onChanged={refresh} />}
      <section className="card connection-models"><div className="spread"><h2>Models</h2><Link href="/models">Open model catalog</Link></div>
        <p className="muted">All discovered models are available to add to groups. Your apps can only use models in their assigned group.</p>
        <label>Find a model<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {models.length === 0 ? <p role="status">{current ? "No models found. Refresh models or check this provider's account." : "Connect an account to discover its models."}</p> :
          <ul className="connection-model-list">{models.map(row => <li key={row.namespaced}><strong>{modelLabel(row)}</strong><span className="muted mono">{row.id}</span></li>)}</ul>}
      </section>
    </>}
  </div>;
}
