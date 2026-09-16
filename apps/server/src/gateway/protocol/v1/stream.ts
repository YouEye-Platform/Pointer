import { nativeResponseItem, NATIVE_RESPONSE_EVENTS } from "./responses-native";
import type { GatewayApiFormat } from "../../compatibility";
import {
  GATEWAY_IR_NAME,
  GATEWAY_IR_VERSION,
  type GatewayAdapterFailure,
  type IrContentBlock,
  type IrFinishReason,
  type IrStreamEvent,
  type IrUsage,
  type JsonObject,
  irStreamEventSchema,
} from "./schemas";
import {
  asJsonObject,
  invalidPayloadFailure,
  isRecord,
  optionalInteger,
  requiredString,
  stableGatewayId,
} from "./common";
import {
  finishReasonForFormat,
  normalizeFinishReason,
  usageFromChat,
  usageFromMessages,
  usageFromResponses,
  usageFromGoogle,
  usageToChat,
  usageToMessages,
  usageToResponses,
  usageToGoogle,
} from "./normalize";
import { parsePublicError } from "./errors";

type OpenBlockKind = "text" | "reasoning" | "tool_call";

interface StreamToolCall {
  callId: string;
  index: number;
  itemId?: string;
  name: string;
  providerMetadata?: JsonObject;
}

export interface StreamAdapterContext {
  requestId: string;
  responseId: string;
  model: string;
  sequence: number;
  started: boolean;
  finishReason: IrFinishReason;
  rawFinishReason?: string;
  finishObserved: boolean;
  ended: boolean;
  nextBlockIndex: number;
  openBlocks: Readonly<Record<number, OpenBlockKind>>;
  sourceBlocks: Readonly<Record<string, number>>;
  usage?: IrUsage;
  toolCalls: Readonly<Record<number, StreamToolCall>>;
  chatReasoningDetails: readonly JsonObject[];
  nativeResponseItems: Readonly<Record<number, string>>;
  nativeResponseItemsDone: Readonly<Record<number, boolean>>;
}

export interface ParsedStreamEvent {
  events: IrStreamEvent[];
  context: StreamAdapterContext;
}

export interface PublicStreamEvent {
  event?: string;
  data: unknown;
}

/**
 * Creates request-local stream state. The request ID is required so fallback IDs
 * are reproducible without collapsing independent requests for the same model.
 */
export function createStreamAdapterContext(
  model: string,
  requestId: string,
  responseId?: string,
): StreamAdapterContext {
  return {
    requestId,
    responseId: responseId ?? stableGatewayId("response", requestId),
    model,
    sequence: 0,
    started: false,
    finishReason: "unknown",
    finishObserved: false,
    ended: false,
    nextBlockIndex: 0,
    openBlocks: {},
    sourceBlocks: {},
    toolCalls: {},
    chatReasoningDetails: [],
    nativeResponseItems: {},
    nativeResponseItemsDone: {},
  };
}

function chatReasoningDetailObjects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((detail) => {
    const parsed = asJsonObject(detail);
    return parsed ? [parsed] : [];
  });
}

function mergeChatReasoningDetails(
  previous: readonly JsonObject[],
  value: unknown,
): JsonObject[] {
  const incoming = chatReasoningDetailObjects(value);
  if (incoming.length === 0) return [...previous];
  const merged = new Map<number, JsonObject>();
  for (const [position, detail] of previous.entries()) {
    merged.set(optionalInteger(detail.index) ?? position, { ...detail });
  }
  for (const [position, detail] of incoming.entries()) {
    const index = optionalInteger(detail.index) ?? position;
    const prior = merged.get(index) ?? {};
    const next = { ...prior, ...detail };
    for (const key of ["data", "text", "summary"] as const) {
      const priorFragment = typeof prior[key] === "string" ? prior[key] : "";
      const nextFragment = typeof detail[key] === "string" ? detail[key] : undefined;
      if (nextFragment !== undefined) {
        next[key] = nextFragment.startsWith(priorFragment)
          ? nextFragment
          : `${priorFragment}${nextFragment}`;
      }
    }
    merged.set(index, next);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, detail]) => detail);
}

