import type { GatewayApiFormat } from "../../compatibility";
import type {
  IrCompatibilityFinding,
  IrFinishReason,
  IrToolChoice,
  IrUsage,
  JsonObject,
  JsonValue,
} from "./schemas";
import {
  finding,
  isRecord,
  optionalInteger,
} from "./common";

export function normalizeFinishReason(
  format: GatewayApiFormat,
  value: unknown,
  hasToolCalls = false,
): { finishReason: IrFinishReason; rawFinishReason?: string } {
  const raw = typeof value === "string" ? value : undefined;
  if (raw === "length" || raw === "max_tokens" || raw === "incomplete") {
    return { finishReason: "length", rawFinishReason: raw };
  }
  if (raw === "content_filter") return { finishReason: "content_filter", rawFinishReason: raw };
  if (
    format === "google-generate-content"
    && raw
    && [
      "SAFETY",
      "RECITATION",
      "LANGUAGE",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
      "IMAGE_PROHIBITED_CONTENT",
      "NO_IMAGE",
    ].includes(raw)
  ) {
    return { finishReason: "content_filter", rawFinishReason: raw };
  }
  if (raw === "refusal") return { finishReason: "content_filter", rawFinishReason: raw };
  if (raw === "failed" || raw === "error") return { finishReason: "error", rawFinishReason: raw };
  if (raw === "cancelled") return { finishReason: "cancelled", rawFinishReason: raw };
  if (hasToolCalls || raw === "tool_calls" || raw === "function_call" || raw === "tool_use") {
    return { finishReason: "tool_calls", ...(raw ? { rawFinishReason: raw } : {}) };
  }
  if (format === "google-generate-content" && raw === "MAX_TOKENS") {
    return { finishReason: "length", rawFinishReason: raw };
  }
  if (
    format === "google-generate-content"
    && raw
    && ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER"].includes(raw)
  ) {
    return { finishReason: "error", rawFinishReason: raw };
  }
  if (format === "google-generate-content" && raw === "STOP") {
    return { finishReason: hasToolCalls ? "tool_calls" : "stop", rawFinishReason: raw };
  }
  if (raw === "stop" || raw === "end_turn" || raw === "stop_sequence" || raw === "completed" || raw === "pause_turn") {
    return { finishReason: "stop", rawFinishReason: raw };
  }
  return { finishReason: "unknown", ...(raw ? { rawFinishReason: raw } : {}) };
}

const FINISH_REASONS_BY_FORMAT: Record<GatewayApiFormat, ReadonlySet<string>> = {
  "chat-completions": new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]),
  messages: new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal", "pause_turn"]),
  responses: new Set(["completed", "incomplete", "failed", "cancelled"]),
  "google-generate-content": new Set([
    "STOP",
    "MAX_TOKENS",
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "OTHER",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "IMAGE_SAFETY",
    "UNEXPECTED_TOOL_CALL",
    "IMAGE_PROHIBITED_CONTENT",
    "NO_IMAGE",
  ]),
};

export function finishReasonForFormat(
  format: GatewayApiFormat,
  reason: IrFinishReason,
  raw?: string,
): string | null {
  if (
    raw &&
    FINISH_REASONS_BY_FORMAT[format].has(raw) &&
    normalizeFinishReason(format, raw).finishReason === reason
  ) return raw;
  if (format === "messages") {
    if (reason === "tool_calls") return "tool_use";
    if (reason === "length") return "max_tokens";
    if (reason === "content_filter") return "refusal";
    if (reason === "stop") return "end_turn";
    return null;
  }
  if (format === "responses") {
    if (reason === "length") return "incomplete";
    if (reason === "error") return "failed";
    if (reason === "cancelled") return "cancelled";
    if (reason === "stop" || reason === "tool_calls" || reason === "content_filter") return "completed";
    return null;
  }
  if (format === "google-generate-content") {
    if (reason === "length") return "MAX_TOKENS";
    if (reason === "content_filter") return "SAFETY";
    if (reason === "error" || reason === "cancelled") return "OTHER";
    if (reason === "stop" || reason === "tool_calls") return "STOP";
    return null;
  }
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  if (reason === "stop") return "stop";
  return null;
}

export function responseStatusForFinishReason(
  reason: IrFinishReason,
): "in_progress" | "completed" | "incomplete" | "failed" | "cancelled" {
  if (reason === "length" || reason === "content_filter") return "incomplete";
  if (reason === "error") return "failed";
  if (reason === "cancelled") return "cancelled";
  return "completed";
}

export function usageFromChat(value: unknown): IrUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = optionalInteger(value.prompt_tokens);
  const outputTokens = optionalInteger(value.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const outputDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: optionalInteger(value.total_tokens) ?? inputTokens + outputTokens,
    ...(optionalInteger(details?.cached_tokens) !== undefined
      ? { cachedInputTokens: optionalInteger(details?.cached_tokens) }
      : {}),
    ...(optionalInteger(outputDetails?.reasoning_tokens) !== undefined
      ? { reasoningTokens: optionalInteger(outputDetails?.reasoning_tokens) }
      : {}),
  };
}

