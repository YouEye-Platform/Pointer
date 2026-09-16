import { Hono, type Context } from "hono";
import { apiKeyMiddleware, type ApiKeyContext } from "../middleware/api-key";
import { registry, type ResolvedProvider } from "../providers/registry";
import { refineProxyRequest, type ProxyRequest } from "../providers/types";
import { resolveModel } from "../services/model-resolution";
import { db, schema } from "../db";
import {
  classifyUsageError,
  recordUsage,
  type ExtendedMetrics,
  type UsageContext,
} from "../services/usage-telemetry";
import { sanitizeAnthropicRequestBody } from "../services/anthropic-request";
import { countAnthropicRequestTokens } from "../services/anthropic-token-count";
import { estimateAnthropicInputTokens } from "../services/anthropic-token-count";
import { listModelsForApiKey } from "../services/model-resolution";
import { consumeResponsesStream } from "../services/responses-stream-consumer";
import {
  getProviderNativeFormat,
  type ApiFormat,
} from "../gateway/provider-operation";
import {
  createGatewayProxyStreamSelector,
  selectGatewayProxyError,
  selectGatewayProxyRequest,
  selectGatewayProxyResponse,
} from "../gateway/protocol/v1/runtime-proxy";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../gateway/protocol/v1/schemas";
import { parsePublicRequest, stripGoogleInternalFields } from "../gateway/protocol/v1";
import type { PublicStreamEvent } from "../gateway/protocol/v1/stream";
import {
  requestsAnthropicServerTool,
  unsupportedGatewayCapability,
} from "../gateway/preflight";
import { SseLineDecoder } from "../gateway/sse-line-decoder";
import {
  gatewayResponseHeaders as v1GatewayResponseHeaders,
} from "../gateway/compatibility";
import {
  allowLongLivedStream,
  fetchWithClientAbort,
  UpstreamTransportError,
  type PointerRuntimeBindings,
} from "../http-runtime";

type GatewayRequestContext = {
  gatewayRequestId: string;
};

type ProxyEnv = {
  Bindings: PointerRuntimeBindings;
  Variables: ApiKeyContext & GatewayRequestContext;
};
type ProxyContext = Context<ProxyEnv>;

const app = new Hono<ProxyEnv>();
export const googleProxyRoutes = new Hono<ProxyEnv>();

app.use("*", apiKeyMiddleware);
googleProxyRoutes.use("*", apiKeyMiddleware);