function streamToolProviderMetadata(
  prior: JsonObject | undefined,
  extraContent: unknown,
  reasoningDetails: readonly JsonObject[],
): JsonObject | undefined {
  const metadata = { ...(prior ?? {}), ...(asJsonObject(extraContent) ?? {}) };
  if (reasoningDetails.length > 0) {
    const openRouter = asJsonObject(metadata.openrouter) ?? {};
    metadata.openrouter = { ...openRouter, reasoning_details: [...reasoningDetails] };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function eventBase(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
): {
  protocol: typeof GATEWAY_IR_NAME;
  version: typeof GATEWAY_IR_VERSION;
  sourceFormat: GatewayApiFormat;
  responseId: string;
  model: string;
  sequence: number;
} {
  return {
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    sourceFormat: format,
    responseId: context.responseId,
    model: context.model,
    sequence: context.sequence,
  };
}

function finalized(
  context: StreamAdapterContext,
  events: IrStreamEvent[],
  updates: Partial<StreamAdapterContext> = {},
): ParsedStreamEvent {
  const next = { ...context, ...updates, sequence: context.sequence + events.length };
  return {
    events: events.map((event, index) =>
      irStreamEventSchema.parse({ ...event, sequence: context.sequence + index }),
    ),
    context: next,
  };
}

function streamFailure(format: GatewayApiFormat, message: string): GatewayAdapterFailure {
  return invalidPayloadFailure(format, [{ path: "data", message }]);
}

function startResponse(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  events: IrStreamEvent[],
): StreamAdapterContext {
  if (context.started) return context;
  events.push({ ...eventBase(format, context), type: "response_start" });
  return { ...context, started: true };
}

function sourceBlockIndex(
  context: StreamAdapterContext,
  key: string,
  preferred?: number,
): { context: StreamAdapterContext; index: number } {
  const existing = context.sourceBlocks[key];
  if (existing !== undefined) return { context, index: existing };
  const occupied = new Set(Object.values(context.sourceBlocks));
  let index = preferred !== undefined && !occupied.has(preferred)
    ? preferred
    : context.nextBlockIndex;
  while (occupied.has(index)) index += 1;
  return {
    index,
    context: {
      ...context,
      nextBlockIndex: Math.max(context.nextBlockIndex, index + 1),
      sourceBlocks: { ...context.sourceBlocks, [key]: index },
    },
  };
}

function openContentBlock(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  events: IrStreamEvent[],
  index: number,
  kind: "text" | "reasoning",
  block: IrContentBlock,
): StreamAdapterContext {
  if (context.openBlocks[index] === kind) return context;
  if (context.openBlocks[index] !== undefined) {
    events.push({ ...eventBase(format, context), type: "content_end", index });
  }
  events.push({ ...eventBase(format, context), type: "content_start", index, block });
  return { ...context, openBlocks: { ...context.openBlocks, [index]: kind } };
}

function openToolBlock(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  events: IrStreamEvent[],
  tool: StreamToolCall,
): StreamAdapterContext {
  if (context.openBlocks[tool.index] === "tool_call") return context;
  if (context.openBlocks[tool.index] !== undefined) {
    events.push({ ...eventBase(format, context), type: "content_end", index: tool.index });
  }
  events.push({
    ...eventBase(format, context),
    type: "tool_call_start",
    index: tool.index,
    callId: tool.callId,
    ...(tool.itemId ? { itemId: tool.itemId } : {}),
    name: tool.name,
    ...(tool.providerMetadata ? { providerMetadata: tool.providerMetadata } : {}),
  });
  return {
    ...context,
    openBlocks: { ...context.openBlocks, [tool.index]: "tool_call" },
  };
}

function closeBlock(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  events: IrStreamEvent[],
  index: number,
): StreamAdapterContext {
  if (context.openBlocks[index] === undefined) return context;
  events.push({ ...eventBase(format, context), type: "content_end", index });
  const openBlocks = { ...context.openBlocks };
  delete openBlocks[index];
  return { ...context, openBlocks };
}

function closeAllBlocks(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  events: IrStreamEvent[],
): StreamAdapterContext {
  let current = context;
  for (const index of Object.keys(context.openBlocks).map(Number).sort((a, b) => a - b)) {
    current = closeBlock(format, current, events, index);
  }
  return current;
}

export function normalizeUpstreamStreamError(
  format: GatewayApiFormat,
  context: StreamAdapterContext,
  body: unknown = null,
  empty = false,
): ParsedStreamEvent | GatewayAdapterFailure {
  const parsed = parsePublicError(
    format,
    { status: 502, body },
    { requestId: context.requestId },
  );
  if (!parsed.ok) {
    return streamFailure(format, "Provider stream error normalization failed.");
  }
  if (empty) {
    parsed.value.code = "pointer_empty_response";
    parsed.value.message = "Provider completed without model output.";
  }
  const events: IrStreamEvent[] = [];
  const current = closeAllBlocks(format, context, events);
  events.push({
    ...eventBase(format, current),
    type: "error",
    error: parsed.value,
  });
  return finalized(current, events, {
    ended: true,
    finishObserved: true,
    finishReason: "error",
    rawFinishReason: "error",
  });
}

function mergeUsage(previous: IrUsage | undefined, next: unknown): IrUsage | undefined {
  if (!isRecord(next)) return previous;
  const previousUncached = previous ? Math.max(0, previous.inputTokens
    - (previous.cachedInputTokens ?? 0) - (previous.cacheCreationInputTokens ?? 0)) : undefined;
  const uncachedInputTokens = optionalInteger(next.input_tokens) ?? previousUncached;
  const outputTokens = optionalInteger(next.output_tokens) ?? previous?.outputTokens;
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = optionalInteger(next.cache_read_input_tokens)
    ?? previous?.cachedInputTokens;
  const cacheCreationInputTokens = optionalInteger(next.cache_creation_input_tokens)
    ?? previous?.cacheCreationInputTokens;
  const reasoningTokens = optionalInteger(next.reasoning_tokens) ?? previous?.reasoningTokens;
  const inputTokens = uncachedInputTokens + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function parseChatEvent(
  data: unknown,
  context: StreamAdapterContext,
): ParsedStreamEvent | GatewayAdapterFailure {
  if (data === "[DONE]") {
    if (context.ended) return finalized(context, []);
    const events: IrStreamEvent[] = [];
    let current = startResponse("chat-completions", context, events);
    current = closeAllBlocks("chat-completions", current, events);
    events.push({
      ...eventBase("chat-completions", current),
      type: "response_end",
      finishReason: current.finishReason,
      ...(current.rawFinishReason ? { rawFinishReason: current.rawFinishReason } : {}),
    });
    return finalized(current, events, { ended: true });
  }
  if (context.ended) return streamFailure("chat-completions", "Stream data followed its terminal event.");
  if (!isRecord(data)) {
    return streamFailure("chat-completions", "Chat stream data must be an object or [DONE].");
  }
  if (isRecord(data.error)) {
    return normalizeUpstreamStreamError("chat-completions", context);
  }

  const id = context.started ? context.responseId : requiredString(data.id, context.responseId);
  const model = context.started ? context.model : requiredString(data.model, context.model);
  let current = { ...context, responseId: id, model };
  const choice = Array.isArray(data.choices) && isRecord(data.choices[0])
    ? data.choices[0]
    : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : {};
  const chatReasoningDetails = mergeChatReasoningDetails(
    current.chatReasoningDetails,
    delta.reasoning_details,
  );
  if (chatReasoningDetails.length > 0) current = { ...current, chatReasoningDetails };
  const reasoningDelta = typeof delta.reasoning_content === "string"
    ? delta.reasoning_content
    : typeof delta.reasoning === "string"
      ? delta.reasoning
      : undefined;
  const hasContentAfterFinish = choice !== undefined && (
    (typeof delta.content === "string" && delta.content.length > 0)
    || (typeof reasoningDelta === "string" && reasoningDelta.length > 0)
    || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
  );
  if (context.finishObserved && hasContentAfterFinish) {
    return streamFailure("chat-completions", "Chat stream content followed its finish reason.");
  }
  const events: IrStreamEvent[] = [];
  current = startResponse("chat-completions", current, events);
  const choiceIndex = optionalInteger(choice?.index) ?? 0;

  if (!context.finishObserved && typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
    const located = sourceBlockIndex(current, `reasoning:${choiceIndex}`, choiceIndex);
    current = openContentBlock(
      "chat-completions",
      located.context,
      events,
      located.index,
      "reasoning",
      { type: "reasoning", text: "" },
    );
    events.push({
      ...eventBase("chat-completions", current),
      type: "reasoning_delta",
      index: located.index,
      delta: reasoningDelta,
    });
  }
  if (!context.finishObserved && typeof delta.content === "string" && delta.content.length > 0) {
    const located = sourceBlockIndex(current, `text:${choiceIndex}`, choiceIndex);
    current = openContentBlock(
      "chat-completions",
      located.context,
      events,
      located.index,
      "text",
      { type: "text", text: "" },
    );
    events.push({
      ...eventBase("chat-completions", current),
      type: "text_delta",
      index: located.index,
      delta: delta.content,
    });
  }

  const toolCalls = { ...current.toolCalls };
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      if (!isRecord(raw)) continue;
      const sourceIndex = optionalInteger(raw.index) ?? 0;
      const fn = isRecord(raw.function) ? raw.function : {};
      const prior = toolCalls[sourceIndex];
      const located = prior
        ? { context: current, index: prior.index }
        : sourceBlockIndex(current, `tool:${sourceIndex}`, sourceIndex);
      current = located.context;
      const callId = requiredString(
        raw.id,
        prior?.callId ?? stableGatewayId("call", current.requestId, String(sourceIndex)),
      );
      const name = requiredString(fn.name, prior?.name ?? "tool");
      const providerMetadata = streamToolProviderMetadata(
        prior?.providerMetadata,
        raw.extra_content,
        current.chatReasoningDetails,
      );
      const tool = {
        callId,
        index: located.index,
        name,
        ...(providerMetadata ? { providerMetadata } : {}),
      };
      toolCalls[sourceIndex] = tool;
      current = openToolBlock("chat-completions", current, events, tool);
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        events.push({
          ...eventBase("chat-completions", current),
          type: "tool_arguments_delta",
          index: tool.index,
          callId,
          delta: fn.arguments,
        });
      }
    }
  }
  current = { ...current, toolCalls };

  const normalized = normalizeFinishReason(
    "chat-completions",
    choice?.finish_reason,
    Object.keys(toolCalls).length > 0,
  );
  const finishObserved = choice?.finish_reason !== null && choice?.finish_reason !== undefined;
  if (
    context.finishObserved
    && finishObserved
    && (
      normalized.finishReason !== context.finishReason
      || normalized.rawFinishReason !== context.rawFinishReason
    )
  ) {
    return streamFailure("chat-completions", "Chat stream repeated a conflicting finish reason.");
  }
  if (finishObserved) current = closeAllBlocks("chat-completions", current, events);
  const usage = usageFromChat(data.usage);
  if (usage) events.push({ ...eventBase("chat-completions", current), type: "usage", usage });
  return finalized(current, events, {
    usage: usage ?? current.usage,
    ...(finishObserved ? normalized : {}),
    finishObserved: current.finishObserved || finishObserved,
  });
}

