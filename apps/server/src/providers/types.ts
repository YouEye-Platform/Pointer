// Provider handler interface — implement for complex providers (e.g. Codex)
// Simple OpenAI-compatible providers use the default handler with YAML config only

import type {
  JsonObject,
  JsonValue,
} from "../gateway/protocol/v1/schemas";

export interface ProviderManifest {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic-compatible" | "custom";
  baseUrl: string;
  endpoint?: {
    mode: "fixed" | "required";
    label?: string;
    placeholder?: string;
  };
  auth: {
    type: "bearer" | "header" | "query" | "oauth-device-flow" | "oauth-pkce" | "none";
    header?: string;
    keyPrefix?: string;
    clientId?: string;
    issuer?: string;
    scopes?: string;
    connectLabel?: string;
  };
  endpoints?: {
    chatCompletions?: string;
    messages?: string;
    responses?: string;
    models?: string;
  };
  gateway?: {
    operations: {
      generate: {
        format: "chat-completions" | "messages" | "responses" | "google-generate-content";
        endpoint: string;
      };
    } & Partial<Record<
      "streamGenerate" | "countTokens" | "embedContent" | "batchEmbedContents",
      {
        format: "chat-completions" | "messages" | "responses" | "google-generate-content";
        endpoint: string;
      }
    >>;
  };
  models?: {
    discovery?: ProviderModelDiscovery;
    static?: StaticModel[];
    /**
     * Exact-model capability values used only when discovery omits an explicit
     * boolean. Provider-declared true/false values always take precedence.
     */
    capabilityFallbacks?: ModelCapabilityFallback[];
  };
  headers?: Record<string, string>;
  balance?: {
    url: string;
    parser: { path: string; subtractPath?: string; currency?: string };
    pollInterval?: number;
  };
  handler?: string; // references a handler module in providers.d/_handlers/
  handlerConfig?: Record<string, unknown>;
}

export type ProviderModelDiscoveryPrimitive =
  | string
  | number
  | boolean
  | null;

export interface ProviderModelDiscoveryFilter {
  path: string;
  equals?: ProviderModelDiscoveryPrimitive;
  notEquals?: ProviderModelDiscoveryPrimitive;
  in?: ProviderModelDiscoveryPrimitive[];
  notIn?: ProviderModelDiscoveryPrimitive[];
  exists?: boolean;
}

export interface ProviderModelDiscoveryPagination {
  cursorParam: string;
  cursorPath: string;
  hasMorePath?: string;
  pageSizeParam?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface ProviderModelCatalogIdentity {
  /**
   * Metadata field whose value is an authoritative cross-provider model
   * identity. The provider's exact discovery ID remains the routing ID.
   */
  field: string;
  /**
   * Optional exact prefix to remove before validating the identity.
   */
  stripPrefix?: string;
  /**
   * Minimum number of non-empty slash-separated identity segments.
   */
  minimumSegments?: number;
}

export interface ProviderModelDiscovery {
  enabled: boolean;
  /**
   * Absolute metadata endpoint when discovery is hosted outside baseUrl.
   * Model discovery is always GET-only.
   */
  url?: string;
  query?: Record<string, string | number | boolean>;
  listPath?: string;
  idField?: string;
  nameField?: string;
  pricingPath?: string;
  inputPriceField?: string;
  outputPriceField?: string;
  contextField?: string;
  pricePerMillion?: boolean;
  filters?: ProviderModelDiscoveryFilter[];
  pagination?: ProviderModelDiscoveryPagination;
  catalogIdentity?: ProviderModelCatalogIdentity;
}

export interface ModelCapabilityFallback {
  modelId: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}

export interface StaticModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportedGenerationMethods?: string[];
  nativeFormat?: "chat-completions" | "messages" | "responses" | "google-generate-content";
  nativeEndpoint?: string;
}

export type ProxyRequest = JsonObject & {
  model: string;
  messages?: JsonValue[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: JsonValue[];
};

export function refineProxyRequest(value: JsonObject): ProxyRequest {
  const model = value.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("Provider request must include a model");
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new Error("Provider request stream must be a boolean");
  }
  if (value.messages !== undefined && !Array.isArray(value.messages)) {
    throw new Error("Provider request messages must be an array");
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new Error("Provider request tools must be an array");
  }
  if (
    value.temperature !== undefined
    && (typeof value.temperature !== "number" || !Number.isFinite(value.temperature))
  ) {
    throw new Error("Provider request temperature must be a finite number");
  }
  if (
    value.max_tokens !== undefined
    && (
      typeof value.max_tokens !== "number"
      || !Number.isInteger(value.max_tokens)
      || value.max_tokens < 0
    )
  ) {
    throw new Error("Provider request max_tokens must be a non-negative integer");
  }
  return { ...value, model };
}

export interface RequestContext {
  requestId?: string;
  apiKeyId: string;
  userId: string;
  instanceId: string;
  providerId: string;
  modelId: string;
  providerModelId: string;
  providerApiKey: string;
  providerUserId?: string;
  providerBaseUrl?: string;
  providerNativeEndpoint?: string;
  startTime: number;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string; tool_calls?: JsonObject[] };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ProviderConnectionTestResult {
  success: boolean;
  status: number;
  error?: string;
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  userId?: string;
}

export class OAuthCredentialRefreshError extends Error {
  terminal: boolean;

  constructor(message: string, terminal = false) {
    super(message);
    this.name = "OAuthCredentialRefreshError";
    this.terminal = terminal;
  }
}

export interface OAuthDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type OAuthDevicePollResult =
  | { status: "pending"; interval?: number }
  | { status: "success"; credential: OAuthCredential }
  | { status: "denied" | "expired"; error?: string };

// Handler interface for complex provider logic
// All methods are optional — defaults handle standard OpenAI-compatible behavior
export interface IProviderHandler {
  // Request lifecycle
  transformRequest?(req: ProxyRequest, ctx: RequestContext, config: ProviderManifest): Promise<{ url: string; headers: Record<string, string>; body: JsonObject }>;
  buildHeaders?(ctx: RequestContext, config: ProviderManifest): Record<string, string>;

  // Response lifecycle
  transformResponseChunk?(chunk: unknown, config: ProviderManifest): StreamChunk | null;

  // Model discovery
  fetchModels?(
    config: ProviderManifest,
    apiKey: string,
    credential?: OAuthCredential
  ): Promise<StaticModel[]>;
  transformModelList?(rawModels: unknown[], config: ProviderManifest): StaticModel[];
  getAccountInfo?(
    apiKey: string,
    config: ProviderManifest,
    credential?: OAuthCredential
  ): Promise<Record<string, unknown>>;
  testConnection?(
    config: ProviderManifest,
    apiKey: string,
    credential?: OAuthCredential
  ): Promise<ProviderConnectionTestResult>;

  // Generic OAuth device authorization lifecycle.
  startDeviceAuthorization?(config: ProviderManifest): Promise<OAuthDeviceAuthorization>;
  pollDeviceAuthorization?(
    config: ProviderManifest,
    deviceCode: string
  ): Promise<OAuthDevicePollResult>;
  refreshOAuthCredential?(
    config: ProviderManifest,
    credential: OAuthCredential
  ): Promise<OAuthCredential>;
}
