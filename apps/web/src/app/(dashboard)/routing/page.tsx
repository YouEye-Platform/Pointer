"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
type Setting = { enabled: boolean; model: string; backend?: string | null; streamRoutedModelOutput?: boolean };
type Data = { webSearch: Setting; vision: Setting; webSearchModels: Array<{ value: string; label?: string }>; visionModels: Array<{ value: string; label?: string }> };
export default function Routing() {
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  useEffect(() => { api.get<Data>("/api/connections/sidecar-settings").then(setData).catch(reason => setError(reason.message)); }, []);
  async function save() { if (!data) return; setBusy(true); setError(""); setNotice(""); try {
    await api.put("/api/connections/sidecar-settings", { webSearch: { enabled: data.webSearch.enabled, model: data.webSearch.model, backend: data.webSearch.backend, streamRoutedModelOutput: data.webSearch.streamRoutedModelOutput }, vision: { enabled: data.vision.enabled, model: data.vision.model, backend: data.vision.backend } });
    setData(await api.get<Data>("/api/connections/sidecar-settings")); setNotice("Search and vision settings saved.");
  } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings could not save."); } finally { setBusy(false); } }
  return <div><div className="page-head"><h1>Search and vision</h1><p className="muted">Optional helper models provide web search and image descriptions for routes that need them. Helper calls use the selected provider's account and allowance.</p></div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}{!data && !error && <p role="status">Loading settings…</p>}
    {data && <form className="connection-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      {(["webSearch", "vision"] as const).map(section => <section className="card" key={section}><h2>{section === "vision" ? "Image descriptions" : "Web search"}</h2>
        <label className="connection-checkbox"><input type="checkbox" checked={data[section].enabled} onChange={event => setData({ ...data, [section]: { ...data[section], enabled: event.target.checked } })} />Enable {section === "vision" ? "image descriptions" : "web search"}</label>
        <label>Helper provider<select value={data[section].backend ?? ""} onChange={event => setData({ ...data, [section]: { ...data[section], backend: event.target.value || null } })}><option value="">Engine default</option>{(section === "vision" ? ["openai", "anthropic", "routed"] : ["openai", "anthropic", "xai", "gemini"]).map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Helper model<select value={data[section].model} onChange={event => setData({ ...data, [section]: { ...data[section], model: event.target.value } })}><option value={data[section].model}>{data[section].model}</option>{(section === "vision" ? data.visionModels : data.webSearchModels).filter(model => model.value !== data[section].model).map(model => <option key={model.value} value={model.value}>{model.label || model.value}</option>)}</select></label>
        {section === "webSearch" && <label className="connection-checkbox"><input type="checkbox" checked={data.webSearch.streamRoutedModelOutput ?? false} onChange={event => setData({ ...data, webSearch: { ...data.webSearch, streamRoutedModelOutput: event.target.checked } })} />Stream answers while deciding whether to search</label>}
      </section>)}<button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save helper settings"}</button>
    </form>}
  </div>;
}