function parseMessagesEvent(
  eventName: string | undefined,
  data: unknown,
  context: StreamAdapterContext,
): ParsedStreamEvent | GatewayAdapterFailure {
  if (context.ended) return streamFailure("messages", "Stream data followed its terminal event.");
  if (!isRecord(data)) return streamFailure("messages", "Messages stream data must be an object.");
  const type = typeof data.type === "string" ? data.type : eventName;
  if (!type) return streamFailure("messages", "Messages stream event type is required.");
  const events: IrStreamEvent[] = [];
  let current = context;
  let normalized = {
    finishReason: context.finishReason,
    ...(context.rawFinishReason ? { rawFinishReason: context.rawFinishReason } : {}),
  };

  if (type === "message_start" && isRecord(data.message)) {
    current = {
      ...context,
      responseId: context.started
        ? context.responseId
        : requiredString(data.message.id, context.responseId),
      model: context.started ? context.model : requiredString(data.message.model, context.model),
    };
    current = startResponse("messages", current, events);
    const usage = usageFromMessages(data.message.usage);
    if (usage) {
      current = { ...current, usage };
      events.push({ ...eventBase("messages", current), type: "usage", usage });
    }
  } else if (type === "content_block_start" && isRecord(data.content_block)) {
    current = startResponse("messages", current, events);
    const sourceIndex = optionalInteger(data.index) ?? 0;
    const block = data.content_block;
    const located = sourceBlockIndex(current, `block:${sourceIndex}`, sourceIndex);
    current = located.context;
    if (block.type === "tool_use") {
      const callId = requiredString(
        block.id,
        stableGatewayId("call", current.requestId, String(sourceIndex)),
      );
      const providerMetadata = asJsonObject(block.extra_content) ?? undefined;
      const tool = {
        callId,
        index: located.index,
        name: requiredString(block.name, "tool"),
        ...(providerMetadata ? { providerMetadata } : {}),
      };
      current = {
        ...openToolBlock("messages", current, events, tool),
        toolCalls: { ...current.toolCalls, [sourceIndex]: tool },
      };
    } else if (block.type === "thinking") {
      current = openContentBlock(
        "messages",
        current,
        events,
        located.index,
        "reasoning",
        {
          type: "reasoning",
          text: "",
          ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
        },
      );
    } else if (block.type === "text") {
      current = openContentBlock(
        "messages",
        current,
        events,
        located.index,
        "text",
        { type: "text", text: "" },
      );
    } else {
      return streamFailure("messages", "Unsupported Messages content block type.");
    }
  } else if (type === "content_block_delta" && isRecord(data.delta)) {
    current = startResponse("messages", current, events);
    const sourceIndex = optionalInteger(data.index) ?? 0;
    const located = sourceBlockIndex(current, `block:${sourceIndex}`, sourceIndex);
    current = located.context;
    if (data.delta.type === "text_delta" && typeof data.delta.text === "string") {
      current = openContentBlock(
        "messages",
        current,
        events,
        located.index,
        "text",
        { type: "text", text: "" },
      );
      events.push({
        ...eventBase("messages", current),
        type: "text_delta",
        index: located.index,
        delta: data.delta.text,
      });
    } else if (data.delta.type === "thinking_delta" && typeof data.delta.thinking === "string") {
      current = openContentBlock(
        "messages",
        current,
        events,
        located.index,
        "reasoning",
        { type: "reasoning", text: "" },
      );
      events.push({
        ...eventBase("messages", current),
        type: "reasoning_delta",
        index: located.index,
        delta: data.delta.thinking,
      });
    } else if (
      data.delta.type === "input_json_delta"
      && typeof data.delta.partial_json === "string"
    ) {
      const prior = current.toolCalls[sourceIndex];
      const tool = prior ?? {
        callId: stableGatewayId("call", current.requestId, String(sourceIndex)),
        index: located.index,
        name: "tool",
      };
      current = {
        ...openToolBlock("messages", current, events, tool),
        toolCalls: { ...current.toolCalls, [sourceIndex]: tool },
      };
      events.push({
        ...eventBase("messages", current),
        type: "tool_arguments_delta",
        index: tool.index,
        callId: tool.callId,
        delta: data.delta.partial_json,
      });
    } else {
      return streamFailure("messages", "Unsupported Messages content block delta type.");
    }
  } else if (type === "content_block_stop") {
    const sourceIndex = optionalInteger(data.index) ?? 0;
    const located = sourceBlockIndex(current, `block:${sourceIndex}`, sourceIndex);
    current = closeBlock("messages", located.context, events, located.index);
  } else if (type === "message_delta") {
    const delta = isRecord(data.delta) ? data.delta : {};
    normalized = normalizeFinishReason(
      "messages",
      delta.stop_reason,
      Object.keys(current.toolCalls).length > 0,
    );
    if (data.usage !== undefined) {
      const usage = mergeUsage(current.usage, data.usage);
      if (!usage) {
        return streamFailure(
          "messages",
          "Messages usage delta arrived without an input token count.",
        );
      }
      current = { ...current, usage };
      events.push({ ...eventBase("messages", current), type: "usage", usage });
    }
  } else if (type === "message_stop") {
    current = startResponse("messages", current, events);
    current = closeAllBlocks("messages", current, events);
    events.push({ ...eventBase("messages", current), type: "response_end", ...normalized });
    return finalized(current, events, { ...normalized, ended: true });
  } else if (type === "ping") {
    return finalized(current, []);
  } else if (type === "error") {
    return normalizeUpstreamStreamError("messages", current);
  } else {
    return streamFailure("messages", "Unsupported Messages stream event type.");
  }
  return finalized(current, events, { ...normalized });
}

function responsesFinishReason(
  type: string,
  response: Record<string, unknown>,
  hasToolCalls: boolean,
): { finishReason: IrFinishReason; rawFinishReason?: string } {
  if (type === "response.cancelled") return { finishReason: "cancelled", rawFinishReason: "cancelled" };
  if (type === "response.failed") return { finishReason: "error", rawFinishReason: "failed" };
  if (type === "response.incomplete") {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
    if (details?.reason === "content_filter") {
      return { finishReason: "content_filter", rawFinishReason: "content_filter" };
    }
    return { finishReason: "length", rawFinishReason: "incomplete" };
  }
  return normalizeFinishReason(
    "responses",
    requiredString(response.status, type.replace("response.", "")),
    hasToolCalls,
  );
}

