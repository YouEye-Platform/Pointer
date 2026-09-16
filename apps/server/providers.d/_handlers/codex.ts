import type {
  IProviderHandler,
  OAuthCredential,
  OAuthDeviceAuthorization,
  OAuthDevicePollResult,
  ProviderManifest,
  ProxyRequest,
  RequestContext,
  StaticModel,
} from "../../src/providers/types";
import { OAuthCredentialRefreshError } from "../../src/providers/types";
import { accessTokenExpiry } from "../../src/services/oauth-lifecycle";
import type { JsonObject, JsonValue } from "../../src/gateway/protocol/v1/schemas";
import { jsonObjectSchema } from "../../src/gateway/protocol/v1/schemas";
import { stableGatewayId } from "../../src/gateway/protocol/v1/common";
import { nanoid } from "nanoid";
import { buildProviderGatewayOperationUrl } from "../../src/gateway/provider-operation";

const MODELS_CATALOG_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
// The backend treats 0.0.0 as an unversioned client. Using Pointer's package
// version incorrectly applies Codex CLI rollout filters and can hide all models.
const CODEX_CLIENT_VERSION = "0.0.0";
const DEFAULT_DEVICE_EXPIRES_SECONDS = 15 * 60;
const DEFAULT_DEVICE_POLL_SECONDS = 5;

function oauthIssuer(config: ProviderManifest): string {
  const issuer = config.auth.issuer?.replace(/\/$/, "");
  if (!issuer || new URL(issuer).protocol !== "https:") {
    throw new Error("Codex OAuth issuer is not configured as HTTPS");
  }
  return issuer;
}

function oauthClientId(config: ProviderManifest): string {
  if (!config.auth.clientId) throw new Error("Codex OAuth client ID is not configured");
  return config.auth.clientId;
}

function oauthCredential(data: JsonObject): OAuthCredential {
  const accessToken = stringField(data.access_token);
  if (!accessToken) throw new Error("Authorization response did not contain an access token");
  const expiresIn = numberField(data.expires_in);
  return {
    accessToken,
    ...(stringField(data.refresh_token) ? { refreshToken: stringField(data.refresh_token) } : {}),
    expiresAt: expiresIn !== undefined ? new Date(Date.now() + Math.max(1, expiresIn) * 1000).toISOString()
      : accessTokenExpiry(accessToken) ?? new Date(Date.now() + 5 * 60_000).toISOString(),
    ...(stringField(data.token_type) ? { tokenType: stringField(data.token_type) } : {}),
    ...(stringField(data.scope) ? { scope: stringField(data.scope) } : {}),
  };
}

function deviceFlowEnvelope(value: string): { deviceAuthId: string; userCode: string } {
  const data = parseObjectJson(value);
  const deviceAuthId = stringField(data?.deviceAuthId);
  const userCode = stringField(data?.userCode);
  if (!deviceAuthId || !userCode) throw new Error("Codex device authorization state is invalid");
  return { deviceAuthId, userCode };
}

function asObject(value: unknown): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseObjectJson(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return asObject(parsed);
  } catch {
    return null;
  }
}

function stringField(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectField(value: JsonValue | undefined): JsonObject | undefined {
  return asObject(value) ?? undefined;
}

function arrayField(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function textFromContent(value: JsonValue | undefined, allowedTypes: ReadonlySet<string>): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    const block = asObject(part);
    const type = stringField(block?.type);
    const text = stringField(block?.text);
    return type && text && allowedTypes.has(type) ? [text] : [];
  }).join("\n");
}

