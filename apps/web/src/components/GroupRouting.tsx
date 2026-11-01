"use client";
import { usePointerTranslations } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "./Modal";
type Entry = { id: string; modelName: string; alias?: string | null; enabled: boolean };
type Combo = { name: string; strategy: "failover" | "round-robin"; targets: Array<{ entryId: string; weight: number }> };
export function GroupRouting({ groupId, entries }: { groupId: string; entries: Entry[] }) {
  const translateInterface = usePointerTranslations();

  const [combos, setCombos] = useState<Combo[]>([]); const [draft, setDraft] = useState<Combo | null>(null);
  const [editing, setEditing] = useState<number | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ combos: Combo[] }>(`/api/groups/${encodeURIComponent(groupId)}/routing`).then(row => setCombos(row.combos)).catch(reason => setError(translateInterface("The operation failed."))); }, [groupId]);
  async function save(next: Combo[]) {
    setBusy(true); setError("");
    try { await api.put(`/api/groups/${encodeURIComponent(groupId)}/routing`, { combos: next }); setCombos(next); setDraft(null); }
    catch (reason) { setError(translateInterface("Routing could not save.")); } finally { setBusy(false); }
  }
  return <section className="card group-routing"><div className="spread"><div><h2>{translateInterface("Routing choices")}</h2><p className="muted">{translateInterface("Give apps one model name with failover or weighted rotation across this group's models.")}</p></div><button disabled={busy || !entries.some(entry => entry.enabled)} onClick={() => { setEditing(null); setDraft({ name: "", strategy: "failover", targets: [] }); }}>{translateInterface("Add routing choice")}</button></div>
    {error && <p role="alert" className="error">{error}</p>}
    {combos.length === 0 && <p className="muted">{translateInterface("No routing choices. Individual group models remain available.")}</p>}
    {combos.map((combo, i) => <div className="card" key={combo.name}><div className="spread"><strong>{combo.name}</strong><span>{combo.strategy === "failover" ? translateInterface("Failover in order") : translateInterface("Weighted rotation")}</span></div><ol>{combo.targets.map(target => <li key={target.entryId}>{entries.find(entry => entry.id === target.entryId)?.modelName || translateInterface("Removed group entry")}{combo.strategy === "round-robin" && translateInterface(" · weight {weight}", {weight: new Intl.NumberFormat(translateInterface.locale).format(target.weight)})}</li>)}</ol><div className="connection-model-actions"><button disabled={busy} onClick={() => { setEditing(i); setDraft(structuredClone(combo)); }}>{translateInterface("Edit routing")}</button><button className="btn-danger" disabled={busy} onClick={() => void save(combos.filter((_, index) => index !== i))}>{translateInterface("Remove routing")}</button></div></div>)}
    {draft && <Modal title={translateInterface("Group routing")} onClose={() => setDraft(null)}><form className="connection-form" onSubmit={event => { event.preventDefault(); void save(editing === null ? [...combos, draft] : combos.map((row, i) => i === editing ? draft : row)); }}>
      <label>{translateInterface("Public model name")}<input value={draft.name} required maxLength={80} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>{translateInterface("Routing strategy")}<select value={draft.strategy} onChange={event => setDraft({ ...draft, strategy: event.target.value as Combo["strategy"] })}><option value="failover">{translateInterface("Try targets in order")}</option><option value="round-robin">{translateInterface("Weighted rotation")}</option></select></label>
      <p className="muted">{translateInterface("Select targets in the order to try them. Disabled and unavailable targets are skipped. A choice needs at least one enabled connected target.")}</p>
      {draft.targets.length > 0 && <ol>{draft.targets.map((target, index) => <li key={target.entryId}>{entries.find(entry => entry.id === target.entryId)?.modelName || translateInterface("Removed entry")}<div className="connection-model-actions"><button type="button" disabled={index === 0} aria-label={translateInterface("Move target {value0} earlier", { value0: index + 1 })} onClick={() => { const targets = [...draft.targets]; [targets[index - 1], targets[index]] = [targets[index], targets[index - 1]]; setDraft({ ...draft, targets }); }}>{translateInterface("Earlier")}</button><button type="button" disabled={index === draft.targets.length - 1} aria-label={translateInterface("Move target {value0} later", { value0: index + 1 })} onClick={() => { const targets = [...draft.targets]; [targets[index + 1], targets[index]] = [targets[index], targets[index + 1]]; setDraft({ ...draft, targets }); }}>{translateInterface("Later")}</button></div></li>)}</ol>}
      {entries.filter(entry => entry.enabled).map(entry => { const selected = draft.targets.find(target => target.entryId === entry.id); return <div key={entry.id}><label className="connection-checkbox"><input type="checkbox" checked={Boolean(selected)} onChange={event => setDraft({ ...draft, targets: event.target.checked ? [...draft.targets, { entryId: entry.id, weight: 1 }] : draft.targets.filter(target => target.entryId !== entry.id) })} />{entry.modelName}</label>{selected && draft.strategy === "round-robin" && <label>{translateInterface("Weight for")}{entry.modelName}<input type="number" min={1} max={100} value={selected.weight} onChange={event => setDraft({ ...draft, targets: draft.targets.map(target => target.entryId === entry.id ? { ...target, weight: Number(event.target.value) } : target) })} /></label>}</div>; })}
      <button className="btn-primary" disabled={busy || draft.targets.length === 0}>{busy ? translateInterface("Saving…") : translateInterface("Save routing")}</button></form></Modal>}
  </section>;
}
