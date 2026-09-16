import type { z } from "zod";
import type { GatewayApiFormat } from "../../compatibility";
import {
  blockingErrorCodeForCompatibility,
  createFeatureCompatibilityFinding,
  type GatewayFeatureId,
} from "../../compatibility";
import {
  type GatewayAdapterFailure,
  type GatewayAdapterMode,
  type GatewayAdapterResult,
  type IrCompatibilityFinding,
  type JsonObject,
  type JsonValue,
  type ProviderExtension,
  gatewayAdapterFailureSchema,
  jsonObjectSchema,
  jsonValueSchema,
} from "./schemas";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function asJsonValue(value: unknown): JsonValue | null {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseJsonValue(value: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(value));
  } catch {
    return value;
  }
}

export function stringifyJsonValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function stableGatewayId(prefix: string, ...parts: readonly string[]): string {
  const input = parts.join("\u001f");
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}_${hash.toString(36).padStart(13, "0")}`;
}

export function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: safeFindingPath(issue.path.length > 0 ? issue.path.join(".") : "request"),
    message: "Payload does not match the public schema.",
  }));
}

export function invalidPayloadFailure(
  format: GatewayApiFormat,
  issues: Array<{ path: string; message: string }>,
): GatewayAdapterFailure {
  return gatewayAdapterFailureSchema.parse({
    ok: false,
    error: {
      code: "pointer_invalid_request",
      message: "Invalid gateway payload.",
      format,
      issues: issues.map((issue) => ({
        path: safeFindingPath(issue.path),
        message: "Payload does not match the public schema.",
      })),
      findings: [],
    },
  });
}

export function finding(
  sourceFormat: GatewayApiFormat,
  path: string,
  state: IrCompatibilityFinding["assessment"]["state"],
  code: string,
  _message: string,
  targetFormat?: GatewayApiFormat,
): IrCompatibilityFinding {
  const featureId = featureIdForFinding(path, code);
  const bestEffortAllowed = BEST_EFFORT_DETAIL_CODES.has(code);
  return {
    assessment: createFeatureCompatibilityFinding(
      { id: featureId, version: "1" },
      safeFindingPath(path),
      state,
      bestEffortAllowed,
    ),
    detailCode: code,
    sourceFormat,
    ...(targetFormat ? { targetFormat } : {}),
  };
}

const BEST_EFFORT_DETAIL_CODES = new Set([
  "pointer_chat_cache_creation_usage_dropped",
  "pointer_chat_cache_control_dropped",
  "pointer_chat_annotations_dropped",
  "pointer_chat_output_item_id_dropped",
  "pointer_chat_reasoning_metadata_dropped",
  "pointer_chat_reasoning_control_dropped",
  "pointer_chat_response_block_dropped",
  "pointer_chat_usage_detail_dropped",
  "pointer_chat_tool_result_split",
  "pointer_cross_format_extension_dropped",
  "pointer_messages_default_max_tokens",
  "pointer_messages_annotations_dropped",
  "pointer_messages_instruction_hoisted",
  "pointer_messages_output_item_id_dropped",
  "pointer_messages_reasoning_signature_missing",
  "pointer_messages_refusal_emulated",
  "pointer_messages_tool_name_sanitized",
  "pointer_multiple_choices_lossy",
  "pointer_responses_message_block_split",
  "pointer_responses_cache_creation_usage_dropped",
  "pointer_responses_cache_control_dropped",
  "pointer_responses_output_block_dropped",
  "pointer_responses_reasoning_signature_dropped",
  "pointer_responses_reasoning_control_dropped",
]);

const FEATURE_ID_BY_DETAIL_CODE: Readonly<Record<string, GatewayFeatureId>> = {
  pointer_chat_annotations_dropped: "metadata",
  pointer_chat_builtin_tool_dropped: "tool-definitions",
  pointer_chat_cache_creation_usage_dropped: "prompt-caching",
  pointer_chat_cache_control_dropped: "prompt-caching",
  pointer_chat_output_item_id_dropped: "metadata",
  pointer_chat_reasoning_metadata_dropped: "reasoning-results",
  pointer_chat_reasoning_control_dropped: "reasoning-controls",
  pointer_chat_response_block_dropped: "operation",
  pointer_chat_tool_result_split: "tool-results",
  pointer_chat_usage_detail_dropped: "token-usage",
  pointer_content_block_invalid: "ordered-multimodal-content",
  pointer_content_block_unsupported: "ordered-multimodal-content",
  pointer_content_shape_unsupported: "ordered-multimodal-content",
  pointer_cross_format_extension_dropped: "provider-extensions",
  pointer_extension_not_allowlisted: "provider-extensions",
  pointer_extension_not_json: "provider-extensions",
  pointer_image_block_invalid: "image-input",
  pointer_messages_annotations_dropped: "metadata",
  pointer_messages_block_dropped: "operation",
  pointer_messages_builtin_tool_dropped: "tool-definitions",
  pointer_messages_default_max_tokens: "stop-controls",
  pointer_messages_file_image_unsupported: "image-input",
  pointer_messages_instruction_hoisted: "system-instructions",
  pointer_messages_output_item_id_dropped: "metadata",
  pointer_messages_reasoning_signature_missing: "reasoning-results",
  pointer_messages_refusal_emulated: "text-output",
  pointer_messages_tool_name_sanitized: "tool-definitions",
  pointer_multiple_choices_lossy: "operation",
  pointer_reasoning_budget_invalid: "reasoning-controls",
  pointer_reasoning_control_unknown: "reasoning-controls",
  pointer_reasoning_control_unsupported: "reasoning-controls",
  pointer_reasoning_effort_unsupported: "reasoning-controls",
  pointer_response_input_item_unsupported: "ordered-multimodal-content",
  pointer_response_output_item_unsupported: "ordered-multimodal-content",
  pointer_responses_cache_creation_usage_dropped: "prompt-caching",
  pointer_responses_cache_control_dropped: "prompt-caching",
  pointer_responses_function_parameters_invalid: "json-schema",
  pointer_responses_instruction_block_dropped: "system-instructions",
  pointer_responses_message_block_split: "ordered-multimodal-content",
  pointer_responses_output_block_dropped: "operation",
  pointer_responses_reasoning_control_unknown: "reasoning-controls",
  pointer_responses_reasoning_effort_invalid: "reasoning-controls",
  pointer_responses_reasoning_signature_dropped: "reasoning-results",
  pointer_responses_reasoning_control_dropped: "reasoning-controls",
  pointer_responses_reasoning_summary_invalid: "reasoning-controls",
  pointer_text_block_invalid: "text-input",
  pointer_tool_call_invalid: "tool-calls",
  pointer_tool_calls_invalid: "tool-calls",
  pointer_tool_choice_unsupported: "tool-choice",
  pointer_tool_definition_invalid: "tool-definitions",
  pointer_tool_definition_unsupported: "tool-definitions",
  pointer_tool_schema_invalid: "json-schema",
};

function featureIdForFinding(path: string, code: string): GatewayFeatureId {
  const explicit = FEATURE_ID_BY_DETAIL_CODE[code];
  if (explicit) return explicit;

  const value = `${path}.${code}`;
  if (value.includes("reasoning") || value.includes("thinking")) {
    return value.includes("control") || value.includes("effort") || value.includes("budget") || value.includes("summary")
      ? "reasoning-controls"
      : "reasoning-results";
  }
  if (value.includes("finish")) return "finish-reasons";
  if (value.includes("cache")) return "prompt-caching";
  if (value.includes("usage")) return "token-usage";
  if (value.includes("maxoutput") || value.includes("max_output") || value.includes("stop")) return "stop-controls";
  if (value.includes("parallel") && value.includes("tool")) return "parallel-tool-calls";
  if (value.includes("tool_result")) return "tool-results";
  if (value.includes("tool_call")) return "tool-calls";
  if (value.includes("tool_choice")) return "tool-choice";
  if (value.includes("tool")) return "tool-definitions";
  if (value.includes("image")) return "image-input";
  if (value.includes("audio")) return "audio-input";
  if (value.includes("file")) return "file-input";
  if (value.includes("instruction") || value.includes("system")) return "system-instructions";
  if (value.includes("content") || value.includes("block")) return "ordered-multimodal-content";
  if (value.includes("extension")) return "provider-extensions";
  if (value.includes("metadata")) return "metadata";
  return "operation";
}

export function safeFindingPath(path: string): string {
  const segments = path.split(".").filter(Boolean).map((segment) => {
    if (/^[A-Za-z0-9_-]{1,48}$/.test(segment)) return segment;
    return `field_${stableGatewayId("path", segment).slice(5)}`;
  });
  const joined = segments.join(".") || "request";
  return joined.length <= 256
    ? joined
    : `request.${stableGatewayId("path", joined).slice(5)}`;
}

export function completeAdapter<T>(
  format: GatewayApiFormat,
  mode: GatewayAdapterMode,
  value: T,
  findings: readonly IrCompatibilityFinding[],
): GatewayAdapterResult<T> {
  const ordered = [...findings].sort((left, right) =>
    left.assessment.path.localeCompare(right.assessment.path) || left.detailCode.localeCompare(right.detailCode),
  );
  const blocked = ordered.find((entry) =>
    blockingErrorCodeForCompatibility(
      entry.assessment.state,
      mode,
      entry.assessment.bestEffortAllowed,
    ) !== null,
  );
  if (!blocked) return { ok: true, value, findings: ordered };

  const errorCode = blockingErrorCodeForCompatibility(
    blocked.assessment.state,
    mode,
    blocked.assessment.bestEffortAllowed,
  );

  return gatewayAdapterFailureSchema.parse({
    ok: false,
    error: {
      code: errorCode ?? "pointer_internal_error",
      message: blocked.assessment.message,
      format,
      issues: [{ path: blocked.assessment.path, message: blocked.assessment.message }],
      findings: ordered,
    },
  });
}

export interface ExtensionPolicy {
  sourceFormat: GatewayApiFormat;
  modeledKeys: ReadonlySet<string>;
  preservedKeys: ReadonlySet<string>;
}

export function collectExtensions(
  input: Record<string, unknown>,
  policy: ExtensionPolicy,
): { extensions: ProviderExtension[]; findings: IrCompatibilityFinding[] } {
  const extensions: ProviderExtension[] = [];
  const findings: IrCompatibilityFinding[] = [];

  for (const key of Object.keys(input).sort()) {
    if (policy.modeledKeys.has(key)) continue;
    const value = asJsonValue(input[key]);
    if (value === null && input[key] !== null) {
      findings.push(
        finding(
          policy.sourceFormat,
          key,
          "unsupported",
          "pointer_extension_not_json",
          `Extension ${key} is not JSON-safe and cannot cross the gateway boundary.`,
        ),
      );
      continue;
    }
    if (!policy.preservedKeys.has(key)) {
      findings.push(
        finding(
          policy.sourceFormat,
          key,
          "unsupported",
          "pointer_extension_not_allowlisted",
          `Extension ${key} is not in the audited ${policy.sourceFormat} allowlist.`,
        ),
      );
      continue;
    }
    extensions.push({ namespace: policy.sourceFormat, key, value });
  }
  return { extensions, findings };
}

export function emitExtensions(
  extensions: readonly ProviderExtension[],
  targetFormat: GatewayApiFormat,
): { values: JsonObject; findings: IrCompatibilityFinding[] } {
  const values: JsonObject = {};
  const findings: IrCompatibilityFinding[] = [];
  for (const extension of extensions) {
    if (extension.namespace === targetFormat) {
      values[extension.key] = extension.value;
      continue;
    }
    findings.push(
      finding(
        extension.namespace,
        `extensions.${extension.key}`,
        "lossy",
        "pointer_cross_format_extension_dropped",
        `Extension ${extension.key} is scoped to ${extension.namespace} and cannot be emitted as ${targetFormat}.`,
        targetFormat,
      ),
    );
  }
  return { values, findings };
}

export function requiredString(
  value: unknown,
  fallback: string,
): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
