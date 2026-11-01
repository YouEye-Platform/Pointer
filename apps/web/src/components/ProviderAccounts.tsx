"use client";
import { usePointerTranslations, usePointerFormats } from "@/lib/i18n";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "./Modal";

type Quota = { fiveHourPercent?: number; weeklyPercent?: number; monthlyPercent?: number;
  shortPercent?: number; shortResetAt?: number; shortWindowSeconds?: number; credits?: { unlimited?: boolean; balance?: number; observedAt: number };
  fiveHourResetAt?: number; weeklyResetAt?: number; monthlyResetAt?: number; updatedAt?: number;
  customWindows?: Array<{ label: string; percent: number; resetAt?: number }>;
  creditsUsd?: { remaining: number; used: number; limit: number } };
type Account = { id: string; label?: string; alias?: string; email?: string; plan?: string; isMain?: boolean;
  hasCredential?: boolean; active?: boolean; paused?: boolean; needsReauth?: boolean; cooldownUntil?: number;
  quota?: Quota | null; quotaMode?: string; quotaUnavailable?: boolean; quotaFailure?: string; priority?: number; healthLabel?: string; healthSummary?: string; healthAction?: string };
type Pool = { kind: string; supported: string[]; enabled: boolean | null; enabledEffective?: boolean;
  strategy?: string | null; stickyLimit?: number | null; autoSwitchThreshold?: number | null; quotaWindow?: string | null; nativeMessages?: boolean | null; maxConcurrentPerAccount?: number | null };


