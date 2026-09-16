import { isRecord } from "./common";
import type { GatewayApiFormat } from "../../compatibility";
import type {
  GatewayAdapterFailure,
  IrStreamEvent,
  IrUsage,
  IrError,
  JsonObject,
} from "./schemas";
import {
  executeGatewayRequestAdapter,
  executeGatewayResponseAdapter,
} from "./engine";
import { parsePublicError, renderPublicError } from "./errors";
import {
  createStreamAdapterContext,
  normalizeUpstreamStreamError,
  parsePublicStreamEvent,
  renderPublicStreamTrace,
  type PublicStreamEvent,
  type StreamAdapterContext,
} from "./stream";

const INVALID_REQUEST_MESSAGE = "Invalid gateway request.";
const INVALID_RESPONSE_MESSAGE = "Invalid provider response.";
const STREAM_FAILURE_MESSAGE = "Provider stream translation failed.";
const STREAM_INTERRUPTED_MESSAGE = "Provider stream ended before a terminal event.";

export interface GatewayProxyRequestSelectionSuccess {
  ok: true;
  primaryEngine: "v1";
  request: JsonObject;
}

export interface GatewayProxyRequestSelectionFailure {
  ok: false;
  status: 400;
  responseBody: JsonObject;
}

export type GatewayProxyRequestSelection =
  | GatewayProxyRequestSelectionSuccess
  | GatewayProxyRequestSelectionFailure;

export interface GatewayProxyRequestSelectionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  providerModelId: string;
}

export interface GatewayProxyResponseSelectionSuccess {
  ok: true;
  primaryEngine: "v1";
  response: JsonObject;
}

export interface GatewayProxyResponseSelectionFailure {
  ok: false;
  status: 502;
  responseBody: JsonObject;
}

export type GatewayProxyResponseSelection =
  | GatewayProxyResponseSelectionSuccess
  | GatewayProxyResponseSelectionFailure;

export interface GatewayProxyResponseSelectionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  model: string;
}

export interface GatewayProxyErrorSelectionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  status: number;
  headers?: Readonly<Record<string, string>>;
  requestId: string;
}

export interface GatewayProxyErrorSelection {
  primaryEngine: "v1";
  status: number;
  headers: Record<string, string>;
  responseBody: JsonObject;
}

function publicAdapterFailure(
  format: GatewayApiFormat,
  failure: GatewayAdapterFailure,
): GatewayProxyRequestSelectionFailure {
  if (format === "messages") {
    return {
      ok: false,
      status: 400,
      responseBody: {
        type: "error",
        error: { type: failure.error.code, message: INVALID_REQUEST_MESSAGE },
      },
    };
  }
  if (format === "google-generate-content") {
    return {
      ok: false,
      status: 400,
      responseBody: {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: INVALID_REQUEST_MESSAGE,
          details: [{
            "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
            reason: failure.error.code,
          }],
        },
      },
    };
  }
  return {
    ok: false,
    status: 400,
    responseBody: {
      error: {
        type: "pointer_gateway_error",
        code: failure.error.code,
        message: INVALID_REQUEST_MESSAGE,
      },
    },
  };
}

function publicResponseFailure(format: GatewayApiFormat): GatewayProxyResponseSelectionFailure {
  if (format === "messages") {
    return {
      ok: false,
      status: 502,
      responseBody: {
        type: "error",
        error: { type: "api_error", message: INVALID_RESPONSE_MESSAGE },
      },
    };
  }
  if (format === "google-generate-content") {
    return {
      ok: false,
      status: 502,
      responseBody: {
        error: {
          code: 502,
          status: "INTERNAL",
          message: INVALID_RESPONSE_MESSAGE,
        },
      },
    };
  }
  return {
    ok: false,
    status: 502,
    responseBody: {
      error: {
        type: "pointer_gateway_error",
        code: "pointer_invalid_upstream_response",
        message: INVALID_RESPONSE_MESSAGE,
      },
    },
  };
}

export function selectGatewayProxyRequest(
  input: GatewayProxyRequestSelectionInput,
): GatewayProxyRequestSelection {
  const execution = executeGatewayRequestAdapter({
    sourceFormat: input.sourceFormat,
    targetFormat: input.targetFormat,
    payload: input.payload,
    model: input.providerModelId,
  });
  if ("ok" in execution) return publicAdapterFailure(input.sourceFormat, execution);
  return {
    ok: true,
    primaryEngine: "v1",
    request: { ...execution.value, model: input.providerModelId },
  };
}

