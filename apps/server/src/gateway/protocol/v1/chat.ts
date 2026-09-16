import type { GatewayAdapterMode } from "./schemas";
import {
  GATEWAY_IR_NAME,
  GATEWAY_IR_VERSION,
  type GatewayAdapterResult,
  type IrCompatibilityFinding,
  type IrContentBlock,
  type IrRequest,
  type IrResponse,
  type IrTool,
  type IrTurn,
  type JsonObject,
  irRequestSchema,
  irResponseSchema,
} from "./schemas";
import {
  asJsonObject,
  asJsonValue,
  collectExtensions,
  completeAdapter,
  emitExtensions,
  finding,
  invalidPayloadFailure,
  isRecord,
  optionalBoolean,
  optionalInteger,
  optionalNumber,
  parseJsonValue,
  stableGatewayId,
  stringifyJsonValue,
  zodIssues,
} from "./common";
import {
  chatCompletionsRequestSchema,
  chatCompletionsResponseSchema,
} from "./public-schemas";
import {
  finishReasonForFormat,
  normalizeFinishReason,
  parseToolChoice,
  responseStatusForFinishReason,
  usageFromChat,
  usageToChat,
} from "./normalize";

const FORMAT = "chat-completions" as const;
const MODELED_REQUEST_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "n",
  "logprobs",
  "top_logprobs",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "response_format",
  "stop",
]);
const PRESERVED_REQUEST_KEYS = new Set([
  "logit_bias",
  "metadata",
  "service_tier",
  "stop",
  "stream_options",
  "top_logprobs",
  "user",
]);
const MODELED_RESPONSE_KEYS = new Set(["id", "object", "created", "model", "choices", "usage"]);
const PRESERVED_RESPONSE_KEYS = new Set(["provider", "service_tier", "system_fingerprint"]);

function cacheControl(value: unknown): { type: "ephemeral"; ttl?: string } | undefined {
  if (!isRecord(value) || value.type !== "ephemeral") return undefined;
  return {
    type: "ephemeral",
    ...(typeof value.ttl === "string" ? { ttl: value.ttl } : {}),
  };
}

function chatContentBlocks(
  value: unknown,
  path: string,
  findings: IrCompatibilityFinding[],
): IrContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding(FORMAT, path, "unsupported", "pointer_content_shape_unsupported", "Chat content must be a string, null, or an ordered block array."));
    return [];
  }
  const blocks: IrContentBlock[] = [];
  for (const [index, raw] of value.entries()) {
    const blockPath = `${path}.${index}`;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_invalid", "Chat content blocks require a string type discriminator."));
      continue;
    }
    if (raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") {
      if (typeof raw.text !== "string") {
        findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_text_block_invalid", "Text blocks require text."));
        continue;
      }
      blocks.push({
        type: "text",
        text: raw.text,
        ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
      });
      continue;
    }
    if (raw.type === "image_url") {
      const image = isRecord(raw.image_url) ? raw.image_url : undefined;
      if (typeof image?.url !== "string") {
        findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_image_block_invalid", "image_url blocks require image_url.url."));
        continue;
      }
      const data = image.url.match(/^data:([^;]+);base64,(.*)$/s);
      blocks.push({
        type: "image",
        source: data
          ? { type: "base64", mediaType: data[1], data: data[2] }
          : { type: "url", url: image.url },
        ...(image.detail === "auto" || image.detail === "low" || image.detail === "high"
          ? { detail: image.detail }
          : {}),
      });
      continue;
    }
    if (raw.type === "input_audio" && isRecord(raw.input_audio) && typeof raw.input_audio.data === "string" && typeof raw.input_audio.format === "string") {
      blocks.push({ type: "audio", data: raw.input_audio.data, format: raw.input_audio.format });
      continue;
    }
    if (raw.type === "file") {
      blocks.push({
        type: "file",
        ...(typeof raw.file_id === "string" ? { fileId: raw.file_id } : {}),
        ...(typeof raw.filename === "string" ? { filename: raw.filename } : {}),
        ...(typeof raw.file_data === "string" ? { data: raw.file_data } : {}),
      });
      continue;
    }
    if (raw.type === "refusal" && typeof raw.refusal === "string") {
      blocks.push({ type: "refusal", text: raw.refusal });
      continue;
    }
    findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_unsupported", `Chat content block ${raw.type} is not supported.`));
  }
  return blocks;
}