function parseResponsesEvent(
  eventName: string | undefined,
  data: unknown,
  context: StreamAdapterContext,
): ParsedStreamEvent | GatewayAdapterFailure {
  if (context.ended) return streamFailure("responses", "Stream data followed its terminal event.");
  if (!isRecord(data)) return streamFailure("responses", "Responses stream data must be an object.");
  const type = typeof data.type === "string" ? data.type : eventName;
  if (!type) return streamFailure("responses", "Responses stream event type is required.");
  const events: IrStreamEvent[] = [];
  let current = context;

  // Some Responses-compatible providers send data-bearing heartbeat events
  // instead of SSE comment lines. They carry no model output and must remain
  // transparent to translation, just like Messages `ping` events.
  if (type === "keepalive" || type === "ping") {
    return finalized(current, []);
  } else if ((type === "response.created" || type === "response.in_progress") && isRecord(data.response)) {
    current = {
      ...context,
      responseId: context.started
        ? context.responseId
        : requiredString(data.response.id, context.responseId),
      model: context.started ? context.model : requiredString(data.response.model, context.model),
    };
    current = startResponse("responses", current, events);
  } else if (current.nativeResponseItems[optionalInteger(data.output_index) ?? -1] === "message"
    && ["response.output_text.delta", "response.output_text.done", "response.content_part.added", "response.content_part.done"].includes(type)) {
    const sourceIndex = optionalInteger(data.output_index)!;
    if (current.nativeResponseItemsDone[sourceIndex] || (type.endsWith(".delta") && typeof data.delta !== "string")) return streamFailure("responses", "Invalid phased message event.");
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    events.push({ ...eventBase("responses", current), type: "responses_native_event", event: type, data: { ...asJsonObject(data)!, output_index: located.index } });
  } else if (type === "response.output_text.delta" && typeof data.delta === "string") {
    current = startResponse("responses", current, events);
    const sourceIndex = optionalInteger(data.output_index) ?? 0;
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    current = openContentBlock(
      "responses",
      located.context,
      events,
      located.index,
      "text",
      {
        type: "text",
        text: "",
        ...(typeof data.item_id === "string" ? { id: data.item_id } : {}),
      },
    );
    events.push({
      ...eventBase("responses", current),
      type: "text_delta",
      index: located.index,
      delta: data.delta,
    });
  } else if (
    (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta")
    && typeof data.delta === "string"
  ) {
    current = startResponse("responses", current, events);
    const sourceIndex = optionalInteger(data.output_index) ?? 0;
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    current = openContentBlock(
      "responses",
      located.context,
      events,
      located.index,
      "reasoning",
      {
        type: "reasoning",
        text: "",
        ...(typeof data.item_id === "string" ? { id: data.item_id } : {}),
      },
    );
    events.push({
      ...eventBase("responses", current),
      type: "reasoning_delta",
      index: located.index,
      delta: data.delta,
    });
  } else if (type === "response.output_item.added" && isRecord(data.item)) {
    current = startResponse("responses", current, events);
    const sourceIndex = optionalInteger(data.output_index) ?? 0;
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    current = located.context;
    const native = nativeResponseItem(data.item);
    if (native) {
      if (current.nativeResponseItems[sourceIndex]) return streamFailure("responses", "Repeated native Responses item.");
      current = { ...current, nativeResponseItems: { ...current.nativeResponseItems, [sourceIndex]: String(native.type) } };
      events.push({ ...eventBase("responses", current), type: "responses_native_event", event: type, data: { ...asJsonObject(data)!, output_index: located.index } });
    } else if (data.item.type === "function_call") {
      const tool: StreamToolCall = {
        callId: requiredString(
          data.item.call_id,
          stableGatewayId("call", current.requestId, String(sourceIndex)),
        ),
        index: located.index,
        ...(typeof data.item.id === "string" ? { itemId: data.item.id } : {}),
        name: requiredString(data.item.name, "tool"),
      };
      current = {
        ...openToolBlock("responses", current, events, tool),
        toolCalls: { ...current.toolCalls, [sourceIndex]: tool },
      };
    } else if (data.item.type === "message" || data.item.type === "reasoning") {
      const kind = data.item.type === "reasoning" ? "reasoning" : "text";
      current = openContentBlock(
        "responses",
        current,
        events,
        located.index,
        kind,
        {
          type: kind,
          text: "",
          ...(typeof data.item.id === "string" ? { id: data.item.id } : {}),
        },
      );
    } else {
      return streamFailure("responses", "Unsupported Responses output item type.");
    }
  } else if (type === "response.output_item.done") {
    const sourceIndex = optionalInteger(data.output_index) ?? 0;
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    if (current.nativeResponseItems[sourceIndex]) {
      const native = nativeResponseItem(data.item);
      if (!native || native.type !== current.nativeResponseItems[sourceIndex]) return streamFailure("responses", "Invalid native Responses completed item.");
      if (current.nativeResponseItemsDone[sourceIndex]) return streamFailure("responses", "Repeated native Responses completion.");
      current = { ...current, nativeResponseItemsDone: { ...current.nativeResponseItemsDone, [sourceIndex]: true } };
      events.push({ ...eventBase("responses", current), type: "responses_native_event", event: type, data: { ...asJsonObject(data)!, output_index: located.index } });
    } else current = closeBlock("responses", located.context, events, located.index);
  } else if (NATIVE_RESPONSE_EVENTS.has(type) && current.nativeResponseItems[optionalInteger(data.output_index) ?? -1]) {
    const sourceIndex = optionalInteger(data.output_index)!;
    if (current.nativeResponseItemsDone[sourceIndex] || (type.endsWith(".delta") && typeof data.delta !== "string")) return streamFailure("responses", "Invalid native Responses item event.");
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    events.push({ ...eventBase("responses", current), type: "responses_native_event", event: type, data: { ...asJsonObject(data)!, output_index: located.index } });
  } else if (type === "response.function_call_arguments.delta" && typeof data.delta === "string") {
    current = startResponse("responses", current, events);
    const sourceIndex = optionalInteger(data.output_index) ?? 0;
    const located = sourceBlockIndex(current, `output:${sourceIndex}`, sourceIndex);
    current = located.context;
    const prior = current.toolCalls[sourceIndex];
    const tool: StreamToolCall = prior ?? {
      callId: requiredString(
        data.call_id,
        stableGatewayId("call", current.requestId, String(sourceIndex)),
      ),
      index: located.index,
      ...(typeof data.item_id === "string" ? { itemId: data.item_id } : {}),
      name: "tool",
    };
    current = {
      ...openToolBlock("responses", current, events, tool),
      toolCalls: { ...current.toolCalls, [sourceIndex]: tool },
    };
    events.push({
      ...eventBase("responses", current),
      type: "tool_arguments_delta",
      index: tool.index,
      callId: tool.callId,
      delta: data.delta,
    });
  } else if (
    type === "response.completed"
    || type === "response.incomplete"
    || type === "response.failed"
    || type === "response.cancelled"
  ) {
    if (!isRecord(data.response)) {
      return streamFailure("responses", "Responses terminal event must include a response object.");
    }
    current = {
      ...current,
      responseId: current.started
        ? current.responseId
        : requiredString(data.response.id, current.responseId),
      model: current.started ? current.model : requiredString(data.response.model, current.model),
    };
    current = startResponse("responses", current, events);
    if (type === "response.completed" && Object.keys(current.nativeResponseItems).some(index => !current.nativeResponseItemsDone[Number(index)])) return streamFailure("responses", "Native Responses item did not complete.");
    current = closeAllBlocks("responses", current, events);
    const normalized = responsesFinishReason(
      type,
      data.response,
      Object.keys(current.toolCalls).length > 0 || Object.values(current.nativeResponseItems).some(type => type === "tool_search_call" || type === "custom_tool_call" || type === "function_call"),
    );
    const usage = usageFromResponses(data.response.usage);
    if (usage) events.push({ ...eventBase("responses", current), type: "usage", usage });
    events.push({ ...eventBase("responses", current), type: "response_end", ...normalized });
    return finalized(current, events, {
      usage: usage ?? current.usage,
      ...normalized,
      ended: true,
    });
  } else if (
    type === "response.content_part.added"
    || type === "response.content_part.done"
    || type === "response.output_text.done"
    || type === "response.reasoning_summary_part.added"
    || type === "response.reasoning_summary_part.done"
    || type === "response.reasoning_summary_text.done"
    || type === "response.reasoning_text.done"
    || type === "response.function_call_arguments.done"
    || type === "response.refusal.delta"
    || type === "response.refusal.done"
    || type === "response.queued"
  ) {
    return finalized(current, []);
  } else if (type === "error") {
    return normalizeUpstreamStreamError("responses", current, data);
  } else {
    return streamFailure("responses", "Unsupported Responses stream event type.");
  }
  return finalized(current, events);
}

function parseGoogleEvent(
  data: unknown,
  context: StreamAdapterContext,
): ParsedStreamEvent | GatewayAdapterFailure {
  if (data === "[DONE]") {
    if (context.ended) return finalized(context, []);
    const events: IrStreamEvent[] = [];
    let current = startResponse("google-generate-content", context, events);
    current = closeAllBlocks("google-generate-content", current, events);
    const normalized = current.finishObserved
      ? {
          finishReason: current.finishReason,
          ...(current.rawFinishReason ? { rawFinishReason: current.rawFinishReason } : {}),
        }
      : { finishReason: "stop" as const, rawFinishReason: "STOP" };
    events.push({
      ...eventBase("google-generate-content", current),
      type: "response_end",
      ...normalized,
    });
    return finalized(current, events, { ...normalized, ended: true, finishObserved: true });
  }
  if (context.ended) {
    return streamFailure("google-generate-content", "Stream data followed its terminal event.");
  }
  if (!isRecord(data)) {
    return streamFailure("google-generate-content", "Google stream data must be an object.");
  }
  if (isRecord(data.error)) {
    return normalizeUpstreamStreamError("google-generate-content", context);
  }

  const responseId = context.started
    ? context.responseId
    : requiredString(data.responseId, context.responseId);
  const model = context.started
    ? context.model
    : requiredString(data.modelVersion, context.model);
  const events: IrStreamEvent[] = [];
  let current = startResponse(
    "google-generate-content",
    { ...context, responseId, model },
    events,
  );
  let finishObserved = current.finishObserved;
  let normalized = {
    finishReason: current.finishReason,
    ...(current.rawFinishReason ? { rawFinishReason: current.rawFinishReason } : {}),
  };
  const toolCalls = { ...current.toolCalls };

  if (Array.isArray(data.candidates)) {
    for (const [candidatePosition, candidateValue] of data.candidates.entries()) {
      if (!isRecord(candidateValue)) continue;
      const candidateIndex = optionalInteger(candidateValue.index) ?? candidatePosition;
      const content = isRecord(candidateValue.content) ? candidateValue.content : undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      for (const [partIndex, partValue] of parts.entries()) {
        if (!isRecord(partValue)) continue;
        const sourceIndex = candidateIndex * 10_000 + partIndex;
        if (typeof partValue.text === "string" && partValue.text.length > 0) {
          const kind = partValue.thought === true ? "reasoning" as const : "text" as const;
          const located = sourceBlockIndex(
            current,
            `candidate:${candidateIndex}:${kind}:${partIndex}`,
            sourceIndex,
          );
          current = openContentBlock(
            "google-generate-content",
            located.context,
            events,
            located.index,
            kind,
            kind === "reasoning"
              ? {
                  type: "reasoning",
                  text: "",
                  ...(typeof partValue.thoughtSignature === "string"
                    ? { signature: partValue.thoughtSignature }
                    : {}),
                }
              : { type: "text", text: "" },
          );
          events.push({
            ...eventBase("google-generate-content", current),
            type: kind === "reasoning" ? "reasoning_delta" : "text_delta",
            index: located.index,
            delta: partValue.text,
          });
        } else if (
          isRecord(partValue.functionCall)
          && typeof partValue.functionCall.name === "string"
        ) {
          const located = sourceBlockIndex(
            current,
            `candidate:${candidateIndex}:tool:${partIndex}`,
            sourceIndex,
          );
          current = located.context;
          const args = asJsonObject(partValue.functionCall.args) ?? {};
          const callId = requiredString(
            partValue.functionCall.id,
            stableGatewayId(
              "call",
              current.requestId,
              String(candidateIndex),
              String(partIndex),
              partValue.functionCall.name,
            ),
          );
          const googleMetadata: JsonObject = {};
          if (typeof partValue.thoughtSignature === "string") {
            googleMetadata.thoughtSignature = partValue.thoughtSignature;
          }
          const tool: StreamToolCall = {
            callId,
            index: located.index,
            name: partValue.functionCall.name,
            ...(Object.keys(googleMetadata).length > 0
              ? { providerMetadata: { google: googleMetadata } }
              : {}),
          };
          toolCalls[sourceIndex] = tool;
          current = openToolBlock("google-generate-content", current, events, tool);
          events.push({
            ...eventBase("google-generate-content", current),
            type: "tool_arguments_delta",
            index: tool.index,
            callId,
            delta: JSON.stringify(args),
          });
          current = closeBlock("google-generate-content", current, events, tool.index);
        }
      }
      if (typeof candidateValue.finishReason === "string") {
        const next = normalizeFinishReason(
          "google-generate-content",
          candidateValue.finishReason,
          Object.keys(toolCalls).length > 0,
        );
        if (
          finishObserved
          && (
            next.finishReason !== normalized.finishReason
            || next.rawFinishReason !== normalized.rawFinishReason
          )
        ) {
          return streamFailure(
            "google-generate-content",
            "Google stream repeated a conflicting finish reason.",
          );
        }
        finishObserved = true;
        normalized = next;
      }
    }
  }
  current = { ...current, toolCalls };
  const usage = usageFromGoogle(data.usageMetadata);
  if (usage) {
    events.push({
      ...eventBase("google-generate-content", current),
      type: "usage",
      usage,
    });
  }
  if (isRecord(data.promptFeedback) && data.promptFeedback.blockReason && !finishObserved) {
    finishObserved = true;
    normalized = {
      finishReason: "content_filter",
      rawFinishReason: String(data.promptFeedback.blockReason),
    };
  }
  if (finishObserved && data.usageMetadata !== undefined) {
    current = closeAllBlocks("google-generate-content", current, events);
    events.push({
      ...eventBase("google-generate-content", current),
      type: "response_end",
      ...normalized,
    });
    return finalized(current, events, {
      usage: usage ?? current.usage,
      ...normalized,
      finishObserved: true,
      ended: true,
    });
  }
  return finalized(current, events, {
    usage: usage ?? current.usage,
    ...normalized,
    finishObserved,
  });
}

export function parsePublicStreamEvent(
  format: GatewayApiFormat,
  event: PublicStreamEvent,
  context: StreamAdapterContext,
): ParsedStreamEvent | GatewayAdapterFailure {
  if (format === "chat-completions") return parseChatEvent(event.data, context);
  if (format === "messages") return parseMessagesEvent(event.event, event.data, context);
  if (format === "responses") return parseResponsesEvent(event.event, event.data, context);
  return parseGoogleEvent(event.data, context);
}

function terminalStatus(reason: IrFinishReason): {
  event: "response.completed" | "response.incomplete" | "response.failed" | "response.cancelled";
  status: "completed" | "incomplete" | "failed" | "cancelled";
  extra?: JsonObject;
} {
  if (reason === "length") {
    return {
      event: "response.incomplete",
      status: "incomplete",
      extra: { incomplete_details: { reason: "max_output_tokens" } },
    };
  }
  if (reason === "content_filter") {
    return {
      event: "response.incomplete",
      status: "incomplete",
      extra: { incomplete_details: { reason: "content_filter" } },
    };
  }
  if (reason === "error") {
    return {
      event: "response.failed",
      status: "failed",
      extra: { error: { code: "server_error", message: "The response failed." } },
    };
  }
  if (reason === "cancelled") return { event: "response.cancelled", status: "cancelled" };
  return { event: "response.completed", status: "completed" };
}

export function renderPublicStreamEvent(
  format: GatewayApiFormat,
  event: IrStreamEvent,
): PublicStreamEvent[] {
  if (format === "google-generate-content") {
    if (event.type === "response_start" || event.type === "content_start" || event.type === "content_end") {
      return [];
    }
    if (event.type === "text_delta") {
      return [{
        data: {
          candidates: [{
            index: 0,
            content: { role: "model", parts: [{ text: event.delta }] },
          }],
          responseId: event.responseId,
          modelVersion: event.model,
        },
      }];
    }
    if (event.type === "reasoning_delta") {
      return [{
        data: {
          candidates: [{
            index: 0,
            content: {
              role: "model",
              parts: [{ text: event.delta, thought: true }],
            },
          }],
          responseId: event.responseId,
          modelVersion: event.model,
        },
      }];
    }
    if (event.type === "usage") {
      return [{ data: { usageMetadata: usageToGoogle(event.usage) } }];
    }
    if (event.type === "response_end") {
      return [{
        data: {
          candidates: [{
            index: 0,
            finishReason:
              finishReasonForFormat(FORMAT_GOOGLE, event.finishReason, event.rawFinishReason)
              ?? "OTHER",
          }],
          responseId: event.responseId,
          modelVersion: event.model,
        },
      }];
    }
    if (event.type === "error") {
      return [{
        data: {
          error: {
            code: event.error.status,
            status: "INTERNAL",
            message: event.error.message,
            details: [{
              "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
              reason: event.error.code,
            }],
          },
        },
      }];
    }
    return [];
  }
  if (format === "chat-completions") {
    if (event.type === "content_start" || event.type === "content_end") return [];
    if (event.type === "error") {
      return [{
        data: {
          error: {
            type: "server_error",
            code: event.error.code,
            message: event.error.message,
          },
        },
      }];
    }
    const base = {
      id: event.responseId,
      object: "chat.completion.chunk",
      model: event.model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    } as JsonObject;
    const choice = (base.choices as JsonObject[])[0];
    const delta = choice.delta as JsonObject;
    if (event.type === "response_start") delta.role = "assistant";
    else if (event.type === "text_delta") delta.content = event.delta;
    else if (event.type === "reasoning_delta") delta.reasoning_content = event.delta;
    else if (event.type === "tool_call_start") {
      delta.tool_calls = [{
        index: event.index,
        id: event.callId,
        type: "function",
        function: { name: event.name, arguments: "" },
        ...(event.providerMetadata ? { extra_content: event.providerMetadata } : {}),
      }];
    } else if (event.type === "tool_arguments_delta") {
      delta.tool_calls = [{ index: event.index, function: { arguments: event.delta } }];
    } else if (event.type === "usage") {
      base.choices = [];
      base.usage = usageToChat(event.usage);
    } else if (event.type === "response_end") {
      choice.finish_reason = finishReasonForFormat(
        "chat-completions",
        event.finishReason,
        event.rawFinishReason,
      ) ?? event.finishReason;
    } else {
      return [];
    }
    return [{ data: base }];
  }

  if (format === "messages") {
    if (event.type === "response_start") {
      return [{
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: event.responseId,
            type: "message",
            role: "assistant",
            model: event.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      }];
    }
    if (event.type === "content_start") {
      return [{
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: event.index,
          content_block: event.block.type === "reasoning"
            ? { type: "thinking", thinking: "", signature: event.block.signature ?? "" }
            : { type: "text", text: "" },
        },
      }];
    }
    if (event.type === "text_delta") {
      return [{
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "text_delta", text: event.delta },
        },
      }];
    }
    if (event.type === "reasoning_delta") {
      return [{
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "thinking_delta", thinking: event.delta },
        },
      }];
    }
    if (event.type === "tool_call_start") {
      return [{
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: event.index,
          content_block: {
            type: "tool_use",
            id: event.callId,
            name: event.name,
            input: {},
            ...(event.providerMetadata ? { extra_content: event.providerMetadata } : {}),
          },
        },
      }];
    }
    if (event.type === "tool_arguments_delta") {
      return [{
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        },
      }];
    }
    if (event.type === "content_end") {
      return [{
        event: "content_block_stop",
        data: { type: "content_block_stop", index: event.index },
      }];
    }
    if (event.type === "usage") {
      return [{
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: null },
          usage: usageToMessages(event.usage),
        },
      }];
    }
    if (event.type === "response_end") {
      const stopReason = finishReasonForFormat(
        "messages",
        event.finishReason,
        event.rawFinishReason,
      );
      return [
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 0 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ];
    }
    if (event.type === "error") {
      return [{
        event: "error",
        data: {
          type: "error",
          error: {
            type: event.error.status === 400 ? "invalid_request_error" : "api_error",
            code: event.error.code,
            message: event.error.message,
          },
        },
      }];
    }
    return [];
  }

  if (event.type === "response_start") {
    return [{
      event: "response.created",
      data: {
        type: "response.created",
        response: {
          id: event.responseId,
          object: "response",
          status: "in_progress",
          model: event.model,
          output: [],
        },
      },
    }];
  }
  if (event.type === "content_start") {
    const itemId = event.block.id ?? stableGatewayId("item", event.responseId, String(event.index));
    return [{
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: event.index,
        item: event.block.type === "reasoning"
          ? { id: itemId, type: "reasoning", summary: [] }
          : {
              id: itemId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
      },
    }];
  }
  if (event.type === "text_delta") {
    return [{
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        output_index: event.index,
        delta: event.delta,
      },
    }];
  }
  if (event.type === "reasoning_delta") {
    return [{
      event: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        output_index: event.index,
        summary_index: 0,
        delta: event.delta,
      },
    }];
  }
  if (event.type === "tool_call_start") {
    return [{
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: event.index,
        item: {
          id: event.itemId ?? stableGatewayId("fc", event.responseId, String(event.index)),
          type: "function_call",
          status: "in_progress",
          call_id: event.callId,
          name: event.name,
          arguments: "",
        },
      },
    }];
  }
  if (event.type === "tool_arguments_delta") {
    return [{
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        output_index: event.index,
        call_id: event.callId,
        delta: event.delta,
      },
    }];
  }
  if (event.type === "content_end") {
    return [{
      event: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: event.index },
    }];
  }
  if (event.type === "usage") return [];
  if (event.type === "response_end") {
    const terminal = terminalStatus(event.finishReason);
    return [{
      event: terminal.event,
      data: {
        type: terminal.event,
        response: {
          id: event.responseId,
          object: "response",
          status: terminal.status,
          model: event.model,
          output: [],
          ...(terminal.extra ?? {}),
        },
      },
    }];
  }
  if (event.type === "error") {
    return [{
      event: "error",
      data: {
        type: "error",
        code: event.error.code,
        message: event.error.message,
        param: event.error.param ?? null,
      },
    }];
  }
  return [];
}