export function usageFromMessages(value: unknown): IrUsage | undefined {
  if (!isRecord(value)) return undefined;
  const uncachedInputTokens = optionalInteger(value.input_tokens);
  const outputTokens = optionalInteger(value.output_tokens);
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined;
  // IR counts the whole prompt. Messages reports three disjoint input buckets.
  const inputTokens = uncachedInputTokens
    + (optionalInteger(value.cache_read_input_tokens) ?? 0)
    + (optionalInteger(value.cache_creation_input_tokens) ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(optionalInteger(value.cache_read_input_tokens) !== undefined
      ? { cachedInputTokens: optionalInteger(value.cache_read_input_tokens) }
      : {}),
    ...(optionalInteger(value.cache_creation_input_tokens) !== undefined
      ? { cacheCreationInputTokens: optionalInteger(value.cache_creation_input_tokens) }
      : {}),
    ...(optionalInteger(value.reasoning_tokens) !== undefined
      ? { reasoningTokens: optionalInteger(value.reasoning_tokens) }
      : {}),
  };
}

export function usageFromResponses(value: unknown): IrUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = optionalInteger(value.input_tokens);
  const outputTokens = optionalInteger(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: optionalInteger(value.total_tokens) ?? inputTokens + outputTokens,
    ...(optionalInteger(inputDetails?.cached_tokens) !== undefined
      ? { cachedInputTokens: optionalInteger(inputDetails?.cached_tokens) }
      : {}),
    ...(optionalInteger(outputDetails?.reasoning_tokens) !== undefined
      ? { reasoningTokens: optionalInteger(outputDetails?.reasoning_tokens) }
      : {}),
  };
}

export function usageFromGoogle(value: unknown): IrUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = optionalInteger(value.promptTokenCount);
  const outputTokens = optionalInteger(value.candidatesTokenCount)
    ?? optionalInteger(value.responseTokenCount);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: optionalInteger(value.totalTokenCount) ?? inputTokens + outputTokens,
    ...(optionalInteger(value.cachedContentTokenCount) !== undefined
      ? { cachedInputTokens: optionalInteger(value.cachedContentTokenCount) }
      : {}),
    ...(optionalInteger(value.thoughtsTokenCount) !== undefined
      ? { reasoningTokens: optionalInteger(value.thoughtsTokenCount) }
      : {}),
  };
}

export function usageToChat(usage: IrUsage): JsonObject {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  };
}

export function usageToMessages(usage: IrUsage): JsonObject {
  return {
    input_tokens: Math.max(0, usage.inputTokens
      - (usage.cachedInputTokens ?? 0) - (usage.cacheCreationInputTokens ?? 0)),
    output_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoning_tokens: usage.reasoningTokens }
      : {}),
  };
}

export function usageToResponses(usage: IrUsage): JsonObject {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  };
}

export function usageToGoogle(usage: IrUsage): JsonObject {
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedContentTokenCount: usage.cachedInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { thoughtsTokenCount: usage.reasoningTokens }
      : {}),
  };
}

export function parseToolChoice(
  format: GatewayApiFormat,
  value: unknown,
): { choice?: IrToolChoice; findings: IrCompatibilityFinding[] } {
  const findings: IrCompatibilityFinding[] = [];
  if (value === undefined || value === null) return { findings };
  if (value === "auto") return { choice: { type: "auto" }, findings };
  if (value === "none") return { choice: { type: "none" }, findings };
  if (value === "required" || (format === "messages" && value === "any")) {
    return { choice: { type: "required" }, findings };
  }
  if (isRecord(value)) {
    if (format === "chat-completions" && value.type === "function") {
      const fn = isRecord(value.function) ? value.function : undefined;
      if (
        typeof fn?.name === "string"
        && Object.keys(value).every((key) => key === "type" || key === "function")
        && Object.keys(fn).every((key) => key === "name")
      ) {
        return { choice: { type: "function", name: fn.name }, findings };
      }
    }
    if (format === "messages") {
      const knownKeys = Object.keys(value).every((key) =>
        key === "type" || key === "name" || key === "disable_parallel_tool_use"
      );
      if (knownKeys && value.type === "auto") return { choice: { type: "auto" }, findings };
      if (knownKeys && value.type === "none") return { choice: { type: "none" }, findings };
      if (knownKeys && value.type === "any") return { choice: { type: "required" }, findings };
      if (knownKeys && value.type === "tool" && typeof value.name === "string") {
        return { choice: { type: "function", name: value.name }, findings };
      }
    }
    if (
      format === "responses"
      && value.type === "function"
      && typeof value.name === "string"
      && Object.keys(value).every((key) => key === "type" || key === "name")
    ) {
      return { choice: { type: "function", name: value.name }, findings };
    }
  }
  findings.push(
    finding(
      format,
      "tool_choice",
      "unsupported",
      "pointer_tool_choice_unsupported",
      "The requested tool_choice shape is not supported by the typed gateway protocol.",
    ),
  );
  return { findings };
}

export function jsonObjectOrEmpty(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      child === null ||
      typeof child === "string" ||
      typeof child === "boolean" ||
      (typeof child === "number" && Number.isFinite(child)) ||
      Array.isArray(child) ||
      isRecord(child)
    ) {
      result[key] = child as JsonValue;
    }
  }
  return result;
}
