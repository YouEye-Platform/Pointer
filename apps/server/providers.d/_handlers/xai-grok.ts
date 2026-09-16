import {
  OAuthCredentialRefreshError,
  type OAuthCredential,
  type OAuthDeviceAuthorization,
  type OAuthDevicePollResult,
  type IProviderHandler,
  type ProviderManifest,
  type ProxyRequest,
  type RequestContext,
  type StaticModel,
} from "../../src/providers/types";
import type { JsonObject } from "../../src/gateway/protocol/v1/schemas";
import { resolveProviderGatewayEndpoint } from "../../src/gateway/provider-operation";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const MAX_JSON_BYTES = 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function handlerString(
  config: ProviderManifest,
  key: string,
  fallback: string
): string {
  return stringField(config.handlerConfig?.[key]) ?? fallback;
}

function clientHeaders(config: ProviderManifest): Record<string, string> {
  return {
    "x-grok-client-version": handlerString(config, "clientVersion", "0.2.112"),
    "x-grok-client-identifier": handlerString(
      config,
      "clientIdentifier",
      "pointer"
    ),
    "x-grok-client-mode": handlerString(config, "clientMode", "headless"),
  };
}

function issuer(config: ProviderManifest): string {
  if (!config.auth.issuer) throw new Error("OAuth issuer is not configured");
  return config.auth.issuer.replace(/\/$/, "");
}

function clientId(config: ProviderManifest): string {
  if (!config.auth.clientId) throw new Error("OAuth client ID is not configured");
  return config.auth.clientId;
}

function safeUrl(value: unknown): string {
  const raw = stringField(value);
  if (!raw) throw new Error("OAuth server returned a missing verification URL");
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("OAuth verification URL must use HTTPS");
  }
  if (!["auth.x.ai", "accounts.x.ai"].includes(url.hostname)) {
    throw new Error("OAuth verification URL uses an unexpected host");
  }
  return url.toString();
}

function parseJwtClaims(token: string): UnknownRecord | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    return asRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function tokenUserId(token: string): string | undefined {
  const claims = parseJwtClaims(token);
  return stringField(claims?.sub)
    ?? stringField(claims?.user_id)
    ?? stringField(claims?.userId);
}

function sessionHeaders(
  config: ProviderManifest,
  accessToken: string,
  providerUserId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    ...clientHeaders(config),
  };
  const userId = providerUserId ?? tokenUserId(accessToken);
  if (userId) headers["x-userid"] = userId;
  return headers;
}

async function jsonRecord(response: Response): Promise<UnknownRecord> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new Error("Provider response exceeded the size limit");
  }
  if (!response.body) throw new Error("Provider returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error("Provider response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Provider returned an invalid JSON response");
  }
  const record = asRecord(value);
  if (!record) throw new Error("Provider returned an invalid JSON response");
  return record;
}