interface RequestCtx extends UsageContext {
  requestId: string;
  apiKeyId: string;
  userId: string;
  instanceId: string;
  providerId: string;
  modelId: string;
  publicModelId?: string;
  providerModelId: string;
  providerApiKey: string;
  providerUserId?: string;
  providerBaseUrl?: string;
  providerNativeEndpoint?: string;
  clientSignal: AbortSignal;
  startTime: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

function jsonObjectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolInputSchemas(body: ProxyRequest): Record<string, JsonObject> {
  const schemas: Record<string, JsonObject> = {};
  for (const value of body.tools ?? []) {
    if (!isJsonObject(value)) continue;
    const fn = isJsonObject(value.function) ? value.function : undefined;
    const name = stringValue(value.name) ?? stringValue(fn?.name);
    const schema = jsonObjectValue(value.input_schema)
      ?? jsonObjectValue(value.parameters)
      ?? jsonObjectValue(fn?.parameters);
    if (name && schema) schemas[name] = schema;
  }
  return schemas;
}

function numericValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a JSON object`);
  return parsed.data;
}

async function readRequestJsonObject(c: ProxyContext): Promise<JsonObject | null> {
  try {
    const value: unknown = await c.req.json<unknown>();
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function readUpstreamJsonObject(response: Response): Promise<JsonObject> {
  const value: unknown = await response.json();
  return requireJsonObject(value, "Upstream response");
}

function dynamicJsonResponse(body: JsonObject, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function gatewayResponseHeaders(
  ctx: RequestCtx,
  contentType = "application/json; charset=UTF-8",
): Record<string, string> {
  return v1GatewayResponseHeaders(ctx.requestId, contentType);
}

function upstreamHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

function gatewayErrorResponse(
  response: Response,
  providerFormat: ApiFormat,
  clientFormat: ApiFormat,
  ctx: RequestCtx,
): Response {
  const selected = selectGatewayProxyError({
    sourceFormat: providerFormat,
    targetFormat: clientFormat,
    status: response.status,
    headers: upstreamHeaders(response),
    requestId: ctx.requestId,
  });
  return new Response(JSON.stringify(selected.responseBody), {
    status: selected.status,
    headers: {
      ...selected.headers,
      ...gatewayResponseHeaders(ctx),
    },
  });
}

function gatewayJsonResponse(
  payload: JsonObject,
  providerFormat: ApiFormat,
  clientFormat: ApiFormat,
  ctx: RequestCtx,
  usage: {
    inputTokens: number;
    outputTokens: number;
    metrics?: ExtendedMetrics;
  },
): Response {
  const providerPayload = providerFormat === "google-generate-content"
    ? { ...payload, model: ctx.providerModelId }
    : payload;
  const selected = selectGatewayProxyResponse({
    sourceFormat: providerFormat,
    targetFormat: clientFormat,
    payload: providerPayload,
    model: ctx.publicModelId ?? ctx.modelId,
  });
  const responseBody = selected.ok
    && clientFormat === "google-generate-content"
    ? stripGoogleInternalFields(selected.response)
    : selected.ok
      ? selected.response
      : selected.responseBody;
  const response = new Response(JSON.stringify(responseBody), {
    status: selected.ok ? 200 : selected.status,
    headers: gatewayResponseHeaders(ctx),
  });
  recordUsage(
    ctx,
    usage.inputTokens,
    usage.outputTokens,
    response.status,
    Date.now() - ctx.startTime,
    undefined,
    ctx.source,
    selected.ok
      ? usage.metrics
      : {
          ...usage.metrics,
          outcome: "translation_error",
          errorType: "response_translation_error",
          errorMessage: "Provider response could not be adapted",
        },
  );
  return response;
}

function refinedProviderRequest(
  value: JsonObject,
  clientFormat: ApiFormat,
): ProxyRequest | Response {
  try {
    return refineProxyRequest(value);
  } catch {
    if (clientFormat === "messages") {
      return dynamicJsonResponse({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid gateway request." },
      }, 400);
    }
    if (clientFormat === "google-generate-content") {
      return dynamicJsonResponse({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "Invalid gateway request.",
        },
      }, 400);
    }
    return dynamicJsonResponse({
      error: {
        type: "pointer_gateway_error",
        code: "pointer_invalid_request",
        message: "Invalid gateway request.",
      },
    }, 400);
  }
}

function tokenCount(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function responseUsage(response: JsonObject): { inputTokens: number; outputTokens: number } {
  const usage = jsonObjectSchema.safeParse(response.usage);
  if (!usage.success) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: tokenCount(usage.data.input_tokens),
    outputTokens: tokenCount(usage.data.output_tokens),
  };
}

interface ChatUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  queueTimeMs?: number;
  promptTimeMs?: number;
  completionTimeMs?: number;
}

function secondsToMilliseconds(value: JsonValue | undefined): number {
  return Math.round((numericValue(value) ?? 0) * 1000);
}

function timingSnapshot(value: JsonValue | undefined): Pick<
  ChatUsageSnapshot,
  "queueTimeMs" | "promptTimeMs" | "completionTimeMs"
> | undefined {
  const timing = jsonObjectValue(value);
  if (!timing) return undefined;
  const queueTime = numericValue(timing.queue_time);
  const promptTime = numericValue(timing.prompt_time);
  const completionTime = numericValue(timing.completion_time);
  if (queueTime === undefined && promptTime === undefined && completionTime === undefined) return undefined;
  return {
    queueTimeMs: secondsToMilliseconds(queueTime),
    promptTimeMs: secondsToMilliseconds(promptTime),
    completionTimeMs: secondsToMilliseconds(completionTime),
  };
}

function chatUsageSnapshot(response: JsonObject): ChatUsageSnapshot {
  const usage = jsonObjectValue(response.usage);
  const promptDetails = jsonObjectValue(usage?.prompt_tokens_details);
  const completionDetails = jsonObjectValue(usage?.completion_tokens_details);
  const timing = timingSnapshot(response.time_info) ?? timingSnapshot(usage);
  const cachedTokens = numericValue(promptDetails?.cached_tokens);
  const reasoningTokens = numericValue(completionDetails?.reasoning_tokens);
  return {
    inputTokens: tokenCount(usage?.prompt_tokens),
    outputTokens: tokenCount(usage?.completion_tokens),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...timing,
  };
}

interface MessagesUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

function messagesUsageSnapshot(response: JsonObject): MessagesUsageSnapshot {
  const usage = jsonObjectValue(response.usage);
  const cacheCreationTokens = numericValue(usage?.cache_creation_input_tokens);
  const cacheReadTokens = numericValue(usage?.cache_read_input_tokens);
  return {
    inputTokens: tokenCount(usage?.input_tokens),
    outputTokens: tokenCount(usage?.output_tokens),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

function logUpstreamFailure(ctx: RequestCtx, statusCode: number) {
  const classified = classifyUsageError(statusCode, `Provider request failed (${statusCode})`);
  recordUsage(ctx, 0, 0, statusCode, Date.now() - ctx.startTime, null, ctx.source, {
    ...classified,
    outcome: classified.errorType === "timeout" ? "timeout" : "upstream_error",
  });
}

function upstreamTransportErrorResponse(
  error: UpstreamTransportError,
  providerFormat: ApiFormat,
  clientFormat: ApiFormat,
  ctx: RequestCtx,
): Response {
  const status = error.timeout ? 504 : 502;
  logUpstreamFailure(ctx, status);
  console.error(error.timeout
    ? "[proxy] Provider request timed out before response"
    : "[proxy] Provider connection failed before response");
  return gatewayErrorResponse(
    new Response(null, { status }),
    providerFormat,
    clientFormat,
    ctx,
  );
}

function streamOutcome(
  error: unknown,
  clientAborted: boolean,
  translationFailed = false,
  upstreamFailed = false,
  interrupted = false,
) {
  if (translationFailed) return { statusCode: 500, metrics: { outcome: "translation_error" as const, errorType: "translation_error", errorMessage: "Provider stream translation failed" } };
  if (upstreamFailed) return { statusCode: 502, metrics: { outcome: "upstream_error" as const, errorType: "upstream_error", errorMessage: "Provider stream reported an error" } };
  if (interrupted) return { statusCode: 502, metrics: { outcome: "incomplete_stream" as const, errorType: "incomplete_stream", errorMessage: "Provider stream ended before a terminal event" } };
  if (clientAborted) return { statusCode: 499, metrics: { outcome: "client_abort" as const, errorType: "client_abort", errorMessage: "Client cancelled stream" } };
  if (error) return { statusCode: 502, metrics: { outcome: "incomplete_stream" as const, errorType: "incomplete_stream", errorMessage: "Provider stream ended unexpectedly" } };
  return { statusCode: 200, metrics: {} };
}

function logTranslationFailure(ctx: RequestCtx, error: unknown) {
  const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  recordUsage(ctx, 0, 0, timeout ? 504 : 500, Date.now() - ctx.startTime, null, ctx.source, {
    outcome: timeout ? "timeout" : "translation_error",
    errorType: timeout ? "timeout" : "translation_error",
    errorMessage: timeout ? "Provider request timed out" : "Request translation failed",
  });
}

async function fetchUpstream(ctx: RequestCtx, url: string, init: RequestInit) {
  const response = await fetchWithClientAbort(url, init, ctx.clientSignal);
  const limits: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key === "retry-after" || key.includes("ratelimit") || key.includes("rate-limit")) limits[key] = value;
  });
  if (Object.keys(limits).length) {
    await db.insert(schema.providerOperationalStates).values({
      id: `${ctx.userId}:${ctx.providerId}`,
      userId: ctx.userId,
      providerId: ctx.providerId,
      rateLimitData: limits,
      rateLimitUpdatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.providerOperationalStates.userId, schema.providerOperationalStates.providerId],
      set: { rateLimitData: limits, rateLimitUpdatedAt: new Date() },
    });
  }
  return response;
}

function clientAbortResponse(ctx: RequestCtx): Response {
  recordUsage(ctx, 0, 0, 499, Date.now() - ctx.startTime, null, ctx.source, {
    outcome: "client_abort",
    errorType: "client_abort",
    errorMessage: "Client cancelled request",
  });
  return new Response(null, {
    status: 499,
    headers: gatewayResponseHeaders(ctx),
  });
}

function isMeaningfulSseLine(line: string, format: ApiFormat): boolean {
  if (!line.startsWith("data: ")) return false;
  const raw = line.slice(6).trim();
  if (!raw || raw === "[DONE]") return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) return false;
    const data = parsed;
    if (format === "chat-completions") {
      const firstChoice = Array.isArray(data.choices) && isJsonObject(data.choices[0])
        ? data.choices[0]
        : undefined;
      const delta = jsonObjectValue(firstChoice?.delta);
      return Boolean(
        (typeof delta?.content === "string" && delta.content.length > 0)
        || (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0)
        || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
      );
    }
    if (format === "messages") {
      const delta = jsonObjectValue(data.delta);
      return data.type === "content_block_delta" && Boolean(
        delta?.text || delta?.thinking || delta?.partial_json
      );
    }
    if (format === "google-generate-content") {
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      return candidates.some((candidate) => {
        if (!isJsonObject(candidate)) return false;
        const content = jsonObjectValue(candidate.content);
        const parts = Array.isArray(content?.parts) ? content.parts : [];
        return parts.some((part) => {
          if (!isJsonObject(part)) return false;
          return (typeof part.text === "string" && part.text.length > 0)
            || isJsonObject(part.functionCall)
            || isJsonObject(part.inlineData);
        });
      });
    }
    const item = jsonObjectValue(data.item);
    return Boolean(
      (typeof data.delta === "string" && data.delta.length > 0)
      || (data.type === "response.output_item.added" && item?.type === "function_call")
    );
  } catch {
    return false;
  }
}

function observedGenerationMs(ctx: RequestCtx, ttfbMs: number | null): number | undefined {
  return ttfbMs === null ? undefined : Math.max(1, Date.now() - ctx.startTime - ttfbMs);
}

function resolvedNativeFormat(
  model: { nativeFormat: ApiFormat | null },
  provider: ResolvedProvider
): ApiFormat {
  return model.nativeFormat ?? getProviderNativeFormat(provider);
}

type GoogleAction =
  | "generateContent"
  | "streamGenerateContent"
  | "countTokens"
  | "embedContent"
  | "batchEmbedContents";

interface GoogleRouteTarget {
  model: string;
  action?: GoogleAction;
}

export function parseGoogleRouteTarget(path: string): GoogleRouteTarget | null {
  const prefix = "/v1beta/models/";
  if (!path.startsWith(prefix)) return null;
  const resourceAndAction = path.slice(prefix.length);
  if (!resourceAndAction || resourceAndAction.length > 8192) return null;
  const separator = resourceAndAction.lastIndexOf(":");
  const encodedModel = separator >= 0
    ? resourceAndAction.slice(0, separator)
    : resourceAndAction;
  const actionValue = separator >= 0
    ? resourceAndAction.slice(separator + 1)
    : undefined;
  const actions = new Set<GoogleAction>([
    "generateContent",
    "streamGenerateContent",
    "countTokens",
    "embedContent",
    "batchEmbedContents",
  ]);
  if (actionValue !== undefined && !actions.has(actionValue as GoogleAction)) return null;
  let model: string;
  try {
    model = decodeURIComponent(encodedModel);
  } catch {
    return null;
  }
  if (
    !model
    || model.length > 4096
    || /[\u0000-\u001f\u007f\\]/.test(model)
    || model.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return {
    model,
    ...(actionValue ? { action: actionValue as GoogleAction } : {}),
  };
}

function googleError(
  c: ProxyContext,
  status: 400 | 401 | 403 | 404 | 500 | 502,
  reason: string,
  message: string,
): Response {
  const rpcStatus = status === 400
    ? "INVALID_ARGUMENT"
    : status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "PERMISSION_DENIED"
        : status === 404
          ? "NOT_FOUND"
          : "INTERNAL";
  return c.json({
    error: {
      code: status,
      message,
      status: rpcStatus,
      details: [{
        "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
        reason,
      }],
    },
  }, status);
}

function googleModelResource(entry: Pick<
  Awaited<ReturnType<typeof listModelsForApiKey>>[number],
  "displayName" | "contextWindow" | "maxOutput" | "capabilities" | "providerMethods"
>) {
  const methods = entry.providerMethods.length > 0
    ? [...entry.providerMethods]
    : ["generateContent", "countTokens"];
  if (
    entry.capabilities.streaming
    && methods.includes("generateContent")
    && !methods.includes("streamGenerateContent")
  ) {
    methods.push("streamGenerateContent");
  }
  return {
    name: `models/${entry.displayName}`,
    baseModelId: entry.displayName,
    version: "pointer-v1",
    displayName: entry.displayName,
    description: "Pointer-routed model. Capabilities reflect the selected Pointer route.",
    ...(entry.contextWindow ? { inputTokenLimit: entry.contextWindow } : {}),
    ...(entry.maxOutput ? { outputTokenLimit: entry.maxOutput } : {}),
    supportedGenerationMethods: methods,
  };
}

googleProxyRoutes.get("/models", async (c) => {
  const entries = await listModelsForApiKey(c.get("apiKey"));
  return c.json({ models: entries.map(googleModelResource) });
});

googleProxyRoutes.get("/models/*", async (c) => {
  const target = parseGoogleRouteTarget(new URL(c.req.url).pathname);
  if (!target || target.action) {
    return googleError(c, 404, "model_not_found", "Model not found.");
  }
  const resolved = await resolveModel(target.model, c.get("apiKey"));
  if (!resolved) return googleError(c, 404, "model_not_found", "Model not found.");
  return c.json(googleModelResource({
    ...resolved,
    displayName: target.model,
    providerMethods: resolved.providerMethods,
  }));
});

async function googleRequestContext(
  c: ProxyContext,
  model: string,
): Promise<{
  resolved: NonNullable<Awaited<ReturnType<typeof resolveModel>>>;
  provider: ResolvedProvider;
  nativeFormat: ApiFormat;
  ctx: RequestCtx;
} | Response> {
  const apiKey = c.get("apiKey");
  const resolved = await resolveModel(model, apiKey);
  if (!resolved) return googleError(c, 404, "model_not_found", "Model not found.");
  const provider = resolved.providerAccountId
    ? await registry.getProviderForAccount(resolved.providerId, resolved.providerAccountId, apiKey.userId)
    : registry.getProvider(resolved.providerId);
  if (!provider) return googleError(c, 404, "provider_unavailable", "Model route is unavailable.");
  const providerApiKey = await registry.getProviderApiKey(resolved.providerId, apiKey.userId, resolved.providerAccountId);
  if (!providerApiKey) {
    return googleError(c, 401, "provider_credential_unavailable", "Model route is unavailable.");
  }
  const providerOAuthCredential = await registry.getProviderOAuthCredential(
    resolved.providerId,
    apiKey.userId,
    resolved.providerAccountId,
  );
  const ctx: RequestCtx = {
    requestId: c.get("gatewayRequestId"),
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    instanceId: apiKey.instanceId,
    providerId: resolved.providerId,
    providerAccountId: resolved.providerAccountId,
    modelId: resolved.modelId,
    publicModelId: model,
    catalogEntityId: resolved.catalogEntityId,
    providerModelId: resolved.providerModelId,
    providerApiKey,
    providerUserId: providerOAuthCredential?.userId,
    providerBaseUrl: provider.manifest.baseUrl,
    providerNativeEndpoint: resolved.nativeEndpoint ?? undefined,
    clientSignal: c.req.raw.signal,
    startTime: Date.now(),
    source: apiKey.usageSource,
  };
  return { resolved, provider, nativeFormat: resolvedNativeFormat(resolved, provider), ctx };
}

function googleUsageSnapshot(response: JsonObject): {
  inputTokens: number;
  outputTokens: number;
  metrics: ExtendedMetrics;
} {
  const usage = jsonObjectValue(response.usageMetadata);
  return {
    inputTokens: tokenCount(usage?.promptTokenCount),
    outputTokens: tokenCount(usage?.candidatesTokenCount ?? usage?.responseTokenCount),
    metrics: {
      cachedTokens: numericValue(usage?.cachedContentTokenCount),
      reasoningTokens: numericValue(usage?.thoughtsTokenCount),
    },
  };
}

function googlePartsIn(body: JsonObject): JsonObject[] {
  const contents = [body.systemInstruction, ...(Array.isArray(body.contents) ? body.contents : [])];
  return contents.flatMap((content) => {
    const record = jsonObjectValue(content);
    return Array.isArray(record?.parts)
      ? record.parts.filter(isJsonObject)
      : [];
  });
}

function unsupportedGoogleObjectKey(
  value: JsonObject | undefined,
  allowed: ReadonlySet<string>,
  path: string,
): string | null {
  if (!value) return null;
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key ? `Google field ${path}.${key} requires a native Google route.` : null;
}

function googleUnknownCrossFormatReason(body: JsonObject): string | null {
  const topLevelReason = unsupportedGoogleObjectKey(
    body,
    new Set([
      "contents",
      "systemInstruction",
      "tools",
      "toolConfig",
      "safetySettings",
      "cachedContent",
      "generationConfig",
      "labels",
    ]),
    "request",
  );
  if (topLevelReason) return topLevelReason;

  const contents = [
    ...(body.systemInstruction !== undefined
      ? [{ path: "systemInstruction", value: body.systemInstruction }]
      : []),
    ...(Array.isArray(body.contents)
      ? body.contents.map((value, index) => ({ path: `contents.${index}`, value }))
      : []),
  ];
  for (const { path: contentPath, value: contentValue } of contents) {
    const content = jsonObjectValue(contentValue);
    const contentReason = unsupportedGoogleObjectKey(
      content,
      new Set(["role", "parts"]),
      contentPath,
    );
    if (contentReason) return contentReason;
    if (!Array.isArray(content?.parts)) continue;
    for (const [partIndex, partValue] of content.parts.entries()) {
      const part = jsonObjectValue(partValue);
      const partPath = `${contentPath}.parts.${partIndex}`;
      const partReason = unsupportedGoogleObjectKey(
        part,
        new Set([
          "text",
          "inlineData",
          "fileData",
          "functionCall",
          "functionResponse",
          "executableCode",
          "codeExecutionResult",
          "thought",
          "thoughtSignature",
          "videoMetadata",
          "mediaResolution",
        ]),
        partPath,
      );
      if (partReason) return partReason;
      const inlineData = jsonObjectValue(part?.inlineData);
      const inlineDataReason = unsupportedGoogleObjectKey(
        inlineData,
        new Set(["mimeType", "data"]),
        `${partPath}.inlineData`,
      );
      if (inlineDataReason) return inlineDataReason;
      const functionCallReason = unsupportedGoogleObjectKey(
        jsonObjectValue(part?.functionCall),
        new Set(["id", "name", "args"]),
        `${partPath}.functionCall`,
      );
      if (functionCallReason) return functionCallReason;
      const functionResponseReason = unsupportedGoogleObjectKey(
        jsonObjectValue(part?.functionResponse),
        new Set(["id", "name", "response"]),
        `${partPath}.functionResponse`,
      );
      if (functionResponseReason) return functionResponseReason;
    }
  }

  const generationReason = unsupportedGoogleObjectKey(
    jsonObjectValue(body.generationConfig),
    new Set([
      "temperature",
      "topP",
      "topK",
      "candidateCount",
      "maxOutputTokens",
      "stopSequences",
      "responseLogprobs",
      "logprobs",
      "presencePenalty",
      "frequencyPenalty",
      "seed",
      "responseMimeType",
      "responseSchema",
      "responseJsonSchema",
      "thinkingConfig",
      "responseModalities",
      "mediaResolution",
      "speechConfig",
      "audioTimestamp",
      "imageConfig",
    ]),
    "generationConfig",
  );
  if (generationReason) return generationReason;
  const thinkingReason = unsupportedGoogleObjectKey(
    jsonObjectValue(jsonObjectValue(body.generationConfig)?.thinkingConfig),
    new Set(["includeThoughts", "thinkingBudget", "thinkingLevel"]),
    "generationConfig.thinkingConfig",
  );
  if (thinkingReason) return thinkingReason;

  const toolConfig = jsonObjectValue(body.toolConfig);
  const functionCallingReason = unsupportedGoogleObjectKey(
    jsonObjectValue(toolConfig?.functionCallingConfig),
    new Set(["mode", "allowedFunctionNames"]),
    "toolConfig.functionCallingConfig",
  );
  return functionCallingReason;
}

export function googleCrossFormatUnsupportedReason(
  body: JsonObject,
  targetFormat: ApiFormat,
): string | null {
  if (targetFormat === "google-generate-content") return null;
  const unknownReason = googleUnknownCrossFormatReason(body);
  if (unknownReason) return unknownReason;
  if (Array.isArray(body.safetySettings) && body.safetySettings.length > 0) {
    return "Safety settings require a native Google GenerateContent route.";
  }
  if (typeof body.cachedContent === "string") {
    return "Cached content references require a native Google GenerateContent route.";
  }
  if (body.labels !== undefined) {
    return "Google request labels require a native Google GenerateContent route.";
  }
  for (const part of googlePartsIn(body)) {
    if (part.fileData !== undefined) {
      return "Google file references are provider-scoped and require a native Google route.";
    }
    if (
      part.executableCode !== undefined
      || part.codeExecutionResult !== undefined
      || part.videoMetadata !== undefined
      || part.mediaResolution !== undefined
    ) {
      return "The requested Google content part requires a native Google route.";
    }
    const functionResponse = jsonObjectValue(part.functionResponse);
    if (
      functionResponse
      && (
        functionResponse.parts !== undefined
        || functionResponse.willContinue !== undefined
        || functionResponse.scheduling !== undefined
      )
    ) {
      return "Extended function responses require a native Google route.";
    }
  }
  const generation = jsonObjectValue(body.generationConfig);
  if ((numericValue(generation?.candidateCount) ?? 1) > 1) {
    return "Multiple response candidates require a native Google route.";
  }
  for (const field of [
    "responseModalities",
    "mediaResolution",
    "speechConfig",
    "audioTimestamp",
    "imageConfig",
    "routingConfig",
    "modelSelectionConfig",
  ]) {
    if (generation?.[field] !== undefined) {
      return `Google generationConfig.${field} requires a native Google route.`;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const record = jsonObjectValue(tool);
      if (!record) continue;
      for (const key of Object.keys(record)) {
        if (key !== "functionDeclarations") {
          return `The Google built-in tool ${key} requires a native Google route.`;
        }
      }
      if (Array.isArray(record.functionDeclarations)) {
        for (const declaration of record.functionDeclarations) {
          const item = jsonObjectValue(declaration);
          if (!item) continue;
          const portableKeys = new Set([
            "name",
            "description",
            "parameters",
            "parametersJsonSchema",
          ]);
          const extended = Object.keys(item).find((key) => !portableKeys.has(key));
          if (extended) {
            return `Function declaration field ${extended} requires a native Google route.`;
          }
        }
      }
    }
  }
  const toolConfig = jsonObjectValue(body.toolConfig);
  if (toolConfig && Object.keys(toolConfig).some((key) => key !== "functionCallingConfig")) {
    return "The requested Google tool configuration requires a native Google route.";
  }
  return null;
}

export function googlePayloadForResolvedRoute(
  payload: JsonObject,
  targetFormat: ApiFormat,
  routeSupportsReasoning: boolean,
  reasoningEnabled: boolean | undefined,
): JsonObject {
  if (
    targetFormat === "google-generate-content"
    || routeSupportsReasoning
    || reasoningEnabled !== false
  ) {
    return payload;
  }
  const generationConfig = jsonObjectValue(payload.generationConfig);
  if (!generationConfig?.thinkingConfig) return payload;
  const nextGenerationConfig = { ...generationConfig };
  delete nextGenerationConfig.thinkingConfig;
  return { ...payload, generationConfig: nextGenerationConfig };
}

function formatUsageSnapshot(format: ApiFormat, response: JsonObject) {
  if (format === "chat-completions") {
    const usage = chatUsageSnapshot(response);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        queueTimeMs: usage.queueTimeMs,
        promptTimeMs: usage.promptTimeMs,
        completionTimeMs: usage.completionTimeMs,
      },
    };
  }
  if (format === "messages") {
    const usage = messagesUsageSnapshot(response);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    };
  }
  if (format === "google-generate-content") return googleUsageSnapshot(response);
  return { ...responseUsage(response), metrics: {} };
}

async function handleGoogleGeneration(
  c: ProxyContext,
  target: GoogleRouteTarget,
  body: JsonObject,
): Promise<Response> {
  const stream = target.action === "streamGenerateContent";
  const payload = { ...body, model: target.model, stream };
  const normalized = parsePublicRequest("google-generate-content", payload);
  if (!normalized.ok) {
    return googleError(c, 400, normalized.error.code, "Invalid gateway request.");
  }
  const execution = await googleRequestContext(c, target.model);
  if (execution instanceof Response) return execution;
  const { resolved, nativeFormat, ctx } = execution;
  if (
    nativeFormat === "google-generate-content"
    && resolved.providerMethods.length > 0
    && !resolved.providerMethods.includes("generateContent")
  ) {
    return googleError(
      c,
      400,
      "pointer_feature_unsupported",
      "The selected model does not support content generation.",
    );
  }
  const nativeOnlyReason = googleCrossFormatUnsupportedReason(body, nativeFormat);
  if (nativeOnlyReason) {
    return googleError(c, 400, "pointer_feature_unsupported", nativeOnlyReason);
  }
  if (nativeFormat !== "google-generate-content") {
    const unsupported = unsupportedGatewayCapability(payload, resolved.capabilities);
    if (unsupported) {
      return googleError(
        c,
        400,
        "pointer_feature_unsupported",
        `Model does not support requested capability: ${unsupported}.`,
      );
    }
    if (normalized.value.reasoning?.enabled && !resolved.capabilities.reasoning) {
      return googleError(
        c,
        400,
        "pointer_feature_unsupported",
        "Model does not support requested capability: reasoning.",
      );
    }
  }
  try {
    const selected = selectGatewayProxyRequest({
      sourceFormat: "google-generate-content",
      targetFormat: nativeFormat,
      payload: googlePayloadForResolvedRoute(
        payload,
        nativeFormat,
        resolved.capabilities.reasoning,
        normalized.value.reasoning?.enabled,
      ),
      providerModelId: ctx.providerModelId,
    });
    if (!selected.ok) {
      return new Response(JSON.stringify(selected.responseBody), {
        status: selected.status,
        headers: gatewayResponseHeaders(ctx),
      });
    }
    const providerRequestBody = refinedProviderRequest(
      nativeFormat === "responses" && !stream
        ? { ...selected.request, stream: true }
        : selected.request,
      "google-generate-content",
    );
    if (providerRequestBody instanceof Response) return providerRequestBody;
    allowLongLivedStream(c.env, c.req.raw, stream);
    const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
      providerRequestBody,
      ctx,
      ctx.providerApiKey,
    );
    const response = await fetchUpstream(ctx, url, {
      method: "POST",
      headers,
      body: JSON.stringify(proxyBody),
    });
    if (!response.ok) {
      logUpstreamFailure(ctx, response.status);
      return gatewayErrorResponse(response, nativeFormat, "google-generate-content", ctx);
    }
    if (stream) {
      if (nativeFormat === "google-generate-content") {
        return streamGoogleNativeResponse(response, ctx);
      }
      return streamWithTranslation(response, nativeFormat, "google-generate-content", ctx);
    }
    if (nativeFormat === "responses") {
      const assembled = await consumeResponsesStream(response, ctx.providerModelId);
      return gatewayJsonResponse(
        assembled,
        nativeFormat,
        "google-generate-content",
        ctx,
        responseUsage(assembled),
      );
    }
    const responseBody = await readUpstreamJsonObject(response);
    return gatewayJsonResponse(
      responseBody,
      nativeFormat,
      "google-generate-content",
      ctx,
      formatUsageSnapshot(nativeFormat, responseBody),
    );
  } catch (error) {
    if (ctx.clientSignal.aborted) return clientAbortResponse(ctx);
    if (error instanceof UpstreamTransportError) {
      return upstreamTransportErrorResponse(
        error,
        nativeFormat,
        "google-generate-content",
        ctx,
      );
    }
    logTranslationFailure(ctx, error);
    console.error("[proxy] Google request translation failed");
    return googleError(c, 500, "pointer_internal_error", "Request translation failed.");
  }
}

function nestedCountRequest(body: JsonObject): JsonObject {
  const nested = jsonObjectValue(body.generateContentRequest);
  return nested ?? body;
}

async function handleGoogleCountTokens(
  c: ProxyContext,
  target: GoogleRouteTarget,
  body: JsonObject,
): Promise<Response> {
  const countBody = nestedCountRequest(body);
  const normalized = parsePublicRequest("google-generate-content", {
    ...countBody,
    model: target.model,
    stream: false,
  });
  if (!normalized.ok) {
    return googleError(c, 400, normalized.error.code, "Invalid token-count request.");
  }
  const apiKey = c.get("apiKey");
  const resolved = await resolveModel(target.model, apiKey);
  if (!resolved) return googleError(c, 404, "model_not_found", "Model not found.");
  const provider = resolved.providerAccountId
    ? await registry.getProviderForAccount(resolved.providerId, resolved.providerAccountId, apiKey.userId)
    : registry.getProvider(resolved.providerId);
  if (!provider) return googleError(c, 404, "provider_unavailable", "Model route is unavailable.");
  const nativeFormat = resolvedNativeFormat(resolved, provider);
  if (
    nativeFormat !== "google-generate-content"
    || (
      resolved.providerMethods.length > 0
      && !resolved.providerMethods.includes("countTokens")
    )
  ) {
    const estimate = estimateAnthropicInputTokens(normalized.value);
    return new Response(JSON.stringify({ totalTokens: estimate }), {
      status: 200,
      headers: {
        ...v1GatewayResponseHeaders(c.get("gatewayRequestId")),
        "x-pointer-token-count-source": "estimated",
      },
    });
  }
  const execution = await googleRequestContext(c, target.model);
  if (execution instanceof Response) return execution;
  const { ctx } = execution;
  try {
    const providerRequest = refineProxyRequest({
      ...body,
      ...(jsonObjectValue(body.generateContentRequest)
        ? {
            generateContentRequest: {
              ...jsonObjectValue(body.generateContentRequest),
              model: `models/${ctx.providerModelId.replace(/^models\//, "")}`,
            },
          }
        : {}),
      model: ctx.providerModelId,
      stream: false,
    });
    const built = await registry.buildProxyRequest(
      providerRequest,
      ctx,
      ctx.providerApiKey,
      undefined,
      "countTokens",
    );
    const response = await fetchUpstream(ctx, built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
    });
    if (!response.ok) return gatewayErrorResponse(
      response,
      "google-generate-content",
      "google-generate-content",
      ctx,
    );
    const result = await readUpstreamJsonObject(response);
    if (!Number.isInteger(result.totalTokens) || Number(result.totalTokens) < 0) {
      return googleError(c, 502, "pointer_invalid_upstream_response", "Invalid provider response.");
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...gatewayResponseHeaders(ctx),
        "x-pointer-token-count-source": "exact",
      },
    });
  } catch {
    return googleError(c, 500, "pointer_internal_error", "Token counting failed.");
  }
}

