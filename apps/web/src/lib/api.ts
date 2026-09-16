import {
  parseDeploymentCapabilities,
  type DeploymentCapabilities,
} from "@pointer/contracts/capabilities";

// Env-driven API client. Pointer web is a pure client of Pointer server:
// every backend behavior lives in the server and is reached over HTTP with a Bearer
// token. No provider secrets, no business logic here.

// An empty value intentionally means same-origin. Local/Preview builds then use
// Next's API_PROXY_TARGET rewrite; production uses the current Pointer origin.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export function runtimePath(path: string): string {
  if (typeof window === "undefined") return path;
  const previewBase = window.location.pathname.match(/^\/preview-source\/[^/]+/)?.[0] || "";
  return `${previewBase}${path.startsWith("/") ? path : `/${path}`}`;
}

function requestUrl(path: string): string {
  return API_URL ? `${API_URL}${path}` : runtimePath(path);
}

const TOKEN_KEY = "pointer_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type { DeploymentCapabilities };

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean; // attach the JWT (default true)
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(requestUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Redirect to login on auth failure for management calls.
  if (res.status === 401 && auth) {
    clearToken();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = runtimePath("/login");
    }
  }

  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.error || (typeof data === "string" ? data : res.statusText);
    throw new ApiError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function getDeploymentCapabilities(): Promise<DeploymentCapabilities> {
  return request<unknown>("/.well-known/pointer", { auth: false })
    .then(parseDeploymentCapabilities);
}

export async function streamModelTest(
  body: { providerId: string; providerAccountId: string; modelId: string; prompt: string; maxTokens: number },
  handlers: {
    onDelta: (text: string) => void;
    onReasoningDelta: (text: string) => void;
    onDone: (finishReason: string | null) => void;
    onError: (message: string) => void;
  },
) {
  const token = getToken();
  const response = await fetch(requestUrl("/api/test-model"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    const error = payload?.error;
    const message = typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : `Model test failed (${response.status})`;
    handlers.onError(message);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed = false;
  let finishReason: string | null = null;
  let sawDone = false;
  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim();
    if (!value) return;
    if (value === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      const event = JSON.parse(value);
      const streamError = event?.error;
      if (streamError && !failed) {
        failed = true;
        handlers.onError(
          typeof streamError.message === "string"
            ? streamError.message
            : "The model stream failed before completion."
        );
        return;
      }
      if (failed) return;
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        handlers.onReasoningDelta(delta.reasoning_content);
      }
      if (typeof delta?.content === "string" && delta.content) {
        handlers.onDelta(delta.content);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    } catch { /* Ignore SSE keepalives. */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line.replace(/\r$/, ""));
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer.replace(/\r$/, ""));
  if (failed) return;
  if (!sawDone) {
    handlers.onError("The model stream ended before completion.");
    return;
  }
  handlers.onDone(finishReason);
}

// ── Streaming proxy call (uses a ptr_ API key, not the JWT) ────
// Streams /v1/chat/completions SSE and invokes onDelta for each content chunk.
export async function streamChat(
  apiKey: string,
  body: unknown,
  handlers: { onDelta: (text: string) => void; onDone: () => void; onError: (msg: string) => void }
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(requestUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    handlers.onError(`network error: ${err?.message || err}`);
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text)?.error?.message || text;
    } catch {
      /* keep raw */
    }
    handlers.onError(`${res.status}: ${msg}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        handlers.onDone();
        return;
      }
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) handlers.onDelta(delta);
      } catch {
        // ignore keepalive / non-JSON lines
      }
    }
  }
  handlers.onDone();
}
