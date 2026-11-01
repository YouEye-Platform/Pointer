"use client";
import { CardsSkeleton, FormSkeleton } from "@/components/LoadingSkeleton";
import { usePointerTranslations } from "@/lib/i18n";


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
import { Modal } from "@/components/Modal";
import { inventory, type Preset, type Inventory } from "@/lib/provider-inventory";

type Account = { id: string; email?: string; alias?: string; label?: string; plan?: string; hasCredential?: boolean; isMain?: boolean };
type Login = { flowId?: string; url: string; deviceCode?: string; instructions?: string };

function webLink(value?: string) {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

const providerName = (preset: Preset) => preset.oauthProvider || preset.id;

export function Providers() {
  const translateInterface = usePointerTranslations();

  const [data, setData] = useState<Inventory | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const load = useCallback(async () => { setError(""); setData(await inventory()); }, []);
  useEffect(() => { void load().catch(error => setError(translateInterface("The request could not finish. Try again."))); }, [load, translateInterface]);
  async function refresh() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.post<{ models: number; catalogWarning?: string }>("/api/connections/sync", {});
      setNotice(result.catalogWarning ? translateInterface("Models refreshed with a catalog warning: {details}", {details: result.catalogWarning}) : translateInterface("Provider routes refreshed: {count}. Add models to groups to use them in your apps.", {count: new Intl.NumberFormat(translateInterface.locale).format(result.models)}));
      await load();
    } catch (error) { setError(translateInterface("The request could not finish. Try again.")); } finally { setBusy(false); }
  }
  const connected = (preset: Preset) => data?.providers.find(row => row.name === providerName(preset));
  const choices = data?.presets.filter(row => row.id !== "custom" && connected(row)?.connection?.setup && `${row.label} ${row.id}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(Boolean(connected(b))) - Number(Boolean(connected(a))) || a.label.localeCompare(b.label)) ?? [];
  return <div className="connections-page">
    <header className="connections-heading"><div><h1>{translateInterface("Providers")}</h1><p className="muted">{translateInterface("Connect a provider, then add its models to groups for your apps.")}</p></div>
      <div className="connection-model-actions"><button className="btn-primary" disabled={!data} onClick={() => { setAddSearch(""); setAdding(true); }}>{translateInterface("Add Provider")}</button>
        <button disabled={busy || !data} onClick={() => void refresh()}>{busy ? translateInterface("Refreshing models…") : translateInterface("Refresh models")}</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="connection-notice" role="status">{notice}</p>}
    <label className="connection-search">{translateInterface("Find a provider")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {!data ? error ? <button onClick={() => void load().catch(error => setError(translateInterface("The request could not finish. Try again.")))}>{translateInterface("Retry loading providers")}</button> : <CardsSkeleton label={translateInterface("Loading providers")} className="provider-card-grid" /> : choices.length === 0 ? <div className="card empty-state"><h2>{search ? translateInterface("No matching providers") : translateInterface("Add your first provider")}</h2><p className="muted">{search ? translateInterface("Try a different provider name.") : translateInterface("Connect an account, API key or local endpoint to start using models.")}</p></div> :
      <ul className="provider-card-grid">{choices.map(preset => {
        const configured = connected(preset);
        const count = data.models.filter(row => row.provider === providerName(preset)).length;
        return <li className="card" key={preset.id}><Link href={`/providers/${encodeURIComponent(preset.id)}`}>
          <div className="model-identity"><IconAvatar iconKey={preset.id} name={preset.label} /><strong>{preset.label}</strong></div>
          <span className="provider-state">{translateInterface(configured?.connection?.label ?? "Sign-in required")}</span>
          <span className="muted">{translateInterface("{count} discovered models", {count: new Intl.NumberFormat(translateInterface.locale).format(count)})}</span>
        </Link></li>;
      })}</ul>}
    {adding && <Modal title={translateInterface("Add Provider")} onClose={() => setAdding(false)}>
      <p className="muted">{translateInterface("Choose how you want to connect. Your existing accounts are kept.")}</p>
      <div className="field"><label htmlFor="add-provider-search">{translateInterface("Find a provider")}</label><input id="add-provider-search" type="search" value={addSearch} onChange={event => setAddSearch(event.target.value)} placeholder={translateInterface("Search providers")} /></div>
      <ul className="provider-choice-list">
        {data?.presets.filter(row => `${row.label} ${row.id}`.toLowerCase().includes(addSearch.toLowerCase())).sort((a, b) => a.label.localeCompare(b.label)).map(preset =>
          <li key={preset.id}><Link href={`/providers/${encodeURIComponent(preset.id)}`} onClick={() => setAdding(false)}>
            <IconAvatar iconKey={preset.id} name={preset.label} size={30} />
            <span><strong>{preset.label}</strong><small>{connected(preset)?.connection?.setup ? translateInterface("Manage connection or add an account") : preset.auth === "forward" || preset.auth === "oauth" ? translateInterface("Sign in with your account") : preset.auth === "local" ? translateInterface("Connect your endpoint") : translateInterface("Connect with an API key")}</small></span><span aria-hidden="true">→</span>
          </Link></li>)}
      </ul>
      {data && !data.presets.some(row => `${row.label} ${row.id}`.toLowerCase().includes(addSearch.toLowerCase())) && <p role="status" className="muted">{translateInterface("No providers match your search.")}</p>}
    </Modal>}
  </div>;
}

export function ProviderDetail({ id }: { id: string }) {
  const translateInterface = usePointerTranslations();

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
    setError(""); const next = await inventory(); setData(next);
    const chosen = next.presets.find(row => row.id === id);
    if (!chosen) return;
    setRevision(value => value + 1);
  }, [id]);
  useEffect(() => { void load().catch(error => setError(translateInterface("The request could not finish. Try again."))); }, [load, translateInterface]);
  useEffect(() => { setEndpoint(current?.baseUrl || preset?.baseUrl || ""); setAdapter(current?.adapter || preset?.adapter || "openai-chat"); }, [current?.baseUrl, current?.adapter, preset?.baseUrl, preset?.adapter]);
  const refresh = useCallback(async () => {
    const result = await api.post<{ models: number; catalogWarning?: string }>("/api/connections/sync", {});
    setNotice(result.catalogWarning ? translateInterface("Models refreshed with a catalog warning: {details}", {details: result.catalogWarning}) : translateInterface("Models refreshed. Add them to groups to use them in your apps."));
    await load();
  }, [load, translateInterface]);
  async function perform(action: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(action); setError(""); setNotice("");
    try { await task(); } catch (error) { setError(translateInterface("The request could not finish. Try again.")); } finally { setBusy(""); }
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
          setError(translateInterface("Sign-in expired. Start again to continue.")); setFlow(null); return;
        }
        if (status.done || status.status === "done") { setFlow(null); await refresh(); return; }
      } catch (error) { if (!cancelled) setError(translateInterface("The request could not finish. Try again.")); }
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
    <Link href="/providers">{translateInterface("← Providers")}</Link>
    <header className="connections-heading"><div><h1>{preset?.label || id}</h1><p className="muted">{current?.connection?.setup ? translateInterface(current.connection.label) : translateInterface("Connect this provider to make its models available.")}</p></div>
      <button disabled={Boolean(busy) || !data} onClick={() => void perform("refresh", refresh)}>{busy === "refresh" ? translateInterface("Refreshing models…") : translateInterface("Refresh models")}</button></header>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="connection-notice" role="status">{notice}</p>}
    {!data ? error ? <button onClick={() => void load().catch(error => setError(translateInterface("The request could not finish. Try again.")))}>{translateInterface("Retry loading provider")}</button> : <div className="stack"><FormSkeleton label={translateInterface("Loading provider accounts")} fields={2} /><FormSkeleton label={translateInterface("Loading provider settings")} /></div> : !preset ? <p role="status">{translateInterface("Provider not found. Choose a provider or add a custom endpoint.")}</p> : <>
      <section className="card"><h2>{translateInterface("Accounts")}</h2>
        <ProviderAccounts provider={provider} auth={auth} configured={Boolean(current)} revision={revision} onChanged={refresh} onReauthenticate={account => { void perform("login", async () => {
          setFlow(await api.post<Login>(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login`, auth === "forward" ? { accountId: account.id, reauth: true } : { provider, accountId: account.id, reauth: true, addAccount: true, openBrowser: false }));
        }); }} />
        {auth === "forward" || auth === "oauth" ? <>
          {!flow && <button className="btn-primary" disabled={Boolean(busy) || auth === "oauth" && !data.oauth.includes(provider)} onClick={() => void perform("login", async () => {
            setFlow(await api.post<Login>(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login`, auth === "forward" ? {} : { provider, addAccount: true, openBrowser: false }));
          })}>{busy === "login" ? translateInterface("Starting sign-in…") : translateInterface("Connect account")}</button>}
          {auth === "oauth" && !data.oauth.includes(provider) && <p className="muted">{translateInterface("This provider's sign-in is not available through the installed engine's supported management interface.")}</p>}
          {flow && <div className="connection-login"><p role="status">{translateInterface("Finish signing in with the provider.")}</p>
            {flow.deviceCode && <strong className="connection-code mono">{flow.deviceCode}</strong>}
            {webLink(flow.url) && <a className="btn btn-primary" href={webLink(flow.url)} target="_blank" rel="noreferrer">{translateInterface("Open sign-in page")}</a>}
            {flow.instructions && <p>{flow.instructions}</p>}
            {!flow.deviceCode && <form className="connection-form" onSubmit={event => { event.preventDefault(); void perform("code", async () => {
              await api.post(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login/code`, auth === "forward" ? { flowId: flow.flowId, code } : { provider, input: code }); setCode("");
            }); }}><label>{translateInterface("Redirect URL or authorization code")}<input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" required /></label><button disabled={Boolean(busy)}>{translateInterface("Complete sign-in")}</button></form>}
            <button disabled={Boolean(busy)} onClick={() => void perform("cancel", async () => {
              await api.post(`/api/connections/${auth === "forward" ? "codex-auth" : "oauth"}/login/cancel`, auth === "forward" ? { flowId: flow.flowId } : { provider }); setFlow(null); setCode("");
            })}>{translateInterface("Cancel sign-in")}</button>
          </div>}
        </> : <form className="connection-form" onSubmit={connectKey}>
          {id === "custom" && <label>{translateInterface("Provider name")}<input value={name} onChange={event => setName(event.target.value)} pattern="[A-Za-z0-9._-]+" required /></label>}
          {!current && <>
            {preset.baseUrlChoices?.length ? <label>{translateInterface("Endpoint option")}<select value={endpoint} onChange={event => setEndpoint(event.target.value)}><option value={endpoint}>{translateInterface("Current endpoint")}</option>{preset.baseUrlChoices.filter(row => row.baseUrl).map(row => <option key={row.id} value={row.baseUrl}>{row.label}</option>)}</select></label> : null}
            <label>{translateInterface("Endpoint URL")}<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} required placeholder="https://your-provider.example/v1" /></label>
            {id === "custom" && <label>{translateInterface("Compatible API")}<select value={adapter} onChange={event => setAdapter(event.target.value)}><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></label>}
            <label className="connection-checkbox"><input type="checkbox" checked={privateNetwork} onChange={event => setPrivateNetwork(event.target.checked)} />{translateInterface("Allow an endpoint on a private network")}</label>
          </>}
          {current && <p className="muted">{current.hasApiKey ? translateInterface("An API key is configured. Add another key to the provider's account pool.") : translateInterface("This provider is configured without an API key.")}</p>}
          <label>{translateInterface("API key")}{preset.keyOptional || auth === "local" || id === "custom" ? translateInterface(" (if required)") : ""}<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} required={Boolean(current) || !(preset.keyOptional || auth === "local" || id === "custom")} /></label>
          {current && <label>{translateInterface("Key label (optional)")}<input value={label} onChange={event => setLabel(event.target.value)} /></label>}
          {webLink(preset.dashboardUrl) && <a href={webLink(preset.dashboardUrl)} target="_blank" rel="noreferrer">{translateInterface("Open provider dashboard")}</a>}
          <button className="btn-primary" disabled={Boolean(busy)} type="submit">{busy === "save" ? translateInterface("Connecting…") : current ? translateInterface("Add API key") : translateInterface("Connect provider")}</button>
        </form>}
      </section>
      {current && <ProviderOperations name={provider} disabled={current.disabled === true} onChanged={refresh} />}
      {current && <ProviderSettings name={provider} models={data.models.filter(row => row.provider === provider)} onChanged={refresh} />}
      {current && <ProviderModelControls key={provider} name={provider} models={data.models.filter(row => row.provider === provider)} onChanged={refresh} />}
      <section className="card connection-models"><div className="spread"><h2>{translateInterface("Models")}</h2><Link href="/models">{translateInterface("Open model catalog")}</Link></div>
        <p className="muted">{translateInterface("All discovered models are available to add to groups. Your apps can only use models in their assigned group.")}</p>
        <label>{translateInterface("Find a model")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {models.length === 0 ? <p role="status">{current ? translateInterface("No models found. Refresh models or check this provider's account.") : translateInterface("Connect an account to discover its models.")}</p> :
          <ul className="connection-model-list">{models.map(row => <li key={row.namespaced}><strong>{modelLabel(row)}</strong><span className="muted mono">{row.id}</span></li>)}</ul>}
      </section>
    </>}
  </div>;
}