// A provider's public text can be represented by every supported response API.
// Phase tags remain exact in Responses history and output; other response APIs
// receive the visible content in order. Native tool items still fail closed.
function phasedTextForOtherResponseApi(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "message" || value.role !== "assistant"
    || !["commentary", "final_answer"].includes(String(value.phase))
    || !Array.isArray(value.content)
    || !value.content.every(part => isRecord(part) && (part.type === "output_text" || part.type === "refusal"))) return value;
  const projected = { ...value };
  delete projected.phase;
  return projected;
}
function responseForOtherApi(value: unknown): unknown {
  return isRecord(value) && Array.isArray(value.output)
    ? { ...value, output: value.output.map(phasedTextForOtherResponseApi) } : value;
}
function eventForOtherApi(event: PublicStreamEvent): PublicStreamEvent {
  if (!isRecord(event.data)) return event;
  return { ...event, data: {
    ...event.data,
    ...(event.data.item !== undefined ? { item: phasedTextForOtherResponseApi(event.data.item) } : {}),
    ...(event.data.response !== undefined ? { response: responseForOtherApi(event.data.response) } : {}),
  } };
}

export function selectGatewayProxyResponse(
  input: GatewayProxyResponseSelectionInput,
): GatewayProxyResponseSelection {
  const execution = executeGatewayResponseAdapter(input.sourceFormat === "responses" && input.targetFormat !== "responses"
    ? { ...input, payload: responseForOtherApi(input.payload) } : input);
  if ("ok" in execution) return publicResponseFailure(input.targetFormat);
  return { ok: true, primaryEngine: "v1", response: execution.value };
}

export function selectGatewayProxyError(
  input: GatewayProxyErrorSelectionInput,
): GatewayProxyErrorSelection {
  const parsed = parsePublicError(input.sourceFormat, {
    status: input.status,
    headers: input.headers,
    body: null,
  }, { requestId: input.requestId });
  if (!parsed.ok) {
    const failure = publicResponseFailure(input.targetFormat);
    return {
      primaryEngine: "v1",
      status: failure.status,
      headers: { "content-type": "application/json" },
      responseBody: failure.responseBody,
    };
  }
  const rendered = renderPublicError(input.targetFormat, parsed.value);
  return {
    primaryEngine: "v1",
    status: rendered.status,
    headers: rendered.headers,
    responseBody: rendered.body,
  };
}

export interface GatewayProxyStreamSelectorInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  model: string;
  requestId: string;
  toolSchemas?: Readonly<Record<string, JsonObject>>;
}

export interface GatewayProxyStreamFailure {
  kind: "translation" | "interrupted";
  sourceEventType: string | null;
  outputObserved: boolean;
}

export interface GatewayProxyStreamPushResult {
  lines: string[];
}

export interface GatewayProxyStreamSelector {
  readonly primaryEngine: "v1";
  push(event: PublicStreamEvent): GatewayProxyStreamPushResult;
  finish(): GatewayProxyStreamPushResult;
  failed(): boolean;
  upstreamFailed(): boolean;
  upstreamError(): IrError | null;
  ended(): boolean;
  usage(): IrUsage | undefined;
  failure(): GatewayProxyStreamFailure | null;
}

function encodePublicStreamEvent(event: PublicStreamEvent): string {
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  return `${event.event ? `event: ${event.event}\n` : ""}data: ${data}\n\n`;
}

function safeStreamFailure(format: GatewayApiFormat): string[] {
  if (format === "messages") {
    return [encodePublicStreamEvent({
      event: "error",
      data: {
        type: "error",
        error: {
          type: "api_error",
          code: "pointer_stream_translation_error",
          message: STREAM_FAILURE_MESSAGE,
        },
      },
    })];
  }
  if (format === "responses") {
    return [encodePublicStreamEvent({
      event: "error",
      data: {
        type: "error",
        code: "pointer_stream_translation_error",
        message: STREAM_FAILURE_MESSAGE,
        param: null,
      },
    })];
  }
  if (format === "google-generate-content") {
    return [encodePublicStreamEvent({
      data: {
        error: {
          code: 502,
          status: "INTERNAL",
          message: STREAM_FAILURE_MESSAGE,
        },
      },
    })];
  }
  return [
    encodePublicStreamEvent({
      data: {
        error: {
          type: "server_error",
          code: "pointer_stream_translation_error",
          message: STREAM_FAILURE_MESSAGE,
        },
      },
    }),
    encodePublicStreamEvent({ data: "[DONE]" }),
  ];
}

