"use client";
import { useEffect, useRef, useState } from "react";
import { streamChat } from "@/lib/api";

const PROXY_KEY_STORAGE = "pointer_proxy_key";

interface Msg {
  role: "user" | "assistant";
  content: string;
}
interface ModelInfo {
  id: string;
}

export default function ChatPage() {
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(PROXY_KEY_STORAGE);
    if (saved) {
      setApiKey(saved);
      setKeySaved(true);
    }
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  async function loadModels(key: string) {
    setError("");
    try {
      const res = await api_v1_models(key);
      setModels(res);
      if (res.length && !model) setModel(res[0].id);
    } catch (e: any) {
      setError(`Could not list models: ${e?.message || e}`);
    }
  }

  function saveKey() {
    if (!apiKey.trim()) return;
    localStorage.setItem(PROXY_KEY_STORAGE, apiKey.trim());
    setKeySaved(true);
    loadModels(apiKey.trim());
  }

  function clearKey() {
    localStorage.removeItem(PROXY_KEY_STORAGE);
    setKeySaved(false);
    setModels([]);
    setModel("");
  }

  useEffect(() => {
    if (keySaved && apiKey) loadModels(apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySaved]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !model || streaming) return;
    setError("");
    const userMsg: Msg = { role: "user", content: prompt.trim() };
    const history = [...messages, userMsg];
    setMessages([...history, { role: "assistant", content: "" }]);
    setPrompt("");
    setStreaming(true);

    await streamChat(
      apiKey,
      { model, messages: history.map((m) => ({ role: m.role, content: m.content })), stream: true },
      {
        onDelta: (text) =>
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1].content + text };
            return copy;
          }),
        onDone: () => setStreaming(false),
        onError: (msg) => {
          setError(msg);
          setStreaming(false);
          setMessages((prev) => prev.slice(0, -1)); // drop the empty assistant bubble
        },
      }
    );
  }

  if (!keySaved) {
    return (
      <div>
        <div className="page-head">
          <h1>Proxy Test</h1>
          <p className="muted">
            Exercise the gateway directly against <code>/v1/chat/completions</code>. Paste a <code>ptr_</code> API key
            (create one under API Keys).
          </p>
        </div>
        <div className="card auth-card">
          <div className="field">
            <label htmlFor="proxy-api-key">Proxy API key</label>
            <input id="proxy-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ptr_…" />
          </div>
          <button className="btn-primary" onClick={saveKey} disabled={!apiKey.trim()}>
            Use key
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 56px)" }}>
      <div className="spread page-head">
        <div>
          <h1>Proxy Test</h1>
          <p className="muted">Streaming completions through the gateway.</p>
        </div>
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 240 }}>
            {models.length === 0 && <option value="">no models</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
          <button className="btn-sm" onClick={clearKey}>
            Change key
          </button>
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

      <div className="card" style={{ flex: 1, overflow: "auto", marginBottom: 12 }} ref={logRef}>
        {messages.length === 0 ? (
          <p className="muted">Send a message to test the proxy.</p>
        ) : (
          <div className="chat-log">
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
              </div>
            ))}
          </div>
        )}
      </div>

      <form className="row" onSubmit={send}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={model ? "Type a message…" : "Select a model first"}
          disabled={!model || streaming}
        />
        <button className="btn-primary" type="submit" disabled={!model || streaming || !prompt.trim()}>
          {streaming ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

// GET /v1/models with a ptr_ key (bypasses the JWT api helper).
async function api_v1_models(key: string): Promise<{ id: string }[]> {
  const res = await fetch(`${apiBase()}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  const json = await res.json();
  return json.data || [];
}
function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
}