function validEmbeddingResponse(value: JsonObject): boolean {
  const embeddings = Array.isArray(value.embeddings)
    ? value.embeddings
    : isJsonObject(value.embedding)
      ? [value.embedding]
      : [];
  return embeddings.length > 0 && embeddings.every((embedding) => {
    if (!isJsonObject(embedding) || !Array.isArray(embedding.values)) return false;
    return embedding.values.length > 0
      && embedding.values.every((item) => typeof item === "number" && Number.isFinite(item));
  });
}

async function handleGoogleEmbedding(
  c: ProxyContext,
  target: GoogleRouteTarget,
  body: JsonObject,
): Promise<Response> {
  const execution = await googleRequestContext(c, target.model);
  if (execution instanceof Response) return execution;
  const { resolved, nativeFormat, ctx } = execution;
  if (nativeFormat !== "google-generate-content") {
    return googleError(
      c,
      400,
      "pointer_feature_unsupported",
      "The selected route does not support embeddings.",
    );
  }
  const operation = target.action === "batchEmbedContents"
    ? "batchEmbedContents" as const
    : "embedContent" as const;
  const requiredMethod = operation === "batchEmbedContents"
    ? ["batchEmbedContents", "embedContent"]
    : ["embedContent"];
  if (
    resolved.providerMethods.length > 0
    && !requiredMethod.some((method) => resolved.providerMethods.includes(method))
  ) {
    return googleError(
      c,
      400,
      "pointer_feature_unsupported",
      "The selected model does not support embeddings.",
    );
  }
  const providerBody: JsonObject = { ...body };
  if (operation === "batchEmbedContents" && Array.isArray(providerBody.requests)) {
    providerBody.requests = providerBody.requests.map((request) => {
      if (!isJsonObject(request)) return request;
      return { ...request, model: `models/${ctx.providerModelId.replace(/^models\//, "")}` };
    });
  }
  try {
    const request = refineProxyRequest({
      ...providerBody,
      model: ctx.providerModelId,
      stream: false,
    });
    const built = await registry.buildProxyRequest(
      request,
      ctx,
      ctx.providerApiKey,
      undefined,
      operation,
    );
    const response = await fetchUpstream(ctx, built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
    });
    if (!response.ok) return gatewayErrorResponse(
      response,
      "google-generate-content",
      "google-generate-content",
      ctx,
    );
    const result = await readUpstreamJsonObject(response);
    if (!validEmbeddingResponse(result)) {
      return googleError(c, 502, "pointer_invalid_upstream_response", "Invalid provider response.");
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: gatewayResponseHeaders(ctx),
    });
  } catch {
    return googleError(c, 500, "pointer_internal_error", "Embedding request failed.");
  }
}