export function QuotaView({ quota, mode, unavailable }: { quota?: Quota | null; mode?: string; unavailable?: boolean }) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();
  const date = (value?: number) => value ? format.date(value < 1e12 ? value * 1000 : value) : translateInterface("Not reported");

  if (!quota) return <p className="muted">{unavailable ? translateInterface("Quota lookup failed; no current reading.") : mode === "unsupported" ? translateInterface("This provider does not report quota.") : translateInterface("No quota reading yet.")}</p>;
  const windows = [...(quota.customWindows ?? [])];
  if (typeof quota.shortPercent === "number") windows.push({ label: quota.shortWindowSeconds ? translateInterface("{value0}-minute", { value0: Math.round(quota.shortWindowSeconds / 60) }) : translateInterface("Burst"), percent: quota.shortPercent, resetAt: quota.shortResetAt });
  for (const [name, percent, reset] of [["5-hour", quota.fiveHourPercent, quota.fiveHourResetAt], ["Weekly", quota.weeklyPercent, quota.weeklyResetAt], ["Monthly", quota.monthlyPercent, quota.monthlyResetAt]] as const)
    if (typeof percent === "number") windows.push({ label: translateInterface(name), percent, resetAt: reset });
  return <div className="quota-details">{windows.map((window, i) => <p key={`${window.label}-${i}`}><strong>{translateInterface("{label}: {percent} used", {label: window.label, percent: format.number(window.percent / 100, {style: "percent", maximumFractionDigits: 1})})}</strong><br /><small>{translateInterface("Resets at {date}", {date: date(window.resetAt)})}</small></p>)}
    {quota.credits && <p>{translateInterface("Subscription credits:")}{quota.credits.unlimited ? translateInterface("Unlimited") : quota.credits.balance ?? translateInterface("Not reported")} {translateInterface("· observed")}{date(quota.credits.observedAt)}</p>}
    {quota.creditsUsd && <p>{translateInterface("Reported credit balance: $")}{quota.creditsUsd.remaining.toFixed(2)}</p>}
    <small className="muted">{translateInterface("Reading:")}{date(quota.updatedAt)}</small></div>;
}
export function ProviderAccounts({ provider, auth, configured, revision, onChanged, onReauthenticate }: {
  provider: string; auth: string; configured: boolean; revision: number; onChanged: () => Promise<void>;
  onReauthenticate: (account: { id: string }) => void;
}) {
  const translateInterface = usePointerTranslations();
  const format = usePointerFormats();
  const date = (value?: number) => value ? format.date(value < 1e12 ? value * 1000 : value) : translateInterface("Not reported");

  const codex = auth === "forward"; const oauth = auth === "oauth"; const encoded = encodeURIComponent(provider);
  const [accounts, setAccounts] = useState<Account[]>([]); const [active, setActive] = useState<string | null>(null);
  const [pool, setPool] = useState<Pool | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null); const [alias, setAlias] = useState("");
  const [failover, setFailover] = useState<number | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const load = useCallback(async (refresh = false) => {
    if (!configured && !codex && !oauth) { setAccounts([]); setPool(null); return; }
    const url = codex ? `/api/connections/codex-auth/accounts${refresh ? "?refresh=1" : ""}` : oauth ? `/api/connections/oauth/accounts?provider=${encoded}&quota=1${refresh ? "&refresh=1" : ""}` : `/api/connections/providers/keys?name=${encoded}&quota=1${refresh ? "&refresh=1" : ""}`;
    const result = await api.get<{ accounts?: Account[]; keys?: Account[]; activeAccountId?: string; activeCodexAccountId?: string; activeId?: string }>(url);
    setAccounts((result.accounts ?? result.keys ?? []).filter(row => !row.isMain || row.hasCredential));
    setActive(result.activeAccountId ?? result.activeCodexAccountId ?? result.activeId ?? null);
    if (codex) { const settings = await api.get<{ activeCodexAccountId: string | null; upstreamFailoverThreshold: number }>("/api/connections/codex-auth/active"); setActive(settings.activeCodexAccountId); setFailover(settings.upstreamFailoverThreshold); }
    if (configured && (codex || oauth)) {
      try { setPool(await api.get<Pool>(`/api/connections/pool/settings?provider=${encoded}`)); }
      catch (reason) { setPool(null); setError(translateInterface("Account pool unavailable: {value0}", { value0: translateInterface("The operation failed.") })); }
    }
    try {
      const result = await api.get<{ reports: Array<{ provider: string; quota?: Quota | null }> }>(`/api/connections/provider-quotas${refresh ? "?refresh=1" : ""}`);
      setQuota(result.reports.find(row => row.provider === provider)?.quota ?? null);
    } catch (reason) { setError(translateInterface("Provider quota unavailable: {value0}", { value0: translateInterface("The operation failed.") })); }
  }, [configured, codex, oauth, encoded, provider]);
  useEffect(() => { void load().catch(reason => setError(translateInterface("The operation failed."))); }, [load, revision]);
  async function perform(task: () => Promise<unknown>, inventoryChanged = false) {
    if (busy) return; setBusy(true); setError("");
    try { await task(); if (inventoryChanged) await onChanged(); await load(); }
    catch (reason) { setError(translateInterface("The operation failed.")); } finally { setBusy(false); }
  }
  const accountBody = (account: Account) => codex ? { id: account.id } : oauth ? { provider, accountId: account.id } : { name: provider, id: account.id };
  const endpoint = (action: string) => `/api/connections/${codex ? "codex-auth/accounts" : oauth ? "oauth/accounts" : "providers/keys"}/${action}`;
  async function select(account: Account) {
    await api.put(codex ? "/api/connections/codex-auth/active" : endpoint("active"), codex ? { accountId: account.id } : accountBody(account));
  }
  async function remove(account: Account) {
    const path = codex ? `codex-auth/accounts?id=${encodeURIComponent(account.id)}` : oauth ? `oauth/accounts?provider=${encoded}&id=${encodeURIComponent(account.id)}` : `providers/keys?name=${encoded}&id=${encodeURIComponent(account.id)}`;
    await api.del(`/api/connections/${path}`);
  }
  const savePool = (patch: object) => perform(() => api.put("/api/connections/pool/settings", { provider, ...patch }));
  return <div className="provider-accounts">
    {error && <p role="alert" className="error">{error}</p>}
    <div className="spread"><h3>{translateInterface("Connected accounts")}</h3><button disabled={busy || !configured && !codex && !oauth} onClick={() => void perform(() => load(true))}>{busy ? translateInterface("Working…") : translateInterface("Refresh quota")}</button></div>
    {accounts.length === 0 && <p className="muted">{translateInterface("No connected account or key.")}</p>}
    {accounts.map(account => <article className="card" key={account.id}>
      <div className="spread"><strong>{account.alias || account.label || account.email || translateInterface("Connected account")}</strong><span>{active === account.id || account.active ? translateInterface("Active") : account.paused ? translateInterface("Paused") : account.needsReauth ? translateInterface("Sign-in required") : translateInterface("Available")}</span></div>
      {account.healthLabel && <p>{account.healthLabel}: {account.healthSummary} {account.healthAction}</p>}
      {codex && <label>{translateInterface("Pool priority (higher first)")}<input key={`priority-${account.id}-${account.priority}`} type="number" defaultValue={account.priority ?? 0} min={-100} max={100} disabled={busy} onBlur={event => { if (Number(event.target.value) !== (account.priority ?? 0)) void perform(() => api.put(endpoint("priority"), { id: account.id, priority: Number(event.target.value) })); }} /></label>}
      {account.plan && <p className="muted">{account.plan}</p>}
      {account.cooldownUntil && <p>{translateInterface("Cooldown until")}{date(account.cooldownUntil)}</p>}
      <QuotaView quota={account.quota} mode={account.quotaMode} unavailable={account.quotaUnavailable} />
      {account.quotaFailure && <p className="muted">{account.quotaFailure.replaceAll("_", " ")}</p>}
      <div className="connection-model-actions">
        <button disabled={busy || account.paused || account.needsReauth} onClick={() => void perform(() => select(account))}>{translateInterface("Use account")}</button>
        {!account.isMain && <button disabled={busy} onClick={() => { setEditing(account); setAlias(account.alias || account.label || ""); }}>{translateInterface("Rename")}</button>}
        {(codex || oauth && account.paused !== undefined) && <button disabled={busy} onClick={() => void perform(() => api.put(endpoint("pause"), { ...accountBody(account), paused: !account.paused }))}>{account.paused ? translateInterface("Resume account") : translateInterface("Pause account")}</button>}
        {(codex || oauth) && <button disabled={busy} onClick={() => onReauthenticate(account)}>{translateInterface("Sign in again")}</button>}
        {(codex || provider === "anthropic") && <button disabled={busy} onClick={() => void perform(() => api.post(endpoint("clear-cooldown"), accountBody(account)))}>{translateInterface("Clear cooldown")}</button>}
        {!account.isMain && <button className="btn-danger" disabled={busy} onClick={() => void perform(() => remove(account), true)}>{translateInterface("Remove account")}</button>}
      </div>
    </article>)}
    {editing && <Modal title={translateInterface("Rename account")} onClose={() => setEditing(null)}><form className="connection-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await api.put(endpoint("alias"), { ...accountBody(editing), alias }); setEditing(null); }); }}><label>{translateInterface("Account label")}<input value={alias} onChange={event => setAlias(event.target.value)} maxLength={80} /></label><button disabled={busy} className="btn-primary">{translateInterface("Save label")}</button></form></Modal>}
    <details><summary>{translateInterface("Provider quota and balance")}</summary><QuotaView quota={quota} /></details>
    {codex && failover !== null && <label>{translateInterface("Consecutive failures before changing accounts (0 disables)")}<input key={`failover-${failover}`} type="number" min={0} max={20} defaultValue={failover} disabled={busy} onBlur={event => { if (Number(event.target.value) !== failover) void perform(() => api.put("/api/connections/codex-auth/failover", { threshold: Number(event.target.value) })); }} /></label>}
    {pool && <section className="card"><h3>{translateInterface("Account pool")}</h3><p className="muted">{translateInterface("These settings use this provider's upstream account pool.")}</p>
      {pool.supported.includes("enabled") && <label className="connection-checkbox"><input type="checkbox" disabled={busy} checked={pool.enabledEffective ?? pool.enabled ?? false} onChange={event => void savePool({ enabled: event.target.checked })} />{translateInterface("Use account pool")}</label>}
      {pool.supported.includes("strategy") && <label>{translateInterface("Selection strategy")}<select disabled={busy} value={pool.strategy ?? "quota"} onChange={event => void savePool({ strategy: event.target.value })}>{["quota", "round-robin", "fill-first", ...(codex ? ["reset-first"] : []), ...(provider === "kiro" ? ["least-loaded"] : [])].map(value => <option key={value} value={value}>{translateInterface(value)}</option>)}</select></label>}
      {pool.supported.includes("stickyLimit") && <label>{translateInterface("Requests before rotating")}<input key={`sticky-${pool.stickyLimit}`} type="number" min={1} max={100} defaultValue={pool.stickyLimit ?? 1} disabled={busy} onBlur={event => { if (Number(event.target.value) !== pool.stickyLimit) void savePool({ stickyLimit: Number(event.target.value) }); }} /></label>}
      {pool.supported.includes("quotaWindow") && <label>{translateInterface("Quota window")}<select disabled={busy} value={pool.quotaWindow ?? "five-hour"} onChange={event => void savePool({ quotaWindow: event.target.value })}>{["five-hour", "weekly", "max-utilization"].map(value => <option key={value} value={value}>{translateInterface(value)}</option>)}</select></label>}
      {pool.supported.includes("nativeMessages") && <label className="connection-checkbox"><input type="checkbox" disabled={busy} checked={pool.nativeMessages ?? true} onChange={event => void savePool({ nativeMessages: event.target.checked })} />{translateInterface("Prefer native Messages requests")}</label>}
      {pool.supported.includes("maxConcurrentPerAccount") && <label>{translateInterface("Concurrent requests per account")}<input key={`cap-${pool.maxConcurrentPerAccount}`} type="number" min={1} max={100} defaultValue={pool.maxConcurrentPerAccount ?? ""} placeholder={translateInterface("Engine default")} disabled={busy} onBlur={event => { const value = event.target.value ? Number(event.target.value) : null; if (value !== pool.maxConcurrentPerAccount) void savePool({ maxConcurrentPerAccount: value }); }} /></label>}
      {pool.supported.includes("autoSwitchThreshold") && <label>{translateInterface("Switch at usage percent")}<input key={`threshold-${pool.autoSwitchThreshold}`} type="number" min={0} max={100} defaultValue={pool.autoSwitchThreshold ?? 80} disabled={busy} onBlur={event => { if (Number(event.target.value) !== pool.autoSwitchThreshold) void savePool({ autoSwitchThreshold: Number(event.target.value) }); }} /></label>}
    </section>}
  </div>;
}