function oauthCredentialFromResponse(data: UnknownRecord): OAuthCredential {
  const accessToken = stringField(data.access_token);
  if (!accessToken) throw new Error("OAuth token response did not include an access token");
  const expiresIn = numberField(data.expires_in);
  const idToken = stringField(data.id_token);
  const userId = idToken ? tokenUserId(idToken) : tokenUserId(accessToken);
  return {
    accessToken,
    ...(stringField(data.refresh_token)
      ? { refreshToken: stringField(data.refresh_token) }
      : {}),
    ...(expiresIn !== undefined
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    ...(stringField(data.token_type)
      ? { tokenType: stringField(data.token_type) }
      : {}),
    ...(stringField(data.scope) ? { scope: stringField(data.scope) } : {}),
    ...(userId ? { userId } : {}),
  };
}

function oauthError(data: UnknownRecord): string {
  return stringField(data.error) ?? "oauth_error";
}

function modelBackend(model: UnknownRecord): NonNullable<StaticModel["nativeFormat"]> {
  const raw = stringField(model.apiBackend)
    ?? stringField(model.api_backend)
    ?? "chat_completions";
  if (raw === "responses") return "responses";
  if (raw === "messages") return "messages";
  return "chat-completions";
}

function backendEndpoint(format: NonNullable<StaticModel["nativeFormat"]>): string {
  if (format === "responses") return "/responses";
  if (format === "messages") return "/messages";
  return "/chat/completions";
}

function staticModel(value: unknown): StaticModel | null {
  const model = asRecord(value);
  if (!model) return null;
  const meta = asRecord(model._meta);
  const id = stringField(model.model)
    ?? stringField(model.modelId)
    ?? stringField(model.id)
    ?? stringField(meta?.model)
    ?? stringField(meta?.modelId);
  if (!id) return null;
  const nativeFormat = modelBackend(model);
  const contextWindow = numberField(model.contextWindow)
    ?? numberField(model.context_window)
    ?? numberField(meta?.contextWindow)
    ?? numberField(meta?.totalContextTokens);
  const maxOutput = numberField(model.maxCompletionTokens)
    ?? numberField(model.max_completion_tokens);
  const supportsVision =
    booleanField(model.supportsVision)
    ?? booleanField(model.supports_vision);

  return {
    id,
    name: stringField(model.name) ?? id,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    supportsStreaming: true,
    supportsTools:
      booleanField(model.supportsTools)
      ?? booleanField(model.supports_tools)
      ?? true,
    ...(supportsVision !== undefined ? { supportsVision } : {}),
    nativeFormat,
    nativeEndpoint: backendEndpoint(nativeFormat),
  };
}

async function fetchSessionJson(
  config: ProviderManifest,
  accessToken: string,
  path: string,
  credential?: OAuthCredential
): Promise<{ response: Response; data: UnknownRecord }> {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}${path}`,
    {
      headers: {
        Accept: "application/json",
        ...sessionHeaders(config, accessToken, credential?.userId),
      },
      signal: AbortSignal.timeout(15_000),
    }
  );
  const data = await jsonRecord(response);
  return { response, data };
}

const handler: IProviderHandler = {
  async transformRequest(
    req: ProxyRequest,
    ctx: RequestContext,
    config: ProviderManifest
  ): Promise<{ url: string; headers: Record<string, string>; body: JsonObject }> {
    const endpoint = resolveProviderGatewayEndpoint(
      config,
      ctx.providerNativeEndpoint
    );
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
      throw new Error("Invalid xAI Grok provider endpoint");
    }

    const include = Array.isArray(req.include) ? [...req.include] : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
    }
    const body: JsonObject = {
      ...req,
      model: ctx.providerModelId || req.model,
      // xAI's current grok-build client uses Responses SSE for generation.
      // Pointer consumes that stream when the public caller requested JSON.
      stream: true,
      ...(req.store === undefined ? { store: false } : {}),
      include,
    };
    return {
      url: `${config.baseUrl.replace(/\/$/, "")}${endpoint}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...sessionHeaders(config, ctx.providerApiKey, ctx.providerUserId),
      },
      body,
    };
  },

  buildHeaders(ctx: RequestContext, config: ProviderManifest) {
    return sessionHeaders(config, ctx.providerApiKey, ctx.providerUserId);
  },

  async startDeviceAuthorization(
    config: ProviderManifest
  ): Promise<OAuthDeviceAuthorization> {
    const response = await fetch(`${issuer(config)}/oauth2/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-grok-client-surface": "ui",
        ...clientHeaders(config),
      },
      body: new URLSearchParams({
        client_id: clientId(config),
        scope: config.auth.scopes ?? "",
        referrer: "pointer",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await jsonRecord(response);
    if (!response.ok) {
      throw new Error(`Device authorization request failed (${response.status})`);
    }

    const deviceCode = stringField(data.device_code);
    const userCode = stringField(data.user_code);
    const expiresIn = numberField(data.expires_in);
    if (!deviceCode || !userCode || expiresIn === undefined) {
      throw new Error("OAuth server returned an incomplete device authorization");
    }
    if (!/^[A-Za-z0-9-]+$/.test(userCode)) {
      throw new Error("OAuth server returned an invalid user code");
    }
    const verificationUri = safeUrl(data.verification_uri);
    return {
      deviceCode,
      userCode,
      verificationUri,
      ...(data.verification_uri_complete
        ? { verificationUriComplete: safeUrl(data.verification_uri_complete) }
        : {}),
      expiresIn: Math.max(1, Math.floor(expiresIn)),
      interval: Math.max(
        1,
        Math.floor(numberField(data.interval) ?? DEFAULT_INTERVAL_SECONDS)
      ),
    };
  },

  async pollDeviceAuthorization(
    config: ProviderManifest,
    deviceCode: string
  ): Promise<OAuthDevicePollResult> {
    const response = await fetch(`${issuer(config)}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-grok-client-surface": "ui",
        ...clientHeaders(config),
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: clientId(config),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await jsonRecord(response);
    if (response.ok) {
      return { status: "success", credential: oauthCredentialFromResponse(data) };
    }

    const error = oauthError(data);
    if (error === "authorization_pending") return { status: "pending" };
    if (error === "slow_down") {
      return {
        status: "pending",
        interval: DEFAULT_INTERVAL_SECONDS + SLOW_DOWN_INCREMENT_SECONDS,
      };
    }
    if (error === "access_denied") {
      return { status: "denied", error: "Authorization was denied" };
    }
    if (error === "expired_token") {
      return { status: "expired", error: "Device authorization expired" };
    }
    throw new Error(`OAuth token exchange failed (${response.status}, ${error})`);
  },

  async refreshOAuthCredential(
    config: ProviderManifest,
    credential: OAuthCredential
  ): Promise<OAuthCredential> {
    if (!credential.refreshToken) {
      throw new Error("OAuth credential has no refresh token");
    }
    const response = await fetch(`${issuer(config)}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...clientHeaders(config),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: clientId(config),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await jsonRecord(response);
    if (!response.ok) {
      const error = oauthError(data);
      throw new OAuthCredentialRefreshError(
        `OAuth refresh failed (${response.status}, ${error})`,
        error === "invalid_grant" || error === "invalid_client"
      );
    }
    return oauthCredentialFromResponse(data);
  },

  async fetchModels(
    config: ProviderManifest,
    accessToken: string,
    credential?: OAuthCredential
  ) {
    const { response, data } = await fetchSessionJson(
      config,
      accessToken,
      config.endpoints?.models ?? "/models",
      credential
    );
    if (!response.ok) {
      throw new Error(`Provider models request failed (${response.status})`);
    }
    const values = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    return values.flatMap((value) => {
      const parsed = staticModel(value);
      return parsed ? [parsed] : [];
    });
  },

  async getAccountInfo(
    accessToken: string,
    config: ProviderManifest,
    credential?: OAuthCredential
  ) {
    const { response, data } = await fetchSessionJson(
      config,
      accessToken,
      "/user?include=subscription",
      credential
    );
    if (!response.ok) {
      throw new Error(`Provider account request failed (${response.status})`);
    }
    const userId = stringField(data.userId) ?? stringField(data.user_id);
    return {
      connected: true,
      subscriptionTier:
        stringField(data.subscriptionTier)
        ?? stringField(data.subscription_tier)
        ?? null,
      principalType:
        stringField(data.principalType)
        ?? stringField(data.principal_type)
        ?? null,
      userIdSuffix: userId ? userId.slice(-6) : null,
      blocked: Boolean(
        stringField(data.userBlockedReason)
        ?? stringField(data.user_blocked_reason)
      ),
    };
  },

  async testConnection(
    config: ProviderManifest,
    accessToken: string,
    credential?: OAuthCredential
  ) {
    try {
      const models = await this.fetchModels!(config, accessToken, credential);
      return models.length > 0
        ? { success: true, status: 200 }
        : {
            success: false,
            status: 200,
            error: "Provider returned no available models",
          };
    } catch (error) {
      return {
        success: false,
        status: 400,
        error: error instanceof Error ? error.message : "Connection test failed",
      };
    }
  },
};

export default handler;