googleProxyRoutes.post("/models/*", async (c) => {
  const target = parseGoogleRouteTarget(new URL(c.req.url).pathname);
  if (!target?.action) {
    return googleError(c, 404, "method_not_found", "Google model method not found.");
  }
  const body = await readRequestJsonObject(c);
  if (!body) return googleError(c, 400, "pointer_invalid_request", "Invalid JSON request.");
  if (target.action === "generateContent" || target.action === "streamGenerateContent") {
    return handleGoogleGeneration(c, target, body);
  }
  if (target.action === "countTokens") return handleGoogleCountTokens(c, target, body);
  return handleGoogleEmbedding(c, target, body);
});

// ── POST /v1/chat/completions ─────────────────────────────────

app.post("/chat/completions", async (c) => {
  const apiKey = c.get("apiKey");
  const body = await readRequestJsonObject(c);
  const startTime = Date.now();

  const rawModel = stringValue(body?.model);
  if (!body || !rawModel) return c.json({ error: { message: "model is required" } }, 400);
  const resolved = await resolveModel(rawModel, apiKey);
  if (!resolved) {
    return c.json({ error: { message: `Model not found: ${rawModel}. Use a listed display name or configured hidden group alias.` } }, 404);
  }

  const unsupportedCapability = unsupportedGatewayCapability(body, resolved.capabilities);
  if (unsupportedCapability) {
    return c.json({ error: { type: "invalid_request_error", code: "pointer_feature_unsupported", message: `Model does not support requested capability: ${unsupportedCapability}` } }, 400);
  }

  const providerApiKey = await registry.getProviderApiKey(resolved.providerId, apiKey.userId, resolved.providerAccountId);
  if (!providerApiKey) {
    return c.json({ error: { message: `No API key configured for provider: ${resolved.providerId}` } }, 401);
  }
  const providerOAuthCredential = await registry.getProviderOAuthCredential(
    resolved.providerId,
    apiKey.userId,
    resolved.providerAccountId,
  );

  const resolvedProvider = resolved.providerAccountId
    ? await registry.getProviderForAccount(resolved.providerId, resolved.providerAccountId, apiKey.userId)
    : registry.getProvider(resolved.providerId);
  if (!resolvedProvider) {
    return c.json({ error: { message: `Provider not found: ${resolved.providerId}` } }, 404);
  }

  const ctx: RequestCtx = {
    requestId: c.get("gatewayRequestId"),
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    instanceId: apiKey.instanceId,
    providerId: resolved.providerId,
    providerAccountId: resolved.providerAccountId,
    modelId: resolved.modelId,
    catalogEntityId: resolved.catalogEntityId,
    providerModelId: resolved.providerModelId,
    providerApiKey,
    providerUserId: providerOAuthCredential?.userId,
    providerBaseUrl: resolvedProvider.manifest.baseUrl,
    providerNativeEndpoint: resolved.nativeEndpoint ?? undefined,
    clientSignal: c.req.raw.signal,
    startTime,
    source: apiKey.usageSource,
  };

  const nativeFormat = resolvedNativeFormat(resolved, resolvedProvider);

  try {
    const selected = selectGatewayProxyRequest({
      sourceFormat: "chat-completions",
      targetFormat: nativeFormat,
      payload: body,
      providerModelId: ctx.providerModelId,
    });
    if (!selected.ok) return c.json(selected.responseBody, selected.status);
    const providerRequestBody = refinedProviderRequest(selected.request, "chat-completions");
    if (providerRequestBody instanceof Response) return providerRequestBody;
    allowLongLivedStream(c.env, c.req.raw, providerRequestBody.stream);

    // ── PASSTHROUGH: Provider speaks Chat Completions ──
    if (nativeFormat === "chat-completions") {
      return await handleChatPassthrough(c, providerRequestBody, ctx);
    }

    // ── TRANSLATE: Provider speaks Anthropic Messages ──
    if (nativeFormat === "messages") {
      return await handleChatToMessages(c, providerRequestBody, ctx, resolvedProvider, providerApiKey);
    }

    // ── TRANSLATE: Provider speaks Responses (Codex) ──
    if (nativeFormat === "responses") {
      return await handleChatToResponses(c, providerRequestBody, ctx, providerApiKey);
    }

    if (nativeFormat === "google-generate-content") {
      return await handleToGoogleProvider(c, providerRequestBody, ctx, "chat-completions");
    }

    return c.json({ error: { message: `Unsupported provider format: ${nativeFormat}` } }, 500);
  } catch (err: unknown) {
    if (ctx.clientSignal.aborted) return clientAbortResponse(ctx);
    if (err instanceof UpstreamTransportError) {
      return upstreamTransportErrorResponse(err, nativeFormat, "chat-completions", ctx);
    }
    logTranslationFailure(ctx, err);
    console.error("[proxy] Chat request translation failed");
    return c.json({ error: { message: "Request translation failed" } }, 500);
  }
});