function finalUsage(events: readonly IrStreamEvent[]): IrUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "usage") return event.usage;
  }
  return undefined;
}

const FORMAT_GOOGLE = "google-generate-content" as const;

interface GoogleTraceItem {
  kind: OpenBlockKind;
  text: string;
  callId?: string;
  name?: string;
  signature?: string;
  providerMetadata?: JsonObject;
}

function googleTrace(
  events: readonly IrStreamEvent[],
  usage: IrUsage | undefined,
): PublicStreamEvent[] {
  const rendered: PublicStreamEvent[] = [];
  const items = new Map<number, GoogleTraceItem>();
  for (const event of events) {
    if (event.type === "response_start" || event.type === "usage") continue;
    if (event.type === "content_start") {
      items.set(event.index, {
        kind: event.block.type === "reasoning" ? "reasoning" : "text",
        text: "",
        ...(event.block.type === "reasoning" && event.block.signature
          ? { signature: event.block.signature }
          : {}),
      });
      continue;
    }
    if (event.type === "tool_call_start") {
      items.set(event.index, {
        kind: "tool_call",
        text: "",
        callId: event.callId,
        name: event.name,
        ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
      });
      continue;
    }
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const item = items.get(event.index);
      if (item) item.text += event.delta;
      const google = item?.providerMetadata
        ? asJsonObject(item.providerMetadata.google)
        : undefined;
      const part: JsonObject = {
        text: event.delta,
        ...(event.type === "reasoning_delta" ? { thought: true } : {}),
        ...(item?.signature ? { thoughtSignature: item.signature } : {}),
        ...(typeof google?.thoughtSignature === "string"
          ? { thoughtSignature: google.thoughtSignature }
          : {}),
      };
      rendered.push({
        data: {
          candidates: [{
            index: 0,
            content: { role: "model", parts: [part] },
          }],
          responseId: event.responseId,
          modelVersion: event.model,
        },
      });
      if (item) item.signature = undefined;
      continue;
    }
    if (event.type === "tool_arguments_delta") {
      const item = items.get(event.index);
      if (item) item.text += event.delta;
      continue;
    }
    if (event.type === "content_end") {
      const item = items.get(event.index);
      if (!item) continue;
      if (item.kind === "tool_call") {
        let args: JsonObject | null = null;
        try {
          args = asJsonObject(JSON.parse(item.text || "{}"));
        } catch {
          args = null;
        }
        if (!args) {
          rendered.push({
            data: {
              error: {
                code: 502,
                status: "INTERNAL",
                message: "Provider tool arguments were not valid JSON.",
              },
            },
          });
        } else {
          const google = item.providerMetadata
            ? asJsonObject(item.providerMetadata.google)
            : undefined;
          rendered.push({
            data: {
              candidates: [{
                index: 0,
                content: {
                  role: "model",
                  parts: [{
                    functionCall: {
                      id: item.callId,
                      name: item.name,
                      args,
                    },
                    ...(typeof google?.thoughtSignature === "string"
                      ? { thoughtSignature: google.thoughtSignature }
                      : {}),
                  }],
                },
              }],
              responseId: event.responseId,
              modelVersion: event.model,
            },
          });
        }
      }
      items.delete(event.index);
      continue;
    }
    if (event.type === "response_end") {
      rendered.push({
        data: {
          candidates: [{
            index: 0,
            finishReason:
              finishReasonForFormat(FORMAT_GOOGLE, event.finishReason, event.rawFinishReason)
              ?? "OTHER",
          }],
          responseId: event.responseId,
          modelVersion: event.model,
          ...(usage ? { usageMetadata: usageToGoogle(usage) } : {}),
        },
      });
      continue;
    }
    if (event.type === "error") {
      rendered.push(...renderPublicStreamEvent(FORMAT_GOOGLE, event));
    }
  }
  return rendered;
}

