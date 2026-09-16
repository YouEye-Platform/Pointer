"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconAvatar } from "@/components/IconAvatar";
import { api, ApiError } from "@/lib/api";
import { formatPrice, formatTokens } from "@/lib/catalog";
import { Modal } from "@/components/Modal";

interface ProviderDetail {
  id: string;
  name: string;
  type: string;
  authType: string;
  status: string;
  iconKey: string;
  modelCount: number;
  auth: {
    type: string;
    connectLabel: string | null;
    deviceFlowSupported: boolean;
  };
  keyStatus: {
    configured: boolean;
    label?: string;
    createdAt?: string;
    credentialType?: "api_key" | "oauth2";
  };
  operations: {
    balance: {
      supported: boolean;
      value: number | null;
      status?: string;
      error?: string | null;
      updatedAt: string | null;
    };
    rateLimits: {
      supported: boolean;
      data?: Record<string, string>;
      updatedAt: string | null;
    };
    account: {
      supported: boolean;
      reason?: string;
      data?: Record<string, unknown> | null;
      status?: string;
      error?: string | null;
      updatedAt?: string | null;
    };
  };
  models: Array<{
    id: string;
    modelId: string;
    canonicalSlug: string | null;
    name: string | null;
    providerModelId: string;
    inputPrice: string | null;
    outputPrice: string | null;
    contextWindow: number | null;
    maxOutput: number | null;
    supportsStreaming: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
    nativeFormat: "chat-completions" | "messages" | "responses" | null;
    nativeEndpoint: string | null;
    priceFetchedAt: string | null;
  }>;
}

interface Stats {
  sample: { requests: number; confidence: string };
  totals: {
    successRate: number | null;
    totalCost: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  latency: { p50: number | null; p95: number | null };
  ttfb: { p50: number | null };
  throughput: { avg: number | null };
}

type DeviceFlow = {
  state: "starting" | "waiting" | "success" | "error";
  flowId?: string;
  code?: string;
  url?: string;
  expiresAt?: string;
  error?: string;
};

type LegacyCodexFlow = {
  state: "starting" | "waiting" | "success" | "error";
  code?: string;
  url?: string;
  error?: string;
};

export default function ProviderDetailPage() {
  const id = decodeURIComponent(String(useParams().id));
  const encodedId = encodeURIComponent(id);
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlow | null>(null);
  const [codex, setCodex] = useState<LegacyCodexFlow | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    setError("");
    try {
      const [detail, performance] = await Promise.all([
        api.get<ProviderDetail>(`/api/providers/${encodedId}`),
        api.get<Stats>(`/api/stats/provider/${encodedId}?days=30`),
      ]);
      setProvider(detail);
      setStats(performance);
      setLabel(detail.keyStatus.label || "Default");
    } catch (reason) {
      setError(
        reason instanceof ApiError ? reason.message : "Failed to load provider"
      );
    }
  }

  useEffect(() => {
    load();
    // The decoded route ID is the stable dependency for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(
    () => () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    },
    []
  );

  function stopPolling() {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }

  function scheduleDevicePoll(flowId: string, delaySeconds: number) {
    stopPolling();
    pollRef.current = setTimeout(async () => {
      try {
        const result = await api.post<{
          status: "pending" | "connected" | "denied" | "expired";
          retryAfter?: number;
        }>(`/api/providers/${encodedId}/oauth/device/${encodeURIComponent(flowId)}/poll`);

        if (result.status === "pending") {
          scheduleDevicePoll(flowId, result.retryAfter ?? 5);
          return;
        }
        if (result.status === "connected") {
          stopPolling();
          setDeviceFlow({ state: "success" });
          await load();
          return;
        }
        stopPolling();
        setDeviceFlow({
          state: "error",
          error:
            result.status === "denied"
              ? "Authorization was denied."
              : "The authorization code expired. Start again.",
        });
      } catch (reason) {
        stopPolling();
        setDeviceFlow({
          state: "error",
          error:
            reason instanceof ApiError
              ? reason.message
              : "Authorization polling failed",
        });
      }
    }, Math.max(1, delaySeconds) * 1000);
  }