function jsonString(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

// Current tokens use chatgpt_account_id; retain legacy account_id compatibility.
function extractAccountId(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const payload = parseObjectJson(Buffer.from(b64, "base64").toString());
  if (!payload) return null;
  const auth = objectField(payload["https://api.openai.com/auth"]);
  return stringField(auth?.chatgpt_account_id)
    ?? stringField(payload.chatgpt_account_id)
    ?? stringField(auth?.account_id)
    ?? stringField(payload.account_id)
    ?? null;
}

function safeAccountInfo(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) return { connected: true, tokenType: "opaque" };
  try {
    const payload = parseObjectJson(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!payload) return { connected: true, tokenType: "opaque" };
    const accountId = extractAccountId(jwt);
    const auth = objectField(payload["https://api.openai.com/auth"]);
    const planType = stringField(auth?.chatgpt_plan_type) ?? stringField(payload.chatgpt_plan_type);
    const expiresAt = numberField(payload.exp);
    return {
      connected: true,
      accountIdSuffix: accountId ? accountId.slice(-6) : null,
      planType: planType ?? null,
      expiresAt: expiresAt === undefined ? null : new Date(expiresAt * 1000).toISOString(),
    };
  } catch { return { connected: true, tokenType: "opaque" }; }
}

const ASSISTANT_TEXT_TYPES = new Set(["text", "output_text"]);
const INPUT_TEXT_TYPES = new Set(["text", "input_text"]);

// Convert validated JSON chat messages to Responses API input items.
function messagesToResponseItems(messages: readonly JsonValue[]): JsonObject[] {
  const items: JsonObject[] = [];
  for (const [messageIndex, value] of messages.entries()) {
    const msg = asObject(value);
    if (!msg) continue;
    const role = stringField(msg.role);
    if (role === "system") continue;

    // Handle assistant messages with tool_calls → function_call items
    const toolCalls = arrayField(msg.tool_calls);
    if (role === "assistant" && toolCalls) {
      for (const [toolIndex, toolValue] of toolCalls.entries()) {
        const tc = asObject(toolValue);
        if (!tc) continue;
        const fn = objectField(tc.function);
        items.push({
          type: "function_call",
          call_id: stringField(tc.id) ?? stableGatewayId("call", String(messageIndex), String(toolIndex), JSON.stringify(tc)),
          name: stringField(fn?.name) ?? "",
          arguments: stringField(fn?.arguments) ?? "{}",
        });
      }
      // Also emit text content if present alongside tool calls
      const text = textFromContent(msg.content, ASSISTANT_TEXT_TYPES);
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }

    // Handle tool result messages → function_call_output items
    if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: stringField(msg.tool_call_id) ?? "",
        output: jsonString(msg.content),
      });
      continue;
    }

    const text = textFromContent(msg.content, role === "assistant" ? ASSISTANT_TEXT_TYPES : INPUT_TEXT_TYPES);
    if (!text) continue;
    items.push({
      type: "message",
      role: role === "assistant" ? "assistant" : "user",
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    });
  }
  return items;
}

// Flatten Chat Completions nested tools to Responses API flat format
function flattenToolsForResponses(tools: readonly JsonValue[]): JsonObject[] {
  const flattened: JsonObject[] = [];
  for (const value of tools) {
    const tool = asObject(value);
    if (!tool) continue;
    const fn = objectField(tool.function);
    if (tool.type === "function" && fn) {
      flattened.push({
        type: "function",
        ...(stringField(fn.name) ? { name: stringField(fn.name) } : {}),
        ...(stringField(fn.description) ? { description: stringField(fn.description) } : {}),
        ...(objectField(fn.parameters) ? { parameters: objectField(fn.parameters) } : {}),
        ...(booleanField(fn.strict) !== undefined ? { strict: booleanField(fn.strict) } : {}),
      });
      continue;
    }
    flattened.push(tool);
  }
  return flattened;
}

function modelRecords(value: unknown): JsonObject[] {
  const root = asObject(value);
  const candidates = Array.isArray(value)
    ? value
    : arrayField(root?.models) ?? arrayField(root?.data) ?? [];
  return candidates.flatMap((candidate) => {
    const model = asObject(candidate);
    return model ? [model] : [];
  });
}