function messagesTrace(
  events: readonly IrStreamEvent[],
  usage: IrUsage | undefined,
): PublicStreamEvent[] {
  const rendered: PublicStreamEvent[] = [];
  let started = false;
  for (const event of events) {
    if (event.type === "usage") continue;
    if (event.type === "response_start") {
      started = true;
      const nativeUsage = usage ? usageToMessages(usage) : { input_tokens: 0, output_tokens: 0 };
      rendered.push({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: event.responseId,
            type: "message",
            role: "assistant",
            model: event.model,
            content: [],
            stop_reason: null,
            usage: { ...nativeUsage, output_tokens: 0 },
          },
        },
      });
      continue;
    }
    if (!started && event.type !== "error") {
      started = true;
      rendered.push(...renderPublicStreamEvent("messages", {
        protocol: GATEWAY_IR_NAME,
        version: GATEWAY_IR_VERSION,
        sourceFormat: event.sourceFormat,
        responseId: event.responseId,
        model: event.model,
        sequence: event.sequence,
        type: "response_start",
      }));
    }
    if (event.type === "response_end") {
      if (event.finishReason === "error" || event.finishReason === "cancelled") {
        rendered.push({
          event: "error",
          data: {
            type: "error",
            error: {
              type: event.finishReason === "cancelled" ? "request_aborted" : "api_error",
              message: event.finishReason === "cancelled"
                ? "The response was cancelled."
                : "The response failed.",
            },
          },
        });
        continue;
      }
      const nativeUsage = usage ? usageToMessages(usage) : { output_tokens: 0 };
      const stopReason = event.finishReason === "content_filter"
        ? "refusal"
        : finishReasonForFormat("messages", event.finishReason, event.rawFinishReason);
      rendered.push(
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              // Upstream Responses usage commonly arrives only at the terminal.
              // The initial message_start has already left the incremental stream;
              // cumulative input/cache buckets must also reach the native client here.
              ...nativeUsage,
              output_tokens: nativeUsage.output_tokens ?? 0,
              ...(nativeUsage.reasoning_tokens !== undefined
                ? { reasoning_tokens: nativeUsage.reasoning_tokens }
                : {}),
            },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      );
      continue;
    }
    rendered.push(...renderPublicStreamEvent("messages", event));
  }
  return rendered;
}

