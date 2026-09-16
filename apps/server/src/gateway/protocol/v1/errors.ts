import type { GatewayApiFormat } from "../../compatibility";
import {
  createSafeUpstreamDiagnostic,
  errorCodeForUpstreamStatus,
  extractAllowlistedUpstreamMetadata,
  requestIdSchema,
} from "../../compatibility";
import {
  GATEWAY_IR_NAME,
  GATEWAY_IR_VERSION,
  type GatewayAdapterMode,
  type GatewayAdapterResult,
  type IrError,
  type JsonObject,
  irErrorSchema,
} from "./schemas";
import { completeAdapter, invalidPayloadFailure } from "./common";

// Only exact machine codes are inspected. Never retain provider messages/bodies.
function isContextRejection(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const root = body as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown> : root;
  return ["context_length_exceeded", "context_window_exceeded", "max_context_length_exceeded", "prompt_too_long"]
    .includes(typeof error.code === "string" ? error.code : "");
}

export interface PublicErrorInput {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export interface PublicErrorContext {
  requestId: string;
  mode?: GatewayAdapterMode;
  nowMs?: number;
}

export function parsePublicError(
  format: GatewayApiFormat,
  input: PublicErrorInput,
  context: PublicErrorContext,
): GatewayAdapterResult<IrError> {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    return invalidPayloadFailure(format, [{ path: "status", message: "HTTP status must be an integer from 100 through 599" }]);
  }
  const requestId = requestIdSchema.safeParse(context.requestId);
  if (!requestId.success) {
    return invalidPayloadFailure(format, [{ path: "requestId", message: "Pointer request ID is invalid" }]);
  }
  const mode = context.mode ?? "best-effort";
  const contextRejected = isContextRejection(input.body);
  const status = contextRejected ? 400 : input.status;
  const allowlistedMetadata = extractAllowlistedUpstreamMetadata(input.headers);
  const diagnostic = createSafeUpstreamDiagnostic({
    requestId: requestId.data,
    errorClass: "http",
    upstreamStatus: input.status,
    allowlistedMetadata,
    retryable: status === 408 || status === 429 || status >= 500,
  });
  const error = irErrorSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "error",
    sourceFormat: format,
    compatibilityPolicy: mode,
    compatibility: [],
    extensions: [],
    status,
    type: "pointer_gateway_error",
    code: contextRejected ? "pointer_context_length_exceeded" : errorCodeForUpstreamStatus(status),
    message: contextRejected ? "Prompt is too long for the selected model. Compact the conversation before retrying." : diagnostic.message,
    ...(diagnostic.retryAfterMs !== null ? { retryAfterMs: diagnostic.retryAfterMs } : {}),
    diagnostics: diagnostic,
  });
  return completeAdapter(format, mode, error, []);
}

export function renderPublicError(
  format: GatewayApiFormat,
  error: IrError,
): { status: number; headers: Record<string, string>; body: JsonObject } {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (error.retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(error.retryAfterMs / 1000));
  if (format === "messages") {
    return {
      status: error.status,
      headers,
      body: { type: "error", error: { type: error.code, message: error.message } },
    };
  }
  if (format === "google-generate-content") {
    const status = error.status === 400
      ? "INVALID_ARGUMENT"
      : error.status === 401
        ? "UNAUTHENTICATED"
        : error.status === 403
          ? "PERMISSION_DENIED"
          : error.status === 404
            ? "NOT_FOUND"
            : error.status === 429
              ? "RESOURCE_EXHAUSTED"
              : error.status === 408 || error.status === 504
                ? "DEADLINE_EXCEEDED"
                : error.status >= 500
                  ? "INTERNAL"
                  : "UNKNOWN";
    return {
      status: error.status,
      headers,
      body: {
        error: {
          code: error.status,
          message: error.message,
          status,
          details: [{
            "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
            reason: error.code,
          }],
        },
      },
    };
  }
  return {
    status: error.status,
    headers,
    body: { error: { type: error.type, code: error.code, message: error.message, ...(error.param !== undefined ? { param: error.param } : {}) } },
  };
}
