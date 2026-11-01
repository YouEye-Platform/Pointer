"use client";
import { usePointerTranslations } from "@/lib/i18n";

import { useState } from "react";
import { api } from "@/lib/api";
export function ProviderSettings({ name, models, onChanged }: { name: string; models: Array<{ id: string }>; onChanged: () => Promise<void> }) {
  const translateInterface = usePointerTranslations();

  const [model, setModel] = useState(""); const [effort, setEffort] = useState(""); const [modality, setModality] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function save() { setBusy(true); setError(""); setNotice(""); try {
    await api.patch(`/api/connections/providers?name=${encodeURIComponent(name)}`, {
      modelPinnedReasoningEfforts: { [model]: effort || null },
      ...(modality ? { modelCapabilities: { [model]: { inputModalities: modality.split(",") } } } : {}),
    }); await onChanged(); setNotice("Model settings saved.");
  } catch (reason) { setError(translateInterface("Settings could not save.")); } finally { setBusy(false); } }
  return <details className="card"><summary>{translateInterface("Model effort and capabilities")}</summary><p className="muted">{translateInterface("Exact model settings, validated by the provider engine. Declare image support only when this endpoint supports it.")}</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form className="connection-form" onSubmit={event => { event.preventDefault(); void save(); }}><label>{translateInterface("Model")}<select required value={model} onChange={event => setModel(event.target.value)}><option value="">{translateInterface("Choose a model")}</option>{models.map(row => <option key={row.id}>{row.id}</option>)}</select></label>
      <label>{translateInterface("Pinned reasoning effort")}<select value={effort} onChange={event => setEffort(event.target.value)}><option value="">{translateInterface("Use client/provider default")}</option>{["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(value => <option key={value} value={value}>{translateInterface(value)}</option>)}</select></label>
      <label>{translateInterface("Input capabilities")}<select value={modality} onChange={event => setModality(event.target.value)}><option value="">{translateInterface("Keep discovered capabilities")}</option><option value="text">{translateInterface("Text only")}</option><option value="text,image">{translateInterface("Text and images")}</option><option value="text,image,audio,video">{translateInterface("Text, images, audio and video")}</option></select></label>
      <button disabled={busy || !model} className="btn-primary">{busy ? translateInterface("Saving…") : translateInterface("Save model settings")}</button>
    </form></details>;
}