function safeStreamInterruption(format: GatewayApiFormat): string[] {
  if (format === "messages") {
    return [encodePublicStreamEvent({
      event: "error",
      data: {
        type: "error",
        error: {
          type: "api_error",
          code: "pointer_stream_interrupted",
          message: STREAM_INTERRUPTED_MESSAGE,
        },
      },
    })];
  }
  if (format === "responses") {
    return [encodePublicStreamEvent({
      event: "error",
      data: {
        type: "error",
        code: "pointer_stream_interrupted",
        message: STREAM_INTERRUPTED_MESSAGE,
        param: null,
      },
    })];
  }
  if (format === "google-generate-content") {
    return [encodePublicStreamEvent({
      data: {
        error: {
          code: 502,
          status: "INTERNAL",
          message: STREAM_INTERRUPTED_MESSAGE,
          details: [{
            "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
            reason: "pointer_stream_interrupted",
          }],
        },
      },
    })];
  }
  return [
    encodePublicStreamEvent({
      data: {
        error: {
          type: "server_error",
          code: "pointer_stream_interrupted",
          message: STREAM_INTERRUPTED_MESSAGE,
        },
      },
    }),
    encodePublicStreamEvent({ data: "[DONE]" }),
  ];
}

function schemaHasType(schema: JsonObject, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function normalizeOptionalEmptyStrings(value: unknown, schema: JsonObject): unknown {
  if (Array.isArray(value) && schemaHasType(schema, "array") && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    return value.map((item) => normalizeOptionalEmptyStrings(item, schema.items as JsonObject));
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !schemaHasType(schema, "object")) return value;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as JsonObject
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const property = properties[key];
    const propertySchema = property && typeof property === "object" && !Array.isArray(property)
      ? property as JsonObject
      : null;
    if (item === "" && propertySchema && schemaHasType(propertySchema, "string") && !required.has(key)) continue;
    output[key] = propertySchema
      ? normalizeOptionalEmptyStrings(item, propertySchema) as never
      : item as never;
  }
  return output;
}

function normalizedToolArguments(raw: string, schema: JsonObject): string {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return JSON.stringify(normalizeOptionalEmptyStrings(value, schema));
  } catch {
    return raw;
  }
}

function sourceEventType(event: PublicStreamEvent): string | null {
  if (event.event && /^[A-Za-z0-9_.:-]{1,120}$/.test(event.event)) return event.event;
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    const type = (event.data as Record<string, unknown>).type;
    if (typeof type === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(type)) return type;
  }
  return typeof event.data === "string" && event.data === "[DONE]" ? "[DONE]" : null;
}