// ── POST /v1/messages/count_tokens (Anthropic format) ─────────

app.post("/messages/count_tokens", async (c) => {
  const apiKey = c.get("apiKey");
  const body = await readRequestJsonObject(c);
  const model = stringValue(body?.model);
  if (!body || !model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  if (requestsAnthropicServerTool(body)) {
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "pointer_feature_unsupported",
        message: "Pointer does not support Anthropic server-tool declarations.",
      },
    }, 400);
  }

  const resolved = await resolveModel(model, apiKey);
  if (!resolved) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: `Could not resolve model: ${model}` } }, 404);
  }

  const result = countAnthropicRequestTokens(body);
  if (!result.ok) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid gateway request." } }, 400);
  }
  return c.json(result.response);
});

// ── POST /v1/messages (Anthropic format) ──────────────────────

app.post("/messages", async (c) => {
  const apiKey = c.get("apiKey");
  const body = await readRequestJsonObject(c);
  const startTime = Date.now();

  const model = stringValue(body?.model);
  if (!body || !model) return c.json({ error: { type: "invalid_request_error", message: "model is required" } }, 400);

  if (requestsAnthropicServerTool(body)) {
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "pointer_feature_unsupported",
        message: "Pointer does not support Anthropic server-tool declarations.",
      },
    }, 400);
  }

  const resolved = await resolveModel(model, apiKey);
  if (!resolved) {
    return c.json({ error: { type: "invalid_request_error", message: `Could not resolve model: ${model}` } }, 404);
  }

  const unsupportedCapability = unsupportedGatewayCapability(body, resolved.capabilities);
  if (unsupportedCapability) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: `Model does not support requested capability: ${unsupportedCapability}` } }, 400);
  }

  const providerApiKey = await registry.getProviderApiKey(resolved.providerId, apiKey.userId, resolved.providerAccountId);
  if (!providerApiKey) {
    return c.json({ error: { type: "authentication_error", message: `No API key for provider: ${resolved.providerId}` } }, 401);
  }
  const providerOAuthCredential = await registry.getProviderOAuthCredential(
    resolved.providerId,
    apiKey.userId,
    resolved.providerAccountId,
  );

  const resolvedProvider = resolved.providerAccountId
    ? await registry.getProviderForAccount(resolved.providerId, resolved.providerAccountId, apiKey.userId)
    : registry.getProvider(resolved.providerId);
  if (!resolvedProvider) {
    return c.json({ error: { type: "invalid_request_error", message: `Provider not found: ${resolved.providerId}` } }, 404);
  }

  const ctx: RequestCtx = {
    requestId: c.get("gatewayRequestId"),
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    instanceId: apiKey.instanceId,
    providerId: resolved.providerId,
    providerAccountId: resolved.providerAccountId,
    modelId: resolved.modelId,
    catalogEntityId: resolved.catalogEntityId,
    providerModelId: resolved.providerModelId,
    providerApiKey,
    providerUserId: providerOAuthCredential?.userId,
    providerBaseUrl: resolvedProvider.manifest.baseUrl,
    providerNativeEndpoint: resolved.nativeEndpoint ?? undefined,
    clientSignal: c.req.raw.signal,
    startTime,
    source: apiKey.usageSource,
  };

  const nativeFormat = resolvedNativeFormat(resolved, resolvedProvider);

  try {
    const selected = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: nativeFormat,
      payload: body,
      providerModelId: ctx.providerModelId,
    });
    if (!selected.ok) return c.json(selected.responseBody, selected.status);
    const providerRequestBody = refinedProviderRequest(selected.request, "messages");
    if (providerRequestBody instanceof Response) return providerRequestBody;
    allowLongLivedStream(c.env, c.req.raw, providerRequestBody.stream);

    // ── PASSTHROUGH: Provider speaks Anthropic Messages ──
    if (nativeFormat === "messages") {
      return await handleMessagesPassthrough(c, providerRequestBody, ctx, resolvedProvider, providerApiKey);
    }

    // ── TRANSLATE: Provider speaks Chat Completions ──
    if (nativeFormat === "chat-completions") {
      return await handleMessagesToChatCompletions(c, providerRequestBody, ctx, providerApiKey);
    }

    // ── TRANSLATE: Provider speaks Responses (Codex) ──
    if (nativeFormat === "responses") {
      return await handleMessagesToResponses(c, providerRequestBody, ctx, providerApiKey);
    }

    if (nativeFormat === "google-generate-content") {
      return await handleToGoogleProvider(c, providerRequestBody, ctx, "messages");
    }

    return c.json({ error: { type: "api_error", message: `Unsupported provider format: ${nativeFormat}` } }, 500);
  } catch (err: unknown) {
    if (ctx.clientSignal.aborted) return clientAbortResponse(ctx);
    if (err instanceof UpstreamTransportError) {
      return upstreamTransportErrorResponse(err, nativeFormat, "messages", ctx);
    }
    logTranslationFailure(ctx, err);
    console.error("[proxy] Messages request translation failed");
    return c.json({ error: { type: "api_error", message: "Request translation failed" } }, 500);
  }
});

