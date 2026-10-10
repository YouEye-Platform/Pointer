"use client";
import { useState } from "react";
import { api } from "@/lib/api";
export function ProviderSettings({ name, models, onChanged }: { name: string; models: Array<{ id: string }>; onChanged: () => Promise<void> }) {
  const [model, setModel] = useState(""); const [effort, setEffort] = useState(""); const [modality, setModality] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function save() { setBusy(true); setError(""); setNotice(""); try {
    await api.patch(`/api/connections/providers?name=${encodeURIComponent(name)}`, {
      modelPinnedReasoningEfforts: { [model]: effort || null },
      ...(modality ? { modelCapabilities: { [model]: { inputModalities: modality.split(",") } } } : {}),
    }); await onChanged(); setNotice("Model settings saved.");
  } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings could not save."); } finally { setBusy(false); } }
  return <details className="card"><summary>Model effort and capabilities</summary><p className="muted">Exact model settings, validated by the provider engine. Declare image support only when this endpoint supports it.</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form className="connection-form" onSubmit={event => { event.preventDefault(); void save(); }}><label>Model<select required value={model} onChange={event => setModel(event.target.value)}><option value="">Choose a model</option>{models.map(row => <option key={row.id}>{row.id}</option>)}</select></label>
      <label>Pinned reasoning effort<select value={effort} onChange={event => setEffort(event.target.value)}><option value="">Use client/provider default</option>{["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Input capabilities<select value={modality} onChange={event => setModality(event.target.value)}><option value="">Keep discovered capabilities</option><option value="text">Text only</option><option value="text,image">Text and images</option><option value="text,image,audio,video">Text, images, audio and video</option></select></label>
      <button disabled={busy || !model} className="btn-primary">{busy ? "Saving…" : "Save model settings"}</button>
    </form></details>;
}