function chatToolCalls(
  value: unknown,
  path: string,
  findings: IrCompatibilityFinding[],
  messageReasoningDetails?: unknown,
): IrContentBlock[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    findings.push(finding(FORMAT, path, "unsupported", "pointer_tool_calls_invalid", "tool_calls must be an array."));
    return [];
  }
  return value.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const fn = isRecord(raw.function) ? raw.function : undefined;
    if (typeof fn?.name !== "string") {
      findings.push(finding(FORMAT, `${path}.${index}`, "unsupported", "pointer_tool_call_invalid", "Function tool calls require function.name."));
      return [];
    }
    const rawArguments = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const providerMetadata = toolProviderMetadata(raw.extra_content, messageReasoningDetails);
    return [{
      type: "tool_call" as const,
      id: typeof raw.id === "string" ? raw.id : stableGatewayId("call", path, String(index), fn.name, rawArguments),
      name: fn.name,
      arguments: parseJsonValue(rawArguments),
      rawArguments,
      ...(providerMetadata ? { providerMetadata } : {}),
    }];
  });
}

function reasoningDetails(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details = value.map(asJsonObject);
  if (details.some((detail) => detail === null)) return undefined;
  return details as JsonObject[];
}

function toolProviderMetadata(
  extraContent: unknown,
  messageReasoningDetails: unknown,
): JsonObject | undefined {
  const metadata = asJsonObject(extraContent) ?? {};
  const details = reasoningDetails(messageReasoningDetails);
  if (details) {
    const openRouter = asJsonObject(metadata.openrouter) ?? {};
    metadata.openrouter = { ...openRouter, reasoning_details: details };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function metadataReasoningDetails(metadata: JsonObject | undefined): JsonObject[] | undefined {
  const openRouter = asJsonObject(metadata?.openrouter);
  return reasoningDetails(openRouter?.reasoning_details);
}

function metadataToolExtraContent(metadata: JsonObject | undefined): JsonObject | undefined {
  if (!metadata) return undefined;
  const extraContent = { ...metadata };
  const openRouter = asJsonObject(extraContent.openrouter);
  if (openRouter && Object.hasOwn(openRouter, "reasoning_details")) {
    const remainingOpenRouter = { ...openRouter };
    delete remainingOpenRouter.reasoning_details;
    if (Object.keys(remainingOpenRouter).length > 0) extraContent.openrouter = remainingOpenRouter;
    else delete extraContent.openrouter;
  }
  return Object.keys(extraContent).length > 0 ? extraContent : undefined;
}

function emittedChatToolCall(
  call: Extract<IrContentBlock, { type: "tool_call" }>,
): JsonObject {
  const extraContent = metadataToolExtraContent(call.providerMetadata);
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.rawArguments ?? stringifyJsonValue(call.arguments),
    },
    ...(extraContent ? { extra_content: extraContent } : {}),
  };
}

function parseChatTools(value: unknown, findings: IrCompatibilityFinding[]): IrTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];
  const tools: IrTool[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || raw.type !== "function" || !isRecord(raw.function) || typeof raw.function.name !== "string") {
      findings.push(finding(FORMAT, `tools.${index}`, "unsupported", "pointer_tool_definition_unsupported", "Chat supports typed function tools only."));
      continue;
    }
    const parameters = asJsonObject(raw.function.parameters);
    if (raw.function.parameters !== undefined && !parameters) {
      findings.push(finding(FORMAT, `tools.${index}.function.parameters`, "unsupported", "pointer_tool_schema_invalid", "Function tool parameters must be a JSON object."));
    }
    tools.push({
      type: "function",
      name: raw.function.name,
      ...(typeof raw.function.description === "string" ? { description: raw.function.description } : {}),
      parameters: parameters ?? {},
      ...(typeof raw.function.strict === "boolean" ? { strict: raw.function.strict } : {}),
    });
  }
  return tools;
}