// ── POST /v1/responses (OpenAI Responses API) ────────────────

app.post("/responses", async (c) => {
  const apiKey = c.get("apiKey");
  const body = await readRequestJsonObject(c);
  const startTime = Date.now();

  const rawModel = stringValue(body?.model);
  if (!body || !rawModel) return c.json({ error: { message: "model is required" } }, 400);
  const resolved = await resolveModel(rawModel, apiKey);
  if (!resolved) {
    return c.json({ error: { message: `Model not found: ${rawModel}. Use a listed display name or configured hidden group alias.` } }, 404);
  }

  const unsupportedCapability = unsupportedGatewayCapability(body, resolved.capabilities);
  if (unsupportedCapability) {
    return c.json({ error: { type: "invalid_request_error", code: "pointer_feature_unsupported", message: `Model does not support requested capability: ${unsupportedCapability}` } }, 400);
  }

  const providerApiKey = await registry.getProviderApiKey(resolved.providerId, apiKey.userId, resolved.providerAccountId);
  if (!providerApiKey) {
    return c.json({ error: { message: `No API key configured for provider: ${resolved.providerId}` } }, 401);
  }
  const providerOAuthCredential = await registry.getProviderOAuthCredential(
    resolved.providerId,
    apiKey.userId,
    resolved.providerAccountId,
  );

  const resolvedProvider = resolved.providerAccountId
    ? await registry.getProviderForAccount(resolved.providerId, resolved.providerAccountId, apiKey.userId)
    : registry.getProvider(resolved.providerId);
  if (!resolvedProvider) {
    return c.json({ error: { message: `Provider not found: ${resolved.providerId}` } }, 404);
  }

  const ctx: RequestCtx = {
    requestId: c.get("gatewayRequestId"),
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    instanceId: apiKey.instanceId,
    providerId: resolved.providerId,
    providerAccountId: resolved.providerAccountId,
    modelId: resolved.modelId,
    catalogEntityId: resolved.catalogEntityId,
    providerModelId: resolved.providerModelId,
    providerApiKey,
    providerUserId: providerOAuthCredential?.userId,
    providerBaseUrl: resolvedProvider.manifest.baseUrl,
    providerNativeEndpoint: resolved.nativeEndpoint ?? undefined,
    clientSignal: c.req.raw.signal,
    startTime,
    source: apiKey.usageSource,
  };

  const nativeFormat = resolvedNativeFormat(resolved, resolvedProvider);

  try {
    const selected = selectGatewayProxyRequest({
      sourceFormat: "responses",
      targetFormat: nativeFormat,
      payload: body,
      providerModelId: ctx.providerModelId,
    });
    if (!selected.ok) return c.json(selected.responseBody, selected.status);
    const providerRequestBody = refinedProviderRequest(selected.request, "responses");
    if (providerRequestBody instanceof Response) return providerRequestBody;
    allowLongLivedStream(c.env, c.req.raw, providerRequestBody.stream);

    // ── PASSTHROUGH: Provider speaks Responses (Codex) ──
    if (nativeFormat === "responses") {
      return await handleResponsesPassthrough(c, providerRequestBody, ctx, providerApiKey);
    }

    // ── TRANSLATE: Provider speaks Chat Completions ──
    if (nativeFormat === "chat-completions") {
      return await handleResponsesToChatCompletions(c, providerRequestBody, ctx, providerApiKey);
    }

    // ── TRANSLATE: Provider speaks Anthropic Messages ──
    if (nativeFormat === "messages") {
      return await handleResponsesToMessages(c, providerRequestBody, ctx, resolvedProvider, providerApiKey);
    }

    if (nativeFormat === "google-generate-content") {
      return await handleToGoogleProvider(c, providerRequestBody, ctx, "responses");
    }

    return c.json({ error: { message: `Unsupported provider format: ${nativeFormat}` } }, 500);
  } catch (err: unknown) {
    if (ctx.clientSignal.aborted) return clientAbortResponse(ctx);
    if (err instanceof UpstreamTransportError) {
      return upstreamTransportErrorResponse(err, nativeFormat, "responses", ctx);
    }
    logTranslationFailure(ctx, err);
    console.error("[proxy] Responses request translation failed");
    return c.json({ error: { message: "Request translation failed" } }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// /v1/chat/completions HANDLER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

async function handleToGoogleProvider(
  _c: ProxyContext,
  body: ProxyRequest,
  ctx: RequestCtx,
  clientFormat: ApiFormat,
): Promise<Response> {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
    body,
    ctx,
    ctx.providerApiKey,
  );
  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });
  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(
      response,
      "google-generate-content",
      clientFormat,
      ctx,
    );
  }
  if (body.stream) {
    return streamWithTranslation(
      response,
      "google-generate-content",
      clientFormat,
      ctx,
    );
  }
  const responseBody = await readUpstreamJsonObject(response);
  return gatewayJsonResponse(
    responseBody,
    "google-generate-content",
    clientFormat,
    ctx,
    googleUsageSnapshot(responseBody),
  );
}

/** PASSTHROUGH: Chat Completions -> OpenAI-compatible provider */
async function handleChatPassthrough(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx) {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(body, ctx, ctx.providerApiKey);

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "chat-completions", "chat-completions", ctx);
  }

  // Streaming
  if (body.stream) {
    return streamWithTranslation(response, "chat-completions", "chat-completions", ctx);
  }

  // Non-streaming
  const responseBody = await readUpstreamJsonObject(response);
  const usage = chatUsageSnapshot(responseBody);
  const processingMs = response.headers.get("openai-processing-ms");

  return gatewayJsonResponse(
    responseBody,
    "chat-completions",
    "chat-completions",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        queueTimeMs: usage.queueTimeMs,
        promptTimeMs: usage.promptTimeMs,
        completionTimeMs: usage.completionTimeMs,
        processingMs: processingMs ? Number(processingMs) : undefined,
      },
    },
  );
}

 /** Chat Completions -> Anthropic Messages provider */
async function handleChatToMessages(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, resolvedProvider: ResolvedProvider, providerApiKey: string) {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
    body,
    ctx,
    providerApiKey
  );

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "messages", "chat-completions", ctx);
  }

  if (body.stream) {
    return streamWithTranslation(response, "messages", "chat-completions", ctx);
  }

  const responseBody = await readUpstreamJsonObject(response);
  const usage = messagesUsageSnapshot(responseBody);

  return gatewayJsonResponse(
    responseBody,
    "messages",
    "chat-completions",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    },
  );
}

/**
 * Chat Completions -> Responses (Codex) provider.
 * Provider-specific request preparation happens in the Codex handler.
 * We handle the response translation here (Responses SSE -> Chat SSE).
 */