interface ResponsesTraceItem {
  id: string;
  kind: OpenBlockKind;
  text: string;
  callId?: string;
  name?: string;
}

function responsesTrace(
  events: readonly IrStreamEvent[],
  usage: IrUsage | undefined,
): PublicStreamEvent[] {
  const rendered: PublicStreamEvent[] = [];
  const items = new Map<number, ResponsesTraceItem>();
  const completedItems = new Map<number, JsonObject>();
  for (const event of events) {
    if (event.type === "usage") continue;
    if (event.type === "responses_native_event") {
      rendered.push({ event: event.event, data: event.data });
      if (event.event === "response.output_item.done" && typeof event.data.output_index === "number") {
        const item = nativeResponseItem(event.data.item);
        if (item) completedItems.set(event.data.output_index, item);
      }
      continue;
    }
    if (event.type === "content_start") {
      const id = event.block.id ?? stableGatewayId("item", event.responseId, String(event.index));
      const kind = event.block.type === "reasoning" ? "reasoning" : "text";
      items.set(event.index, { id, kind, text: "" });
      rendered.push(...renderPublicStreamEvent("responses", event));
      if (kind === "text") {
        rendered.push({
          event: "response.content_part.added",
          data: {
            type: "response.content_part.added",
            item_id: id,
            output_index: event.index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
        });
      } else {
        rendered.push({
          event: "response.reasoning_summary_part.added",
          data: {
            type: "response.reasoning_summary_part.added",
            item_id: id,
            output_index: event.index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          },
        });
      }
      continue;
    }
    if (event.type === "tool_call_start") {
      const id = event.itemId ?? stableGatewayId("fc", event.responseId, String(event.index));
      items.set(event.index, {
        id,
        kind: "tool_call",
        text: "",
        callId: event.callId,
        name: event.name,
      });
      rendered.push(...renderPublicStreamEvent("responses", event));
      continue;
    }
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const item = items.get(event.index);
      if (item) item.text += event.delta;
      const publicEvent = renderPublicStreamEvent("responses", event)[0];
      if (publicEvent && isRecord(publicEvent.data) && item) {
        publicEvent.data.item_id = item.id;
        if (event.type === "text_delta") publicEvent.data.content_index = 0;
      }
      if (publicEvent) rendered.push(publicEvent);
      continue;
    }
    if (event.type === "tool_arguments_delta") {
      const item = items.get(event.index);
      if (item) item.text += event.delta;
      const publicEvent = renderPublicStreamEvent("responses", event)[0];
      if (publicEvent && isRecord(publicEvent.data) && item) publicEvent.data.item_id = item.id;
      if (publicEvent) rendered.push(publicEvent);
      continue;
    }
    if (event.type === "content_end") {
      const item = items.get(event.index);
      if (!item) continue;
      if (item.kind === "text") {
        const part = { type: "output_text", text: item.text, annotations: [] };
        const completedItem: JsonObject = {
          id: item.id,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [part],
        };
        completedItems.set(event.index, completedItem);
        rendered.push(
          {
            event: "response.output_text.done",
            data: {
              type: "response.output_text.done",
              item_id: item.id,
              output_index: event.index,
              content_index: 0,
              text: item.text,
            },
          },
          {
            event: "response.content_part.done",
            data: {
              type: "response.content_part.done",
              item_id: item.id,
              output_index: event.index,
              content_index: 0,
              part,
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: event.index,
              item: completedItem,
            },
          },
        );
      } else if (item.kind === "reasoning") {
        const part = { type: "summary_text", text: item.text };
        const completedItem: JsonObject = {
          id: item.id,
          type: "reasoning",
          summary: [part],
        };
        completedItems.set(event.index, completedItem);
        rendered.push(
          {
            event: "response.reasoning_summary_text.done",
            data: {
              type: "response.reasoning_summary_text.done",
              item_id: item.id,
              output_index: event.index,
              summary_index: 0,
              text: item.text,
            },
          },
          {
            event: "response.reasoning_summary_part.done",
            data: {
              type: "response.reasoning_summary_part.done",
              item_id: item.id,
              output_index: event.index,
              summary_index: 0,
              part,
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: event.index,
              item: completedItem,
            },
          },
        );
      } else {
        const completedItem: JsonObject = {
          id: item.id,
          type: "function_call",
          status: "completed",
          call_id: item.callId ?? "call",
          name: item.name ?? "tool",
          arguments: item.text,
        };
        completedItems.set(event.index, completedItem);
        rendered.push(
          {
            event: "response.function_call_arguments.done",
            data: {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: event.index,
              call_id: item.callId,
              arguments: item.text,
            },
          },
          {
            event: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              output_index: event.index,
              item: completedItem,
            },
          },
        );
      }
      items.delete(event.index);
      continue;
    }
    if (event.type === "response_end") {
      const terminal = terminalStatus(event.finishReason);
      rendered.push({
        event: terminal.event,
        data: {
          type: terminal.event,
          response: {
            id: event.responseId,
            object: "response",
            status: terminal.status,
            model: event.model,
            output: [...completedItems.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, item]) => item),
            ...(usage ? { usage: usageToResponses(usage) } : {}),
            ...(terminal.extra ?? {}),
          },
        },
      });
      continue;
    }
    rendered.push(...renderPublicStreamEvent("responses", event));
  }
  return rendered;
}