  async function startDeviceLogin() {
    setDeviceFlow({ state: "starting" });
    try {
      const started = await api.post<{
        flowId: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string | null;
        interval: number;
        expiresAt: string;
      }>(`/api/providers/${encodedId}/oauth/device/start`);

      setDeviceFlow({
        state: "waiting",
        flowId: started.flowId,
        code: started.userCode,
        url: started.verificationUriComplete || started.verificationUri,
        expiresAt: started.expiresAt,
      });
      scheduleDevicePoll(started.flowId, started.interval);
    } catch (reason) {
      setDeviceFlow({
        state: "error",
        error:
          reason instanceof ApiError
            ? reason.message
            : "Could not start account sign-in",
      });
    }
  }

  async function closeDeviceFlow() {
    const flowId = deviceFlow?.flowId;
    stopPolling();
    setDeviceFlow(null);
    if (flowId) {
      try {
        await api.del(
          `/api/providers/${encodedId}/oauth/device/${encodeURIComponent(flowId)}`
        );
      } catch {
        // Expired or already-completed flows require no cleanup action.
      }
    }
  }

  async function startCodexLogin() {
    setCodex({ state: "starting" });
    try {
      const started = await api.post<{
        deviceAuthId: string;
        userCode: string;
        verificationUrl: string;
        interval: number;
      }>("/api/codex-auth/start");
      setCodex({
        state: "waiting",
        code: started.userCode,
        url: started.verificationUrl,
      });

      const poll = async () => {
        try {
          const result = await api.post<{ status: string; error?: string }>(
            "/api/codex-auth/poll",
            {
              deviceAuthId: started.deviceAuthId,
              userCode: started.userCode,
              providerId: id,
            }
          );
          if (result.status === "success") {
            stopPolling();
            setCodex({ state: "success" });
            await load();
            return;
          }
          if (result.status === "error") {
            stopPolling();
            setCodex({ state: "error", error: result.error });
            return;
          }
          pollRef.current = setTimeout(poll, started.interval * 1000);
        } catch {
          pollRef.current = setTimeout(poll, started.interval * 1000);
        }
      };
      pollRef.current = setTimeout(poll, started.interval * 1000);
    } catch (reason) {
      setCodex({
        state: "error",
        error:
          reason instanceof ApiError
            ? reason.message
            : "Could not start Codex login",
      });
    }
  }

  function closeCodex() {
    stopPolling();
    setCodex(null);
  }