function toStaticModel(model: JsonObject): StaticModel | null {
  const id = stringField(model.slug) ?? stringField(model.id);
  if (!id || model.visibility === "hidden") return null;
  const contextWindow = numberField(model.context_window) ?? numberField(model.max_context_window);
  const inputModalities = arrayField(model.input_modalities);
  return {
    id,
    name: stringField(model.display_name) ?? stringField(model.name) ?? id,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    supportsTools: booleanField(model.supports_parallel_tool_calls) ?? false,
    supportsVision: inputModalities?.includes("image") ?? false,
  };
}

function staticModels(value: unknown): StaticModel[] {
  return modelRecords(value).flatMap((model) => {
    const parsed = toStaticModel(model);
    return parsed ? [parsed] : [];
  });
}

function codexAuthHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "OAI-Product-Sku": "codex",
  };
  const accountId = extractAccountId(apiKey);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

async function fetchBackendModels(
  config: ProviderManifest,
  apiKey: string,
): Promise<{ ok: boolean; status: number; models: StaticModel[] }> {
  const url = new URL(`${config.baseUrl.replace(/\/$/, "")}/models`);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  const response = await fetch(url, {
    headers: codexAuthHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, status: response.status, models: [] };

  const data: unknown = await response.json();
  return { ok: true, status: response.status, models: staticModels(data) };
}

const handler: IProviderHandler = {
  async startDeviceAuthorization(config): Promise<OAuthDeviceAuthorization> {
    const issuer = oauthIssuer(config);
    const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: oauthClientId(config) }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = parseObjectJson(await response.text());
    if (!response.ok) {
      throw new Error(response.status === 404
        ? "Device code login is not enabled"
        : `Device code request failed (${response.status})`);
    }
    const deviceAuthId = stringField(data?.device_auth_id);
    const userCode = stringField(data?.user_code) ?? stringField(data?.usercode);
    if (!deviceAuthId || !userCode || !/^[A-Za-z0-9-]{4,128}$/.test(userCode)) {
      throw new Error("OAuth server returned an invalid device authorization");
    }
    return {
      deviceCode: JSON.stringify({ deviceAuthId, userCode }),
      userCode,
      verificationUri: `${issuer}/codex/device`,
      expiresIn: Math.max(1, Math.floor(numberField(data?.expires_in) ?? DEFAULT_DEVICE_EXPIRES_SECONDS)),
      interval: Math.max(3, Math.floor(numberField(data?.interval) ?? DEFAULT_DEVICE_POLL_SECONDS)),
    };
  },

  async pollDeviceAuthorization(config, deviceCode): Promise<OAuthDevicePollResult> {
    const issuer = oauthIssuer(config);
    const { deviceAuthId, userCode } = deviceFlowEnvelope(deviceCode);
    const tokenResponse = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: AbortSignal.timeout(15_000),
    });
    if (tokenResponse.status === 403 || tokenResponse.status === 404) {
      return { status: "pending" };
    }
    if (tokenResponse.status === 410) return { status: "expired" };
    const tokenData = parseObjectJson(await tokenResponse.text());
    if (!tokenResponse.ok) {
      throw new Error(`Device authorization failed (${tokenResponse.status})`);
    }
    const authorizationCode = stringField(tokenData?.authorization_code);
    const codeVerifier = stringField(tokenData?.code_verifier);
    if (!authorizationCode || !codeVerifier) return { status: "pending" };

    const exchange = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: `${issuer}/deviceauth/callback`,
        client_id: oauthClientId(config),
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const exchanged = parseObjectJson(await exchange.text());
    if (!exchange.ok) throw new Error(`Authorization code exchange failed (${exchange.status})`);
    return { status: "success", credential: oauthCredential(exchanged ?? {}) };
  },

  async refreshOAuthCredential(config, credential): Promise<OAuthCredential> {
    if (!credential.refreshToken) throw new Error("Codex OAuth credential has no refresh token");
    const response = await fetch(`${oauthIssuer(config)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: oauthClientId(config),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = parseObjectJson(await response.text());
    if (!response.ok) {
      throw new OAuthCredentialRefreshError(
        `Codex OAuth refresh failed (${response.status})`,
        ["invalid_grant", "invalid_token", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]
          .includes(String(data?.error ?? "")),
      );
    }
    return oauthCredential(data ?? {});
  },

  async getAccountInfo(apiKey) {
    return safeAccountInfo(apiKey);
  },
  async testConnection(config, apiKey) {
    const result = await fetchBackendModels(config, apiKey);
    if (!result.ok) {
      return { success: false, status: result.status, error: `Provider returned ${result.status}` };
    }
    return result.models.length > 0
      ? { success: true, status: result.status }
      : { success: false, status: result.status, error: "Provider returned no available models" };
  },
  // Prefer the account-scoped backend catalog and retain the public catalog as last-known fallback.
  async fetchModels(
    config: ProviderManifest,
    apiKey: string
  ): Promise<StaticModel[]> {
    try {
      const result = await fetchBackendModels(config, apiKey);
      if (result.ok && result.models.length > 0) {
        console.log(
          `[codex] Fetched ${result.models.length} models from backend`
        );
        return result.models;
      }
      if (result.ok) {
        console.warn("[codex] Backend returned no available models; using fallback catalog");
      } else {
        console.warn(`[codex] Backend models fetch failed: ${result.status}`);
      }
    } catch (err) {
      console.warn("[codex] Backend models fetch failed:", err);
    }

    // Fallback: GitHub catalog
    try {
      const res = await fetch(MODELS_CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        console.warn(
          `[codex] GitHub catalog fetch failed: ${res.status}`
        );
        return [];
      }
      const data: unknown = await res.json();
      const models = staticModels(data);
      console.log(
        `[codex] Fetched ${models.length} models from GitHub catalog`
      );
      return models;
    } catch (err) {
      console.error("[codex] GitHub catalog error:", err);
      return [];
    }
  },

  // Transform any incoming request (chat completions or responses) to the
  // Codex backend's Responses API format with required headers
  async transformRequest(
    req: ProxyRequest,
    ctx: RequestContext,
    config: ProviderManifest
  ): Promise<{ url: string; headers: Record<string, string>; body: JsonObject }> {
    const url = buildProviderGatewayOperationUrl(config.baseUrl, config);

    const headers: Record<string, string> = {
      ...codexAuthHeaders(ctx.providerApiKey),
      "Content-Type": "application/json",
      "x-codex-installation-id": nanoid(),
    };
    headers["Accept"] = "text/event-stream";

    // Build the Responses API body
    let input: JsonValue[];
    let instructions = stringField(req.instructions) ?? "You are a helpful assistant.";

    if (req.messages) {
      // Chat completions format → convert to Responses API input
      const systemMsg = req.messages
        .map((message) => asObject(message))
        .find((message) => stringField(message?.role) === "system");
      if (systemMsg) {
        instructions = textFromContent(systemMsg.content, INPUT_TEXT_TYPES);
      }
      input = messagesToResponseItems(req.messages);
    } else if (Array.isArray(req.input)) {
      // Already Responses API format
      input = req.input;
    } else if (typeof req.input === "string") {
      // String input → wrap in message item
      input = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: req.input }],
        },
      ];
    } else {
      input = [];
    }

    const body: JsonObject = {
      model: ctx.providerModelId || stringField(req.model) || "",
      instructions,
      input,
      // The account-scoped Codex backend accepts only streamed generation.
      // Pointer consumes the SSE response when the public client requested a
      // non-streaming response.
      stream: true,
      store: false,
    };

    // Codex backend does not accept max_output_tokens or temperature/top_p
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools) {
      body.tools = flattenToolsForResponses(req.tools);
      body.tool_choice = req.tool_choice ?? "auto";
    }
    if (req.reasoning !== undefined) body.reasoning = req.reasoning;
    if (typeof req.previous_response_id === "string")
      body.previous_response_id = req.previous_response_id;

    return { url, headers, body };
  },
};

export default handler;