export function createGatewayProxyStreamSelector(
  input: GatewayProxyStreamSelectorInput,
): GatewayProxyStreamSelector {
  let context: StreamAdapterContext = createStreamAdapterContext(input.model, input.requestId);
  const events: IrStreamEvent[] = [];
  let renderedCount = 0;
  let failed = false;
  let upstreamFailed = false;
  let upstreamError: IrError | null = null;
  let outputObserved = false;
  let failure: GatewayProxyStreamFailure | null = null;
  let lastSourceEventType: string | null = null;
  const bufferedToolArguments = new Map<number, { callId: string; schema: JsonObject; chunks: string[] }>();

  const containsOutput = (items: readonly IrStreamEvent[]): boolean => items.some((item) =>
    item.type === "responses_native_event"
    || item.type === "tool_call_start"
    || (item.type === "text_delta" && item.delta.length > 0)
    || (item.type === "reasoning_delta" && item.delta.length > 0)
    || (item.type === "tool_arguments_delta" && item.delta.length > 0)
  );

  const renderUpstreamFailure = (body: unknown = null, empty = false): string[] => {
    const normalized = normalizeUpstreamStreamError(input.sourceFormat, context, body, empty);
    if ("ok" in normalized) {
      failed = true;
      failure = { kind: "translation", sourceEventType: lastSourceEventType, outputObserved };
      return safeStreamFailure(input.targetFormat);
    }
    context = normalized.context;
    events.push(...normalized.events);
    const error = normalized.events.find((item) => item.type === "error");
    if (error?.type === "error") upstreamError = error.error;
    upstreamFailed = true;
    const rendered = renderPublicStreamTrace(input.targetFormat, events);
    const lines = rendered.slice(renderedCount).map(encodePublicStreamEvent);
    renderedCount = rendered.length;
    return lines;
  };

  const render = (event?: PublicStreamEvent): string[] => {
    if (failed) return [];
    if (event) {
      lastSourceEventType = sourceEventType(event) ?? lastSourceEventType;
      const parsed = parsePublicStreamEvent(input.sourceFormat,
        input.sourceFormat === "responses" && input.targetFormat !== "responses" ? eventForOtherApi(event) : event,
        context);
      if ("ok" in parsed) {
        failed = true;
        failure = { kind: "translation", sourceEventType: lastSourceEventType, outputObserved };
        return safeStreamFailure(input.targetFormat);
      }
      if (input.targetFormat !== "responses" && parsed.events.some(item => item.type === "responses_native_event")) {
        failed = true;
        failure = { kind: "translation", sourceEventType: lastSourceEventType, outputObserved };
        return safeStreamFailure(input.targetFormat);
      }
      const nextOutputObserved = outputObserved || containsOutput(parsed.events);
      const terminal = parsed.events.find((item) => item.type === "response_end");
      if (
        terminal?.type === "response_end"
        && (terminal.finishReason === "error" || (terminal.finishReason === "stop" && !nextOutputObserved))
      ) {
        const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
        return renderUpstreamFailure(data?.response ?? data, terminal.finishReason === "stop");
      }
      context = parsed.context;
      const nextEvents: IrStreamEvent[] = [];
      for (const item of parsed.events) {
        if (item.type === "tool_call_start") {
          const schema = input.toolSchemas?.[item.name];
          if (schema && input.targetFormat === "messages") {
            bufferedToolArguments.set(item.index, { callId: item.callId, schema, chunks: [] });
          }
          nextEvents.push(item);
          continue;
        }
        if (item.type === "tool_arguments_delta") {
          const buffered = bufferedToolArguments.get(item.index);
          if (buffered) {
            buffered.chunks.push(item.delta);
            continue;
          }
          nextEvents.push(item);
          continue;
        }
        if (item.type === "content_end") {
          const buffered = bufferedToolArguments.get(item.index);
          if (buffered) {
            nextEvents.push({
              ...item,
              type: "tool_arguments_delta",
              callId: buffered.callId,
              delta: normalizedToolArguments(buffered.chunks.join(""), buffered.schema),
            });
            bufferedToolArguments.delete(item.index);
          }
        }
        nextEvents.push(item);
      }
      events.push(...nextEvents);
      outputObserved = nextOutputObserved;
      if (parsed.events.some((item) => item.type === "error")) {
        upstreamFailed = true;
        const error = parsed.events.find((item) => item.type === "error");
        if (error?.type === "error") upstreamError = error.error;
      }
    }
    const rendered = renderPublicStreamTrace(input.targetFormat, events);
    const lines = rendered.slice(renderedCount).map(encodePublicStreamEvent);
    renderedCount = rendered.length;
    return lines;
  };

  return {
    primaryEngine: "v1",
    push(event) {
      return { lines: render(event) };
    },
    finish() {
      if (failed || context.ended) return { lines: [] };
      if (
        (input.sourceFormat === "chat-completions"
          || input.sourceFormat === "google-generate-content")
        && context.finishObserved
      ) {
        return { lines: render({ data: "[DONE]" }) };
      }
      failed = true;
      failure = { kind: "interrupted", sourceEventType: lastSourceEventType, outputObserved };
      return { lines: safeStreamInterruption(input.targetFormat) };
    },
    failed() {
      return failed;
    },
    upstreamFailed() {
      return upstreamFailed;
    },
    upstreamError() {
      return upstreamError;
    },
    ended() {
      return context.ended;
    },
    usage() {
      return context.usage;
    },
    failure() {
      return failure;
    },
  };
}