export function parseChatRequest(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrRequest> {
  const parsed = chatCompletionsRequestSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));

  const findings: IrCompatibilityFinding[] = [];
  const turns: IrTurn[] = [];
  for (const [index, message] of parsed.data.messages.entries()) {
    const role = message.role === "function" ? "tool" : message.role;
    const blocks = chatContentBlocks(message.content, `messages.${index}.content`, findings);
    if (message.role === "assistant" && typeof message.reasoning_content === "string") {
      blocks.unshift({ type: "reasoning", text: message.reasoning_content });
    }
    blocks.push(...chatToolCalls(
      message.role === "assistant" ? message.tool_calls : undefined,
      `messages.${index}.tool_calls`,
      findings,
      message.role === "assistant" ? message.reasoning_details : undefined,
    ));
    if (role === "tool") {
      const output = message.content === undefined || message.content === null
        ? ""
        : asJsonValue(message.content) ?? "";
      turns.push({
        role: "tool",
        blocks: [{
          type: "tool_result",
          callId: message.role === "tool"
            ? message.tool_call_id ?? stableGatewayId("call", "tool-result", String(index))
            : message.name ?? stableGatewayId("call", "tool-result", String(index)),
          output,
          isError: false,
        }],
        ...(message.name ? { name: message.name } : {}),
      });
    } else {
      turns.push({ role, blocks, ...(message.name ? { name: message.name } : {}) });
    }
  }

  const toolChoice = parseToolChoice(FORMAT, parsed.data.tool_choice);
  findings.push(...toolChoice.findings);
  const collected = collectExtensions(parsed.data, {
    sourceFormat: FORMAT,
    modeledKeys: MODELED_REQUEST_KEYS,
    preservedKeys: PRESERVED_REQUEST_KEYS,
  });
  findings.push(...collected.findings);

  const reasoningEffort = parsed.data.reasoning_effort;
  const responseFormat = parsed.data.response_format;
  const responseFormatType = responseFormat?.type;
  const jsonSchema = isRecord(responseFormat?.json_schema)
    ? responseFormat.json_schema
    : undefined;
  const allowedReasoningEffort = reasoningEffort && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(reasoningEffort)
    ? reasoningEffort
    : undefined;
  if (reasoningEffort && !allowedReasoningEffort) findings.push(finding(FORMAT, "reasoning_effort", "unsupported", "pointer_reasoning_effort_unsupported", `Unsupported reasoning effort ${reasoningEffort}.`));
  const request = irRequestSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "request",
    sourceFormat: FORMAT,
    compatibilityPolicy: mode,
    compatibility: findings,
    extensions: collected.extensions,
    model: parsed.data.model,
    stream: parsed.data.stream ?? false,
    instructions: [],
    turns,
    tools: parseChatTools(parsed.data.tools, findings),
    ...(toolChoice.choice ? { toolChoice: toolChoice.choice } : {}),
    ...(optionalBoolean(parsed.data.parallel_tool_calls) !== undefined ? { parallelToolCalls: parsed.data.parallel_tool_calls } : {}),
    ...(allowedReasoningEffort
      ? { reasoning: { enabled: allowedReasoningEffort !== "none", effort: allowedReasoningEffort } }
      : {}),
    ...(responseFormatType === "text" || responseFormatType === "json_object"
      ? { responseFormat: { type: responseFormatType } }
      : responseFormatType === "json_schema" && jsonSchema
        ? {
            responseFormat: {
              type: "json_schema",
              ...(typeof jsonSchema.name === "string" ? { name: jsonSchema.name } : {}),
              ...(jsonSchema.schema !== undefined ? { schema: jsonSchema.schema } : {}),
              ...(typeof jsonSchema.strict === "boolean" ? { strict: jsonSchema.strict } : {}),
            },
          }
        : {}),
    sampling: {
      ...(optionalNumber(parsed.data.temperature) !== undefined ? { temperature: parsed.data.temperature } : {}),
      ...(optionalNumber(parsed.data.top_p) !== undefined ? { topP: parsed.data.top_p } : {}),
      ...(optionalInteger(parsed.data.max_completion_tokens ?? parsed.data.max_tokens) !== undefined
        ? { maxOutputTokens: parsed.data.max_completion_tokens ?? parsed.data.max_tokens }
        : {}),
      ...(Array.isArray(parsed.data.stop) && parsed.data.stop.every((value) => typeof value === "string")
        ? { stopSequences: parsed.data.stop }
        : typeof parsed.data.stop === "string" ? { stopSequences: [parsed.data.stop] } : {}),
      ...(optionalInteger(parsed.data.n) !== undefined ? { candidateCount: parsed.data.n } : {}),
      ...(optionalBoolean(parsed.data.logprobs) !== undefined
        ? { responseLogprobs: parsed.data.logprobs }
        : {}),
      ...(optionalInteger(parsed.data.top_logprobs) !== undefined
        ? { logprobs: parsed.data.top_logprobs }
        : {}),
      ...(optionalNumber(parsed.data.presence_penalty) !== undefined
        ? { presencePenalty: parsed.data.presence_penalty }
        : {}),
      ...(optionalNumber(parsed.data.frequency_penalty) !== undefined
        ? { frequencyPenalty: parsed.data.frequency_penalty }
        : {}),
      ...(typeof parsed.data.seed === "number" ? { seed: parsed.data.seed } : {}),
    },
  });
  request.compatibility = [...findings].sort((left, right) => left.assessment.path.localeCompare(right.assessment.path));
  return completeAdapter(FORMAT, mode, request, findings);
}