async function handleChatToResponses(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, providerApiKey: string) {
  // Force streaming for the provider request — Codex only supports streaming
  const requestBody = { ...body, stream: true };

  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(requestBody, ctx, providerApiKey);
  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "responses", "chat-completions", ctx);
  }

  if (body.stream) {
    // Translate Responses SSE -> Chat SSE
    return streamWithTranslation(response, "responses", "chat-completions", ctx);
  }

  // Non-streaming: consume the Responses SSE stream, assemble final response
  const assembled = await consumeResponsesStream(response, ctx.modelId);
  const usage = responseUsage(assembled);
  return gatewayJsonResponse(
    assembled,
    "responses",
    "chat-completions",
    ctx,
    usage,
  );
}

// ═══════════════════════════════════════════════════════════════
// /v1/messages HANDLER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

/** PASSTHROUGH: Anthropic Messages -> Anthropic-compatible provider */
async function handleMessagesPassthrough(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, resolvedProvider: ResolvedProvider, providerApiKey: string) {
  const sanitizedBody = requireJsonObject(
    sanitizeAnthropicRequestBody({ ...body, model: ctx.providerModelId }),
    "Sanitized Messages request",
  );
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
    refineProxyRequest(sanitizedBody),
    ctx,
    providerApiKey
  );
  headers["anthropic-version"] =
    c.req.header("anthropic-version")
    || stringValue(body["anthropic-version"])
    || headers["anthropic-version"]
    || "2023-06-01";
  const anthropicBeta = c.req.header("anthropic-beta");
  if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta;

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "messages", "messages", ctx);
  }

  if (body.stream) {
    return streamWithTranslation(response, "messages", "messages", ctx, toolInputSchemas(body));
  }

  const responseBody = await readUpstreamJsonObject(response);
  const usage = messagesUsageSnapshot(responseBody);
  return gatewayJsonResponse(
    responseBody,
    "messages",
    "messages",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    },
  );
}

 /** Anthropic Messages -> OpenAI Chat Completions provider */
async function handleMessagesToChatCompletions(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, providerApiKey: string) {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(body, ctx, providerApiKey);

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "chat-completions", "messages", ctx);
  }

  if (body.stream) {
    return streamWithTranslation(response, "chat-completions", "messages", ctx, toolInputSchemas(body));
  }

  const responseBody = await readUpstreamJsonObject(response);
  const usage = chatUsageSnapshot(responseBody);
  return gatewayJsonResponse(
    responseBody,
    "chat-completions",
    "messages",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        queueTimeMs: usage.queueTimeMs,
        promptTimeMs: usage.promptTimeMs,
        completionTimeMs: usage.completionTimeMs,
      },
    },
  );
}

/** Anthropic Messages -> Responses (Codex) provider */
async function handleMessagesToResponses(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, providerApiKey: string) {
  // Force streaming for the provider request — Codex only supports streaming
  const requestBody = { ...body, stream: true };

  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(requestBody, ctx, providerApiKey);

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "responses", "messages", ctx);
  }

  if (body.stream) {
    // Responses SSE -> Chat SSE -> Anthropic SSE (two-stage)
    return streamWithTranslation(response, "responses", "messages", ctx, toolInputSchemas(body));
  }

  // Non-streaming: consume the Responses SSE stream, assemble final response
  const assembled = await consumeResponsesStream(response, ctx.modelId);
  const usage = responseUsage(assembled);
  return gatewayJsonResponse(
    assembled,
    "responses",
    "messages",
    ctx,
    usage,
  );
}

// ═══════════════════════════════════════════════════════════════
// /v1/responses HANDLER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

/** PASSTHROUGH: Responses -> Responses-native provider (Codex) */
async function handleResponsesPassthrough(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, providerApiKey: string) {
  const responsesBody = { ...body, model: ctx.providerModelId };
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
    responsesBody,
    ctx,
    providerApiKey,
  );

  const finalBody = proxyBody;

  // Use handler-transformed body if available (e.g. Codex adds instructions, headers)
  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(finalBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "responses", "responses", ctx);
  }

  // Check if response is SSE: explicit content-type OR handler forced streaming
  const contentType = response.headers.get("content-type") || "";
  const handlerForcedStream = proxyBody.stream === true;
  const isSSE = contentType.includes("text/event-stream") || handlerForcedStream;

  if (body.stream && isSSE) {
    return streamWithTranslation(response, "responses", "responses", ctx);
  }

  if (isSSE && !body.stream) {
    // Handler forced streaming (e.g. Codex) but client wants non-streaming response
    // Consume the SSE stream and assemble a complete Responses API response
    const assembled = await consumeResponsesStream(response, ctx.modelId);
    const usage = responseUsage(assembled);
    return gatewayJsonResponse(
      assembled,
      "responses",
      "responses",
      ctx,
      usage,
    );
  }

  // Non-streaming JSON response
  const responseBody = await readUpstreamJsonObject(response);
  const usage = responseUsage(responseBody);
  return gatewayJsonResponse(
    responseBody,
    "responses",
    "responses",
    ctx,
    usage,
  );
}

/** Responses -> Chat Completions provider (bridge) */
async function handleResponsesToChatCompletions(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, providerApiKey: string) {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(body, ctx, providerApiKey);

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "chat-completions", "responses", ctx);
  }

  if (body.stream) {
    return streamWithTranslation(response, "chat-completions", "responses", ctx);
  }

  // Non-streaming
  const responseBody = await readUpstreamJsonObject(response);
  const usage = chatUsageSnapshot(responseBody);

  return gatewayJsonResponse(
    responseBody,
    "chat-completions",
    "responses",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        queueTimeMs: usage.queueTimeMs,
        promptTimeMs: usage.promptTimeMs,
        completionTimeMs: usage.completionTimeMs,
      },
    },
  );
}

/** Responses -> Anthropic Messages provider */
async function handleResponsesToMessages(c: ProxyContext, body: ProxyRequest, ctx: RequestCtx, resolvedProvider: ResolvedProvider, providerApiKey: string) {
  const { url, headers, body: proxyBody } = await registry.buildProxyRequest(
    body,
    ctx,
    providerApiKey
  );

  const response = await fetchUpstream(ctx, url, {
    method: "POST",
    headers,
    body: JSON.stringify(proxyBody),
  });

  if (!response.ok) {
    logUpstreamFailure(ctx, response.status);
    return gatewayErrorResponse(response, "messages", "responses", ctx);
  }

  if (body.stream) {
    // Anthropic SSE -> Chat SSE -> Responses SSE (two-stage)
    return streamWithTranslation(response, "messages", "responses", ctx);
  }

  const responseBody = await readUpstreamJsonObject(response);
  const usage = messagesUsageSnapshot(responseBody);

  return gatewayJsonResponse(
    responseBody,
    "messages",
    "responses",
    ctx,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metrics: {
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
      },
    },
  );
}

// ═══════════════════════════════════════════════════════════════
// STREAM CONSUMPTION (for providers that always stream even when non-streaming requested)
// ═══════════════════════════════════════════════════════════════

/**
 * Consume a Responses API SSE stream and assemble a non-streaming response object.
 * Used when Codex sends streaming even though client requested non-streaming.
 */
// ═══════════════════════════════════════════════════════════════
// GENERIC STREAMING PIPELINE
// ═══════════════════════════════════════════════════════════════

interface ProviderSseParseState {
  event?: string;
}

export function parseProviderSseLine(
  line: string,
  state: ProviderSseParseState,
): PublicStreamEvent | undefined {
  if (line.startsWith("event: ")) {
    state.event = line.slice(7).trim();
    return undefined;
  }
  if (!line.startsWith("data: ")) return undefined;
  const dataText = line.slice(6).trim();
  const event = state.event;
  state.event = undefined;
  if (dataText === "[DONE]") return { event, data: "[DONE]" };
  try {
    const data: unknown = JSON.parse(dataText);
    return { event, data };
  } catch {
    // Invalid provider data enters the V1 adapter as null and becomes a safe local error.
    return { event, data: null };
  }
}

interface StreamUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  queueTimeMs?: number;
  promptTimeMs?: number;
  completionTimeMs?: number;
}

function updateStreamUsageMetrics(
  format: ApiFormat,
  event: PublicStreamEvent,
  metrics: StreamUsageMetrics,
): void {
  if (!isJsonObject(event.data)) return;
  if (format === "chat-completions") {
    const usage = chatUsageSnapshot(event.data);
    if (event.data.usage !== undefined) {
      metrics.inputTokens = usage.inputTokens;
      metrics.outputTokens = usage.outputTokens;
      metrics.cachedTokens = usage.cachedTokens;
      metrics.reasoningTokens = usage.reasoningTokens;
    }
    metrics.queueTimeMs = usage.queueTimeMs ?? metrics.queueTimeMs;
    metrics.promptTimeMs = usage.promptTimeMs ?? metrics.promptTimeMs;
    metrics.completionTimeMs = usage.completionTimeMs ?? metrics.completionTimeMs;
      return;
    }
    if (format === "google-generate-content") {
      const usage = jsonObjectValue(event.data.usageMetadata);
      if (usage) {
        metrics.inputTokens = tokenCount(usage.promptTokenCount);
        metrics.outputTokens = tokenCount(
          usage.candidatesTokenCount ?? usage.responseTokenCount,
        );
        metrics.cachedTokens = numericValue(usage.cachedContentTokenCount);
        metrics.reasoningTokens = numericValue(usage.thoughtsTokenCount);
      }
      return;
    }
  if (format === "messages") {
    if (event.data.type === "message_start") {
      const message = jsonObjectValue(event.data.message);
      const usage = messagesUsageSnapshot({ usage: message?.usage ?? null });
      metrics.inputTokens = usage.inputTokens;
      metrics.cacheCreationTokens = usage.cacheCreationTokens;
      metrics.cacheReadTokens = usage.cacheReadTokens;
    } else if (event.data.type === "message_delta") {
      const usage = messagesUsageSnapshot({ usage: event.data.usage ?? null });
      metrics.outputTokens = usage.outputTokens;
    }
    return;
  }
  const response = jsonObjectValue(event.data.response);
  if (!response) return;
  const usage = responseUsage(response);
  metrics.inputTokens = usage.inputTokens;
  metrics.outputTokens = usage.outputTokens;
}