/** Renders a complete IR trace while preserving target-native lifecycle and usage placement. */
export function renderPublicStreamTrace(
  format: GatewayApiFormat,
  events: readonly IrStreamEvent[],
): PublicStreamEvent[] {
  const usage = finalUsage(events);
  if (format === "messages") return messagesTrace(events, usage);
  if (format === "responses") return responsesTrace(events, usage);
  if (format === "google-generate-content") return googleTrace(events, usage);

  const rendered: PublicStreamEvent[] = [];
  let pendingUsage: IrStreamEvent | undefined;
  for (const event of events) {
    if (event.type === "usage") {
      pendingUsage = event;
      continue;
    }
    if (event.type === "response_end") {
      if (pendingUsage) rendered.push(...renderPublicStreamEvent(format, pendingUsage));
      pendingUsage = undefined;
      if (event.finishReason === "error" || event.finishReason === "cancelled") {
        rendered.push({
          data: {
            error: {
              type: event.finishReason === "cancelled" ? "request_aborted" : "server_error",
              code: event.finishReason === "cancelled" ? "request_cancelled" : "upstream_error",
              message: event.finishReason === "cancelled"
                ? "The response was cancelled."
                : "The response failed.",
            },
          },
        });
      } else {
        rendered.push(...renderPublicStreamEvent(format, event));
      }
      rendered.push({ data: "[DONE]" });
      continue;
    }
    rendered.push(...renderPublicStreamEvent(format, event));
  }
  if (pendingUsage) rendered.push(...renderPublicStreamEvent(format, pendingUsage));
  return rendered;
}