function emitChatBlock(block: IrContentBlock): JsonObject | null {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    const url = block.source.type === "base64"
      ? `data:${block.source.mediaType};base64,${block.source.data}`
      : block.source.type === "url" ? block.source.url : undefined;
    return url ? { type: "image_url", image_url: { url, ...(block.detail ? { detail: block.detail } : {}) } } : null;
  }
  if (block.type === "audio") return { type: "input_audio", input_audio: { data: block.data, format: block.format } };
  if (block.type === "file") return { type: "file", ...(block.fileId ? { file_id: block.fileId } : {}), ...(block.filename ? { filename: block.filename } : {}), ...(block.data ? { file_data: block.data } : {}) };
  if (block.type === "refusal") return { type: "refusal", refusal: block.text };
  return null;
}

function recordDroppedChatBlock(
  block: IrContentBlock,
  path: string,
  sourceFormat: IrRequest["sourceFormat"],
  findings: IrCompatibilityFinding[],
): void {
  const detailCode = block.type === "extension"
    ? "pointer_cross_format_extension_dropped"
    : "pointer_chat_response_block_dropped";
  findings.push(finding(
    sourceFormat,
    path,
    "lossy",
    detailCode,
    `Chat Completions cannot represent ${block.type} in this message position.`,
    FORMAT,
  ));
}

function appendChatMessage(
  messages: JsonObject[],
  turn: IrTurn,
  indexedBlocks: Array<{ block: IrContentBlock; index: number }>,
  turnIndex: number,
  sourceFormat: IrRequest["sourceFormat"],
  findings: IrCompatibilityFinding[],
): void {
  const visible: JsonObject[] = [];
  const toolCalls: Array<Extract<IrContentBlock, { type: "tool_call" }>> = [];
  const reasoning: Array<{ block: Extract<IrContentBlock, { type: "reasoning" }>; index: number }> = [];

  for (const entry of indexedBlocks) {
    if (entry.block.type === "tool_call") {
      toolCalls.push(entry.block);
      continue;
    }
    if (entry.block.type === "reasoning") {
      reasoning.push({ block: entry.block, index: entry.index });
      continue;
    }
    const rendered = emitChatBlock(entry.block);
    if (rendered) visible.push(rendered);
    else recordDroppedChatBlock(
      entry.block,
      `turns.${turnIndex}.blocks.${entry.index}`,
      sourceFormat,
      findings,
    );
  }

  if (indexedBlocks.length > 0 && visible.length === 0 && toolCalls.length === 0 && reasoning.length === 0) return;
  const message: JsonObject = {
    role: turn.role === "tool" ? "user" : turn.role,
    content: visible.length === 0
      ? null
      : visible.length === 1 && visible[0].type === "text" && Object.keys(visible[0]).length === 2
        ? visible[0].text
        : visible,
  };
  if (turn.name) message.name = turn.name;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(emittedChatToolCall);
    const details = toolCalls.map((call) => metadataReasoningDetails(call.providerMetadata)).find(Boolean);
    if (details) message.reasoning_details = details;
  }
  if (reasoning.length > 0) {
    message.reasoning_content = reasoning.map(({ block }) => block.text).join("");
    for (const { block, index } of reasoning) {
      if (block.signature || block.encryptedContent) {
        findings.push(finding(
          sourceFormat,
          `turns.${turnIndex}.blocks.${index}`,
          "lossy",
          "pointer_chat_reasoning_metadata_dropped",
          "Chat reasoning_content cannot preserve reasoning signatures or encrypted content.",
          FORMAT,
        ));
      }
    }
  }
  messages.push(message);
}