  async function action(name: string, path: string, body?: unknown) {
    setBusy(name);
    setError("");
    try {
      await api.post(path, body);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : `${name} failed`);
    } finally {
      setBusy("");
    }
  }

  async function saveCredential(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey) return;
    await action("credential", `/api/providers/${encodedId}/keys`, {
      apiKey,
      label,
    });
    setApiKey("");
  }

  async function rename() {
    setBusy("rename");
    try {
      await api.put(`/api/providers/${encodedId}/keys/label`, { label });
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Rename failed");
    } finally {
      setBusy("");
    }
  }

  async function removeCredential() {
    if (!confirm("Disconnect this provider account and remove its credential?")) {
      return;
    }
    setBusy("remove");
    try {
      await api.del(`/api/providers/${encodedId}/keys`);
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Remove failed");
    } finally {
      setBusy("");
    }
  }

  if (!provider) {
    return (
      <div>
        {error ? <div className="notice danger">{error}</div> : "Loading provider..."}
      </div>
    );
  }

  const isOAuth =
    provider.auth.type === "oauth-device-flow"
    || provider.auth.type === "oauth-pkce";
  const hasGenericDeviceFlow =
    provider.auth.type === "oauth-device-flow"
    && provider.auth.deviceFlowSupported;
  const usesLegacyCodexFlow =
    provider.auth.type === "oauth-device-flow"
    && !hasGenericDeviceFlow
    && provider.id.startsWith("openai-codex");
  const models = provider.models.filter((model) =>
    `${model.name || ""} ${model.providerModelId}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
  const accountPlan =
    provider.operations.account.data?.subscriptionTier
    ?? provider.operations.account.data?.planType;

  return (
    <div>
      <Link href="/providers" className="back-link">
        Back to providers
      </Link>

      <div className="spread page-head">
        <div className="model-identity">
          <IconAvatar iconKey={provider.iconKey} name={provider.name} />
          <div>
            <p className="eyebrow">Provider</p>
            <h1>{provider.name}</h1>
            <span className="mono muted">{provider.id}</span>
          </div>
        </div>
        <span className={`badge ${provider.status === "active" ? "success" : ""}`}>
          {provider.status}
        </span>
      </div>

      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}

      <div className="detail-grid">
        <section className="card">
          <h2>Connection</h2>
          <dl>
            <div>
              <dt>Protocol</dt>
              <dd>{provider.type}</dd>
            </div>
            <div>
              <dt>Credential</dt>
              <dd>
                {provider.keyStatus.configured
                  ? provider.keyStatus.label || "Connected"
                  : "Missing"}
              </dd>
            </div>
            <div>
              <dt>Models</dt>
              <dd>{provider.modelCount}</dd>
            </div>
          </dl>
          <div className="row">
            <button
              disabled={!!busy || !provider.keyStatus.configured}
              onClick={() =>
                action("test", `/api/providers/${encodedId}/test`)
              }
            >
              Test connection
            </button>
            <button
              disabled={!!busy || !provider.keyStatus.configured}
              onClick={() =>
                action("sync", `/api/providers/${encodedId}/sync`)
              }
            >
              Refresh models
            </button>
            {hasGenericDeviceFlow && (
              <button className="btn-primary" onClick={startDeviceLogin}>
                {provider.keyStatus.configured
                  ? "Reconnect account"
                  : provider.auth.connectLabel || "Connect account"}
              </button>
            )}
            {usesLegacyCodexFlow && (
              <button className="btn-primary" onClick={startCodexLogin}>
                Login with Codex
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Operations</h2>
          <dl>
            <div>
              <dt>Balance</dt>
              <dd>
                {provider.operations.balance.supported
                  ? provider.operations.balance.value == null
                    ? provider.operations.balance.status || "Unknown"
                    : `$${provider.operations.balance.value.toFixed(2)}`
                  : "Not supported"}
              </dd>
            </div>
            <div>
              <dt>Rate limits</dt>
              <dd>
                {provider.operations.rateLimits.supported
                  ? `Updated ${provider.operations.rateLimits.updatedAt || "unknown"}`
                  : "Not observed"}
              </dd>
            </div>
            <div>
              <dt>Account info</dt>
              <dd>
                {provider.operations.account.supported
                  ? `${provider.operations.account.status || "pending"}${
                      accountPlan ? ` · ${String(accountPlan)}` : ""
                    }`
                  : "Not supported"}
              </dd>
            </div>
          </dl>
          <div className="row">
            {provider.operations.balance.supported && (
              <button
                disabled={!!busy || !provider.keyStatus.configured}
                onClick={() =>
                  action("balance", `/api/providers/${encodedId}/balance`)
                }
              >
                Refresh balance
              </button>
            )}
            {provider.operations.account.supported && (
              <button
                disabled={!!busy || !provider.keyStatus.configured}
                onClick={() =>
                  action("account", `/api/providers/${encodedId}/account`)
                }
              >
                Refresh account
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2>30-day performance</h2>
          <dl>
            <div>
              <dt>Requests</dt>
              <dd>
                {stats?.sample.requests ?? 0} ({stats?.sample.confidence ?? "low"}{" "}
                confidence)
              </dd>
            </div>
            <div>
              <dt>Success</dt>
              <dd>
                {stats?.totals.successRate == null
                  ? "Unknown"
                  : `${stats.totals.successRate.toFixed(1)}%`}
              </dd>
            </div>
            <div>
              <dt>Latency p50 / p95</dt>
              <dd>
                {stats?.latency.p50 == null
                  ? "Unknown"
                  : `${stats.latency.p50.toFixed(0)} / ${
                      stats.latency.p95?.toFixed(0) ?? "-"
                    } ms`}
              </dd>
            </div>
            <div>
              <dt>TTFB / throughput</dt>
              <dd>
                {stats?.ttfb.p50 == null
                  ? "Unknown"
                  : `${stats.ttfb.p50.toFixed(0)} ms`}{" "}
                /{" "}
                {stats?.throughput.avg == null
                  ? "Unknown"
                  : `${stats.throughput.avg.toFixed(1)} t/s`}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>{isOAuth ? "Connected account" : "Credential"}</h2>
        {isOAuth ? (
          <p className="muted">
            Pointer stores the provider-issued session and refresh
            credentials encrypted. Your account password is never entered here.
          </p>
        ) : (
          <form className="row" onSubmit={saveCredential}>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                provider.keyStatus.configured ? "Replace API key" : "API key"
              }
              aria-label="Provider API key"
            />
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label"
              aria-label="Credential label"
            />
            <button className="btn-primary" disabled={!apiKey || !!busy}>
              Save securely
            </button>
          </form>
        )}
        {provider.keyStatus.configured && (
          <div className="row" style={{ marginTop: 8 }}>
            {isOAuth && (
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Label"
                aria-label="Credential label"
              />
            )}
            <button disabled={!!busy} onClick={rename}>
              Rename
            </button>
            <button
              className="btn-danger"
              disabled={!!busy}
              onClick={removeCredential}
            >
              {isOAuth ? "Disconnect account" : "Remove credential"}
            </button>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <div className="spread">
          <div>
            <h2>Model inventory</h2>
            <p className="muted">
              Friendly canonical names with provider IDs and native protocols
              retained for routing diagnostics.
            </p>
          </div>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
            aria-label="Search provider models"
          />
        </div>
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider ID</th>
                <th>Input / output</th>
                <th>Context</th>
                <th>Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td>
                    {model.canonicalSlug ? (
                      <Link href={`/models/${encodeURIComponent(model.canonicalSlug)}`}>
                        <strong>{model.name || model.modelId}</strong>
                      </Link>
                    ) : (
                      <strong>{model.name || model.modelId}</strong>
                    )}
                  </td>
                  <td className="mono muted">{model.providerModelId}</td>
                  <td>
                    {formatPrice(
                      model.inputPrice == null ? null : Number(model.inputPrice)
                    )}{" "}
                    /{" "}
                    {formatPrice(
                      model.outputPrice == null ? null : Number(model.outputPrice)
                    )}
                  </td>
                  <td>{formatTokens(model.contextWindow)}</td>
                  <td>
                    <div className="badge-row">
                      {model.nativeFormat && (
                        <span className="badge">{model.nativeFormat}</span>
                      )}
                      {model.supportsTools && <span className="badge">tools</span>}
                      {model.supportsVision && <span className="badge">vision</span>}
                      {model.supportsStreaming && (
                        <span className="badge">streaming</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {deviceFlow && (
        <Modal
          title={provider.auth.connectLabel || `Connect ${provider.name}`}
          onClose={closeDeviceFlow}
        >
          <p>
            Sign in on the provider&apos;s secure site. Pointer will only
            receive the authorization result.
          </p>
          {deviceFlow.state === "starting" && (
            <p className="muted">Starting device authorization…</p>
          )}
          {deviceFlow.state === "waiting" && (
            <div className="stack">
              <p>Open the verification page and enter this one-time code:</p>
              <code className="device-code">{deviceFlow.code}</code>
              <a
                className="btn-primary"
                href={deviceFlow.url}
                target="_blank"
                rel="noreferrer"
              >
                Open secure sign-in
              </a>
              <p className="muted" role="status">
                Waiting for authorization
                {deviceFlow.expiresAt
                  ? ` · expires ${new Date(deviceFlow.expiresAt).toLocaleTimeString()}`
                  : ""}
                …
              </p>
            </div>
          )}
          {deviceFlow.state === "success" && (
            <div className="notice success">
              {provider.name} is connected. Account and model discovery are
              refreshing in the background.
            </div>
          )}
          {deviceFlow.state === "error" && (
            <div className="stack">
              <div className="notice danger">
                {deviceFlow.error || "Authorization failed"}
              </div>
              <button className="btn-primary" onClick={startDeviceLogin}>
                Try again
              </button>
            </div>
          )}
        </Modal>
      )}

      {codex && (
        <Modal title="Login with Codex" onClose={closeCodex}>
          <p>Authenticate with your OpenAI account using the Codex device flow.</p>
          {codex.state === "starting" && (
            <p className="muted">Starting device authorization…</p>
          )}
          {codex.state === "waiting" && (
            <div className="stack">
              <p>Open the verification page and enter:</p>
              <code className="device-code">{codex.code}</code>
              <a
                className="btn-primary"
                href={codex.url}
                target="_blank"
                rel="noreferrer"
              >
                Open verification page
              </a>
              <p className="muted">Waiting for authorization…</p>
            </div>
          )}
          {codex.state === "success" && (
            <div className="notice success">Codex is connected.</div>
          )}
          {codex.state === "error" && (
            <div className="notice danger">
              {codex.error || "Authorization failed"}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