function emitSelectedStreamLines(
  controller: ReadableStreamDefaultController,
  lines: readonly string[],
  encoder: TextEncoder,
): void {
  for (const line of lines) controller.enqueue(encoder.encode(line));
}

/** Preserve every native Google response field while replacing the private upstream model ID. */
function streamGoogleNativeResponse(
  providerResponse: Response,
  ctx: RequestCtx,
): Response {
  const reader = providerResponse.body!.getReader();
  const metrics: StreamUsageMetrics = { inputTokens: 0, outputTokens: 0 };
  let ttfbMs: number | null = null;
  let streamError: unknown = null;
  let clientAborted = false;
  let finishObserved = false;

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new SseLineDecoder();
      const encoder = new TextEncoder();
      const parseState: ProviderSseParseState = {};
      const processLine = (line: string): boolean => {
        if (ttfbMs === null && isMeaningfulSseLine(line, "google-generate-content")) {
          ttfbMs = Date.now() - ctx.startTime;
        }
        const parsed = parseProviderSseLine(line, parseState);
        if (!parsed) {
          controller.enqueue(encoder.encode(`${line}\n`));
          return false;
        }
        if (!isJsonObject(parsed.data)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            error: {
              code: 502,
              status: "INTERNAL",
              message: "Invalid provider stream response.",
            },
          })}\n\n`));
          return true;
        }
        if (isJsonObject(parsed.data.error)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            error: {
              code: 502,
              status: "INTERNAL",
              message: "Provider stream failed.",
            },
          })}\n\n`));
          return true;
        }
        updateStreamUsageMetrics("google-generate-content", parsed, metrics);
        if (Array.isArray(parsed.data.candidates)) {
          finishObserved ||= parsed.data.candidates.some((candidate) =>
            isJsonObject(candidate) && typeof candidate.finishReason === "string"
          );
        }
        const promptFeedback = jsonObjectValue(parsed.data.promptFeedback);
        finishObserved ||= typeof promptFeedback?.blockReason === "string";
        const publicData = {
          ...parsed.data,
          ...(parsed.data.modelVersion !== undefined
            ? { modelVersion: ctx.publicModelId ?? ctx.modelId }
            : {}),
        };
        controller.enqueue(encoder.encode(
          `${parsed.event ? `event: ${parsed.event}\n` : ""}data: ${JSON.stringify(publicData)}\n`,
        ));
        return false;
      };

      try {
        let terminated = false;
        while (!terminated) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.push(value)) {
            if (processLine(line)) {
              terminated = true;
              break;
            }
          }
        }
        if (!terminated) {
          for (const line of decoder.finish()) {
            if (processLine(line)) break;
          }
        } else {
          streamError = new Error("Google provider stream returned an error event");
          try {
            await reader.cancel();
          } catch {
            console.error("[proxy] Google stream terminal cleanup failed");
          }
        }
      } catch (error) {
        streamError = error;
        console.error("[proxy] Google stream passthrough failed");
      } finally {
        if (!clientAborted) controller.close();
        const incomplete = !streamError && !clientAborted && !finishObserved;
        const result = streamOutcome(
          streamError,
          clientAborted,
          incomplete,
          Boolean(streamError),
        );
        logUsage(
          ctx,
          metrics.inputTokens,
          metrics.outputTokens,
          result.statusCode,
          Date.now() - ctx.startTime,
          ttfbMs,
          ctx.source,
          {
            cachedTokens: metrics.cachedTokens,
            reasoningTokens: metrics.reasoningTokens,
            observedGenerationMs: observedGenerationMs(ctx, ttfbMs),
            ...result.metrics,
          },
        );
        try {
          reader.releaseLock();
        } catch {
          console.error("[proxy] Google stream reader release failed");
        }
      }
    },
    async cancel(reason) {
      clientAborted = true;
      try {
        await reader.cancel(reason);
      } catch {
        console.error("[proxy] Google stream cancellation failed");
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...gatewayResponseHeaders(ctx, "text/event-stream"),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Translate one provider SSE stream directly into the requested public V1 format. */
function streamWithTranslation(
  providerResponse: Response,
  providerFormat: ApiFormat,
  clientFormat: ApiFormat,
  ctx: RequestCtx,
  requestToolSchemas?: Readonly<Record<string, JsonObject>>,
): Response {
  const selector = createGatewayProxyStreamSelector({
    sourceFormat: providerFormat,
    targetFormat: clientFormat,
    model: ctx.publicModelId ?? ctx.modelId,
    requestId: ctx.requestId,
    toolSchemas: requestToolSchemas,
  });
  const parseState: ProviderSseParseState = {};
  const metrics: StreamUsageMetrics = { inputTokens: 0, outputTokens: 0 };
  let ttfbMs: number | null = null;
  let streamError: unknown = null;
  let clientAborted = false;
  const reader = providerResponse.body!.getReader();

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new SseLineDecoder();
      const encoder = new TextEncoder();

      const processLine = (line: string): boolean => {
        if (ttfbMs === null && isMeaningfulSseLine(line, providerFormat)) {
          ttfbMs = Date.now() - ctx.startTime;
        }
        const event = parseProviderSseLine(line, parseState);
        if (!event) return false;
        updateStreamUsageMetrics(providerFormat, event, metrics);
        emitSelectedStreamLines(controller, selector.push(event).lines, encoder);
        return selector.ended();
      };

      try {
        let terminalEventObserved = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.push(value)) {
            if (processLine(line)) {
              terminalEventObserved = true;
              break;
            }
          }
          if (terminalEventObserved) {
            try {
              await reader.cancel();
            } catch {
              console.error("[proxy] Provider stream terminal cleanup failed");
            }
            break;
          }
        }
        if (!terminalEventObserved) {
          for (const line of decoder.finish()) processLine(line);
        }
      } catch (error) {
        streamError = error;
        console.error("[proxy] Provider stream translation failed");
      } finally {
        if (!clientAborted) {
          const completion = selector.finish();
          emitSelectedStreamLines(controller, completion.lines, encoder);
          controller.close();
        }

        const usage = selector.usage();
        const selectorFailure = selector.failure();
        if (selectorFailure) {
          console.warn(
            `[proxy] Provider stream ${selectorFailure.kind} request=${ctx.requestId} source=${providerFormat} target=${clientFormat} last_event=${selectorFailure.sourceEventType || "unknown"} output=${selectorFailure.outputObserved ? "yes" : "no"}`,
          );
        }
        const result = streamOutcome(
          streamError,
          clientAborted,
          selectorFailure?.kind === "translation",
          selector.upstreamFailed(),
          selectorFailure?.kind === "interrupted",
        );
        const upstreamError = selector.upstreamError();
        if (upstreamError) {
          result.statusCode = upstreamError.status;
          result.metrics = { outcome: "upstream_error", errorType: upstreamError.code, errorMessage: upstreamError.message };
        }
        logUsage(
          ctx,
          usage?.inputTokens ?? metrics.inputTokens,
          usage?.outputTokens ?? metrics.outputTokens,
          result.statusCode,
          Date.now() - ctx.startTime,
          ttfbMs,
          ctx.source,
          {
            cachedTokens: usage?.cachedInputTokens ?? metrics.cachedTokens,
            reasoningTokens: usage?.reasoningTokens ?? metrics.reasoningTokens,
            cacheCreationTokens: usage?.cacheCreationInputTokens ?? metrics.cacheCreationTokens,
            cacheReadTokens: metrics.cacheReadTokens,
            queueTimeMs: metrics.queueTimeMs,
            promptTimeMs: metrics.promptTimeMs,
            completionTimeMs: metrics.completionTimeMs,
            observedGenerationMs: observedGenerationMs(ctx, ttfbMs),
            ...result.metrics,
          },
        );
        try {
          reader.releaseLock();
        } catch {
          console.error("[proxy] Provider stream reader release failed");
        }
      }
    },
    async cancel(reason) {
      clientAborted = true;
      try {
        await reader.cancel(reason);
      } catch {
        console.error("[proxy] Provider stream cancellation failed");
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...gatewayResponseHeaders(ctx, "text/event-stream"),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Usage Logging & Cost Calculation
// ═══════════════════════════════════════════════════════════════

const logUsage = recordUsage;

export default app;