function emitChatTools(
  tools: IrRequest["tools"],
  sourceFormat: IrRequest["sourceFormat"],
  findings: IrCompatibilityFinding[],
): JsonObject[] {
  return tools.flatMap<JsonObject>((tool) => {
    if (tool.type === "function") {
      if (tool.cacheControl) {
        findings.push(finding(sourceFormat, `tools.${tool.name}.cacheControl`, "lossy", "pointer_chat_cache_control_dropped", "Chat Completions does not have a portable tool-definition cache control.", FORMAT));
      }
      const value: JsonObject = {
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters,
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      };
      return [value];
    }
    findings.push(finding(sourceFormat, `tools.${tool.name}`, "lossy", "pointer_chat_builtin_tool_dropped", `Chat Completions cannot represent the Responses built-in tool ${tool.name}.`, FORMAT));
    return [];
  });
}

export function renderChatRequest(
  request: IrRequest,
  mode: GatewayAdapterMode = request.compatibilityPolicy,
  model = request.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const messages: JsonObject[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const instructionContent: JsonObject[] = [];
  for (const [index, block] of request.instructions.entries()) {
    if (block.type === "text" && block.annotations) {
      findings.push(finding(request.sourceFormat, `instructions.${index}.annotations`, "lossy", "pointer_chat_annotations_dropped", "Chat Completions cannot represent Responses text annotations.", FORMAT));
    }
    if ("cacheControl" in block && block.cacheControl) {
      findings.push(finding(request.sourceFormat, `instructions.${index}.cacheControl`, "lossy", "pointer_chat_cache_control_dropped", "Chat Completions does not have a portable content-block cache control.", FORMAT));
    }
    const rendered = emitChatBlock(block);
    if (rendered) instructionContent.push(rendered);
    else recordDroppedChatBlock(block, `instructions.${index}`, request.sourceFormat, findings);
  }
  if (instructionContent.length > 0) {
    messages.push({ role: "system", content: instructionContent });
  }
  for (const [turnIndex, turn] of request.turns.entries()) {
    for (const [blockIndex, block] of turn.blocks.entries()) {
      if (block.type === "text" && block.annotations) {
        findings.push(finding(request.sourceFormat, `turns.${turnIndex}.blocks.${blockIndex}.annotations`, "lossy", "pointer_chat_annotations_dropped", "Chat Completions cannot represent Responses text annotations.", FORMAT));
      }
      if ("cacheControl" in block && block.cacheControl) {
        findings.push(finding(request.sourceFormat, `turns.${turnIndex}.blocks.${blockIndex}.cacheControl`, "lossy", "pointer_chat_cache_control_dropped", "Chat Completions does not have a portable content-block cache control.", FORMAT));
      }
    }
    const hasToolResult = turn.blocks.some((block) => block.type === "tool_result");
    if (hasToolResult && turn.blocks.some((block) => block.type !== "tool_result")) {
      findings.push(finding(request.sourceFormat, `turns.${turnIndex}`, "lossy", "pointer_chat_tool_result_split", "Chat requires tool results to be split into dedicated messages.", FORMAT));
    }

    let pending: Array<{ block: IrContentBlock; index: number }> = [];
    const flush = () => {
      if (pending.length === 0) return;
      appendChatMessage(messages, turn, pending, turnIndex, request.sourceFormat, findings);
      pending = [];
    };
    for (const [blockIndex, block] of turn.blocks.entries()) {
      if (block.type === "tool_call") toolNamesByCallId.set(block.id, block.name);
      if (block.type === "tool_result") {
        flush();
        messages.push({
          role: "tool",
          tool_call_id: block.callId,
          ...(toolNamesByCallId.get(block.callId) ? { name: toolNamesByCallId.get(block.callId) } : {}),
          content: block.isError
            ? JSON.stringify({ error: block.output })
            : stringifyJsonValue(block.output),
        });
      } else {
        pending.push({ block, index: blockIndex });
      }
    }
    flush();
    if (turn.blocks.length === 0) appendChatMessage(messages, turn, [], turnIndex, request.sourceFormat, findings);
  }
  const extensionOutput = emitExtensions(request.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  const effectiveReasoningEffort = request.outputEffort
    ?? request.reasoning?.effort
    ?? (request.reasoning?.enabled === false ? "none" : undefined);
  const value: JsonObject = {
    ...extensionOutput.values,
    model,
    messages,
    stream: request.stream,
    ...(request.sampling.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling.topK !== undefined ? { top_k: request.sampling.topK } : {}),
    ...(request.sampling.maxOutputTokens !== undefined ? { max_tokens: request.sampling.maxOutputTokens } : {}),
    ...(request.sampling.stopSequences ? { stop: request.sampling.stopSequences } : {}),
    ...(request.sampling.candidateCount !== undefined
      ? { n: request.sampling.candidateCount }
      : {}),
    ...(request.sampling.responseLogprobs !== undefined
      ? { logprobs: request.sampling.responseLogprobs }
      : {}),
    ...(request.sampling.logprobs !== undefined
      ? { top_logprobs: request.sampling.logprobs }
      : {}),
    ...(request.sampling.presencePenalty !== undefined
      ? { presence_penalty: request.sampling.presencePenalty }
      : {}),
    ...(request.sampling.frequencyPenalty !== undefined
      ? { frequency_penalty: request.sampling.frequencyPenalty }
      : {}),
    ...(request.sampling.seed !== undefined ? { seed: request.sampling.seed } : {}),
    ...(request.responseFormat
      ? {
          response_format: request.responseFormat.type === "json_schema"
            ? {
                type: "json_schema",
                json_schema: {
                  name: request.responseFormat.name ?? "pointer_response",
                  ...(request.responseFormat.schema !== undefined
                    ? { schema: request.responseFormat.schema }
                    : {}),
                  ...(request.responseFormat.strict !== undefined
                    ? { strict: request.responseFormat.strict }
                    : {}),
                },
              }
            : { type: request.responseFormat.type },
        }
      : {}),
    ...(request.tools.length > 0 ? { tools: emitChatTools(request.tools, request.sourceFormat, findings) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice.type === "function" ? { type: "function", function: { name: request.toolChoice.name } } : request.toolChoice.type } : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(effectiveReasoningEffort ? { reasoning_effort: effectiveReasoningEffort } : {}),
  };
  if (request.reasoning?.enabled && request.reasoning.effort === undefined && request.outputEffort === undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.enabled", "lossy", "pointer_chat_reasoning_control_dropped", "Chat Completions has no portable adaptive or enabled-only reasoning control.", FORMAT));
  }
  if (request.reasoning?.budgetTokens !== undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.budgetTokens", "lossy", "pointer_chat_reasoning_metadata_dropped", "Chat Completions cannot represent a reasoning token budget.", FORMAT));
  }
  if (request.reasoning?.summary !== undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.summary", "lossy", "pointer_chat_reasoning_metadata_dropped", "Chat Completions cannot represent a reasoning summary control.", FORMAT));
  }
  return completeAdapter(FORMAT, mode, value, findings);
}

export function parseChatResponse(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrResponse> {
  const parsed = chatCompletionsResponseSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const findings: IrCompatibilityFinding[] = [];
  if (parsed.data.choices.length > 1) findings.push(finding(FORMAT, "choices", "lossy", "pointer_multiple_choices_lossy", "The IR represents one generated choice; additional Chat choices are not selected.", FORMAT));
  const choice = parsed.data.choices[0]!;
  const message = choice.message;
  const output = chatContentBlocks(message.content, "choices.0.message.content", findings);
  if (message.name !== undefined && message.name !== null) {
    findings.push(finding(FORMAT, "choices.0.message.name", "lossy", "pointer_chat_name_dropped", "Assistant name metadata is not modeled by the IR.", FORMAT));
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    findings.push(finding(FORMAT, "choices.0.logprobs", "lossy", "pointer_chat_logprobs_dropped", "Chat log probabilities are not modeled by the IR.", FORMAT));
  }
  const reasoningContent = typeof message.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message.reasoning === "string"
      ? message.reasoning
      : undefined;
  if (reasoningContent) output.unshift({ type: "reasoning", text: reasoningContent });
  if (typeof message.refusal === "string") output.push({ type: "refusal", text: message.refusal });
  output.push(...chatToolCalls(
    message.tool_calls,
    "choices.0.message.tool_calls",
    findings,
    message.reasoning_details,
  ));
  const usage = parsed.data.usage;
  if (usage) {
    const knownUsageKeys = new Set(["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"]);
    const knownPromptDetailKeys = new Set(["cached_tokens"]);
    const knownCompletionDetailKeys = new Set(["reasoning_tokens"]);
    for (const key of Object.keys(usage)) {
      if (!knownUsageKeys.has(key)) findings.push(finding(FORMAT, "usage.provider_detail", "lossy", "pointer_chat_usage_detail_dropped", "Chat usage contains a provider-specific field that is not modeled by the IR.", FORMAT));
    }
    for (const key of Object.keys(usage.prompt_tokens_details ?? {})) {
      if (!knownPromptDetailKeys.has(key)) findings.push(finding(FORMAT, "usage.prompt_tokens_details.provider_detail", "lossy", "pointer_chat_usage_detail_dropped", "Chat prompt usage contains a provider-specific field that is not modeled by the IR.", FORMAT));
    }
    for (const key of Object.keys(usage.completion_tokens_details ?? {})) {
      if (!knownCompletionDetailKeys.has(key)) findings.push(finding(FORMAT, "usage.completion_tokens_details.provider_detail", "lossy", "pointer_chat_usage_detail_dropped", "Chat completion usage contains a provider-specific field that is not modeled by the IR.", FORMAT));
    }
  }
  const normalized = normalizeFinishReason(FORMAT, choice.finish_reason, output.some((block) => block.type === "tool_call"));
  const collected = collectExtensions(parsed.data, {
    sourceFormat: FORMAT,
    modeledKeys: MODELED_RESPONSE_KEYS,
    preservedKeys: PRESERVED_RESPONSE_KEYS,
  });
  findings.push(...collected.findings);
  const response = irResponseSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "response",
    sourceFormat: FORMAT,
    compatibilityPolicy: mode,
    compatibility: findings,
    extensions: collected.extensions,
    id: parsed.data.id,
    model: parsed.data.model,
    ...(optionalInteger(parsed.data.created) !== undefined ? { createdAt: parsed.data.created } : {}),
    status: responseStatusForFinishReason(normalized.finishReason),
    output,
    ...normalized,
    ...(usageFromChat(parsed.data.usage) ? { usage: usageFromChat(parsed.data.usage) } : {}),
  });
  return completeAdapter(FORMAT, mode, response, findings);
}

export function renderChatResponse(
  response: IrResponse,
  mode: GatewayAdapterMode = response.compatibilityPolicy,
  model = response.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const text = response.output.filter((block) => block.type === "text").map((block) => block.text).join("");
  const reasoning = response.output.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
  const toolCalls = response.output.filter((block) => block.type === "tool_call");
  const unsupported = response.output.filter((block) => !["text", "reasoning", "tool_call"].includes(block.type));
  for (const [index] of unsupported.entries()) findings.push(finding(response.sourceFormat, `output.${index}`, "lossy", "pointer_chat_response_block_dropped", "This response block has no Chat Completions response representation.", FORMAT));
  const message: JsonObject = {
    role: "assistant",
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(emittedChatToolCall) } : {}),
  };
  const details = toolCalls.map((call) => metadataReasoningDetails(call.providerMetadata)).find(Boolean);
  if (details) message.reasoning_details = details;
  for (const [index, block] of response.output.entries()) {
    const itemId = block.type === "tool_call" ? block.itemId : block.id;
    if (itemId) {
      findings.push(finding(response.sourceFormat, `output.${index}.id`, "lossy", "pointer_chat_output_item_id_dropped", "Chat Completions has no per-content output item ID.", FORMAT));
    }
    if (block.type === "reasoning" && (block.signature || block.encryptedContent)) {
      findings.push(finding(response.sourceFormat, `output.${index}`, "lossy", "pointer_chat_reasoning_metadata_dropped", "Chat reasoning_content cannot preserve reasoning signatures or encrypted content.", FORMAT));
    }
    if (block.type === "text" && block.annotations) {
      findings.push(finding(response.sourceFormat, `output.${index}.annotations`, "lossy", "pointer_chat_annotations_dropped", "Chat Completions cannot represent Responses text annotations.", FORMAT));
    }
  }
  if (response.usage?.cacheCreationInputTokens !== undefined) {
    findings.push(finding(response.sourceFormat, "usage.cacheCreationInputTokens", "lossy", "pointer_chat_cache_creation_usage_dropped", "Chat usage has no cache-creation token field.", FORMAT));
  }
  const extensionOutput = emitExtensions(response.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  const value: JsonObject = {
    ...extensionOutput.values,
    id: response.id,
    object: "chat.completion",
    ...(response.createdAt !== undefined ? { created: response.createdAt } : {}),
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonForFormat(FORMAT, response.finishReason, response.rawFinishReason) }],
    ...(response.usage ? { usage: usageToChat(response.usage) } : {}),
  };
  return completeAdapter(FORMAT, mode, value, findings);
}
