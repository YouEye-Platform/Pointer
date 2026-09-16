import {
  GATEWAY_IR_NAME,
  GATEWAY_IR_VERSION,
  type GatewayAdapterMode,
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
  stableGatewayId,
  stringifyJsonValue,
  zodIssues,
} from "./common";
import { messagesRequestSchema, messagesResponseSchema } from "./public-schemas";
import {
  finishReasonForFormat,
  normalizeFinishReason,
  parseToolChoice,
  responseStatusForFinishReason,
  usageFromMessages,
  usageToMessages,
} from "./normalize";

const FORMAT = "messages" as const;
const MODELED_REQUEST_KEYS = new Set([
  "model",
  "system",
  "messages",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "thinking",
]);
const PRESERVED_REQUEST_KEYS = new Set([
  "anthropic-beta",
  "anthropic-version",
  "cache_control",
  "context_management",
  "mcp_servers",
  "metadata",
  "output_config",
  "service_tier",
]);
const MODELED_RESPONSE_KEYS = new Set([
  "id",
  "type",
  "role",
  "model",
  "content",
  "stop_reason",
  "usage",
]);
const PRESERVED_RESPONSE_KEYS = new Set(["container", "stop_sequence"]);

function cacheControl(value: unknown): { type: "ephemeral"; ttl?: string } | undefined {
  if (!isRecord(value) || value.type !== "ephemeral") return undefined;
  return { type: "ephemeral", ...(typeof value.ttl === "string" ? { ttl: value.ttl } : {}) };
}

function messageBlocks(
  value: unknown,
  path: string,
  findings: IrCompatibilityFinding[],
): IrContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    findings.push(finding(FORMAT, path, "unsupported", "pointer_content_shape_unsupported", "Messages content must be a string or an ordered block array."));
    return [];
  }
  const blocks: IrContentBlock[] = [];
  for (const [index, raw] of value.entries()) {
    const blockPath = `${path}.${index}`;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_invalid", "Messages content blocks require a string type discriminator."));
      continue;
    }
    if (raw.type === "text" && typeof raw.text === "string") {
      blocks.push({ type: "text", text: raw.text, ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}) });
      continue;
    }
    if (raw.type === "image" && isRecord(raw.source)) {
      if (raw.source.type === "base64" && typeof raw.source.media_type === "string" && typeof raw.source.data === "string") {
        blocks.push({
          type: "image",
          source: { type: "base64", mediaType: raw.source.media_type, data: raw.source.data },
          ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
        });
        continue;
      }
      if (raw.source.type === "url" && typeof raw.source.url === "string") {
        blocks.push({
          type: "image",
          source: { type: "url", url: raw.source.url },
          ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
        });
        continue;
      }
    }
    if (raw.type === "tool_use" && typeof raw.name === "string") {
      const id = typeof raw.id === "string" ? raw.id : stableGatewayId("call", path, String(index), raw.name);
      const input = raw.input === undefined ? {} : asJsonValue(raw.input) ?? {};
      const providerMetadata = asJsonObject(raw.extra_content);
      blocks.push({
        type: "tool_call",
        id,
        name: raw.name,
        arguments: input,
        ...(typeof raw.input === "string" ? { rawArguments: raw.input } : {}),
        ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
      });
      continue;
    }
    if (raw.type === "tool_result" && typeof raw.tool_use_id === "string") {
      const output = raw.content === undefined ? "" : asJsonValue(raw.content) ?? "";
      blocks.push({
        type: "tool_result",
        callId: raw.tool_use_id,
        output,
        isError: raw.is_error === true,
        ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
      });
      continue;
    }
    if (raw.type === "thinking" && typeof raw.thinking === "string") {
      blocks.push({ type: "reasoning", text: raw.thinking, ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}) });
      continue;
    }
    if (raw.type === "redacted_thinking" && typeof raw.data === "string") {
      blocks.push({ type: "reasoning", text: "", encryptedContent: raw.data });
      continue;
    }
    findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_unsupported", `Messages content block ${raw.type} is not supported.`));
  }
  return blocks;
}

function parseTools(value: unknown, findings: IrCompatibilityFinding[]): IrTool[] {
  if (!Array.isArray(value)) return [];
  const tools: IrTool[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      findings.push(finding(FORMAT, `tools.${index}`, "unsupported", "pointer_tool_definition_invalid", "Messages tool definitions require name."));
      continue;
    }
    const parameters = asJsonObject(raw.input_schema);
    if (!parameters) {
      findings.push(finding(FORMAT, `tools.${index}.input_schema`, "unsupported", "pointer_tool_schema_invalid", "Messages tool input_schema must be a JSON object."));
    }
    tools.push({
      type: "function",
      name: raw.name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      parameters: parameters ?? {},
      ...(typeof raw.strict === "boolean" ? { strict: raw.strict } : {}),
      ...(cacheControl(raw.cache_control) ? { cacheControl: cacheControl(raw.cache_control) } : {}),
    });
  }
  return tools;
}

function parseSystem(value: unknown, findings: IrCompatibilityFinding[]): IrContentBlock[] {
  if (value === undefined) return [];
  return messageBlocks(value, "system", findings);
}

export function parseMessagesRequest(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrRequest> {
  const parsed = messagesRequestSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const findings: IrCompatibilityFinding[] = [];
  const turns: IrTurn[] = parsed.data.messages.map((message, index) => ({
    role: message.role,
    blocks: messageBlocks(message.content, `messages.${index}.content`, findings),
  }));
  const toolChoice = parseToolChoice(FORMAT, parsed.data.tool_choice);
  findings.push(...toolChoice.findings);
  const collected = collectExtensions(parsed.data, {
    sourceFormat: FORMAT,
    modeledKeys: MODELED_REQUEST_KEYS,
    preservedKeys: PRESERVED_REQUEST_KEYS,
  });
  findings.push(...collected.findings);
  const thinking = isRecord(parsed.data.thinking) ? parsed.data.thinking : undefined;
  const outputConfig = isRecord(input) && isRecord(input.output_config) ? input.output_config : undefined;
  const rawOutputEffort = typeof outputConfig?.effort === "string" ? outputConfig.effort : undefined;
  const outputEffort = rawOutputEffort && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(rawOutputEffort)
    ? rawOutputEffort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    : undefined;
  for (const key of Object.keys(thinking ?? {})) {
    if (key !== "type" && key !== "budget_tokens") {
      findings.push(finding(FORMAT, `thinking.${key}`, "unsupported", "pointer_reasoning_control_unknown", "Messages thinking contains an unsupported control."));
    }
  }
  if (thinking && thinking.type !== "enabled" && thinking.type !== "disabled" && thinking.type !== "adaptive") {
    findings.push(finding(FORMAT, "thinking.type", "unsupported", "pointer_reasoning_control_unsupported", "Messages thinking.type must be enabled, disabled, or adaptive."));
  }
  if (thinking?.budget_tokens !== undefined && optionalInteger(thinking.budget_tokens) === undefined) {
    findings.push(finding(FORMAT, "thinking.budget_tokens", "unsupported", "pointer_reasoning_budget_invalid", "Messages thinking.budget_tokens must be a non-negative integer."));
  }
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
    instructions: parseSystem(parsed.data.system, findings),
    turns,
    tools: parseTools(parsed.data.tools, findings),
    ...(toolChoice.choice ? { toolChoice: toolChoice.choice } : {}),
    ...(isRecord(parsed.data.tool_choice) && optionalBoolean(parsed.data.tool_choice.disable_parallel_tool_use) !== undefined
      ? { parallelToolCalls: !parsed.data.tool_choice.disable_parallel_tool_use }
      : {}),
    ...(thinking ? {
      reasoning: {
        enabled: thinking.type !== "disabled",
        ...(thinking.type === "adaptive" ? { adaptive: true } : {}),
        ...(optionalInteger(thinking.budget_tokens) !== undefined ? { budgetTokens: thinking.budget_tokens } : {}),
      },
    } : {}),
    ...(outputEffort ? { outputEffort } : {}),
    sampling: {
      maxOutputTokens: parsed.data.max_tokens,
      ...(optionalNumber(parsed.data.temperature) !== undefined ? { temperature: parsed.data.temperature } : {}),
      ...(optionalNumber(parsed.data.top_p) !== undefined ? { topP: parsed.data.top_p } : {}),
      ...(typeof parsed.data.top_k === "number" ? { topK: parsed.data.top_k } : {}),
      ...(parsed.data.stop_sequences ? { stopSequences: parsed.data.stop_sequences } : {}),
    },
  });
  request.compatibility = [...findings].sort((left, right) => left.assessment.path.localeCompare(right.assessment.path));
  return completeAdapter(FORMAT, mode, request, findings);
}

function validToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(name);
}

function emittedToolName(
  name: string,
  path: string,
  sourceFormat: IrRequest["sourceFormat"] | IrResponse["sourceFormat"],
  findings: IrCompatibilityFinding[],
): string | null {
  if (validToolName(name)) return name;
  findings.push(finding(sourceFormat, path, "unsupported", "pointer_messages_tool_name_sanitized", "Messages requires tool names matching ^[A-Za-z0-9_-]{1,128}$; the adapter will not invent a replacement name.", FORMAT));
  return null;
}

function emitBlock(
  block: IrContentBlock,
  path: string,
  sourceFormat: IrRequest["sourceFormat"] | IrResponse["sourceFormat"],
  findings: IrCompatibilityFinding[],
): JsonObject | null {
  if (block.type === "text") {
    if (block.annotations) {
      findings.push(finding(sourceFormat, `${path}.annotations`, "lossy", "pointer_messages_annotations_dropped", "Messages cannot represent Responses text annotations.", FORMAT));
    }
    return { type: "text", text: block.text, ...(block.cacheControl ? { cache_control: block.cacheControl } : {}) };
  }
  if (block.type === "image") {
    if (block.source.type === "base64") return { type: "image", source: { type: "base64", media_type: block.source.mediaType, data: block.source.data }, ...(block.cacheControl ? { cache_control: block.cacheControl } : {}) };
    if (block.source.type === "url") return { type: "image", source: { type: "url", url: block.source.url }, ...(block.cacheControl ? { cache_control: block.cacheControl } : {}) };
    findings.push(finding(sourceFormat, path, "lossy", "pointer_messages_file_image_unsupported", "Messages cannot emit an image file reference on this adapter.", FORMAT));
    return null;
  }
  if (block.type === "tool_call") {
    const name = emittedToolName(block.name, `${path}.name`, sourceFormat, findings);
    return name ? {
      type: "tool_use",
      id: block.id,
      name,
      input: block.arguments,
      ...(block.cacheControl ? { cache_control: block.cacheControl } : {}),
      ...(block.providerMetadata ? { extra_content: block.providerMetadata } : {}),
    } : null;
  }
  if (block.type === "tool_result") {
    const structuredContent = Array.isArray(block.output)
      && block.output.every((part) => isRecord(part) && typeof part.type === "string");
    return {
      type: "tool_result",
      tool_use_id: block.callId,
      content: typeof block.output === "string" || structuredContent
        ? block.output
        : stringifyJsonValue(block.output),
      ...(block.isError ? { is_error: true } : {}),
      ...(block.cacheControl ? { cache_control: block.cacheControl } : {}),
    };
  }
  if (block.type === "reasoning") {
    if (block.encryptedContent) return { type: "redacted_thinking", data: block.encryptedContent };
    if (!block.signature) {
      findings.push(finding(sourceFormat, `${path}.signature`, "unsupported", "pointer_messages_reasoning_signature_missing", "Messages thinking requires a source signature; the adapter will not fabricate one.", FORMAT));
      return null;
    }
    return { type: "thinking", thinking: block.text, signature: block.signature };
  }
  if (block.type === "refusal") {
    findings.push(finding(sourceFormat, path, "lossy", "pointer_messages_refusal_emulated", "Messages represents refusal output as ordinary text.", FORMAT));
    return { type: "text", text: block.text };
  }
  findings.push(finding(sourceFormat, path, "lossy", "pointer_messages_block_dropped", `Messages cannot represent ${block.type} content.`, FORMAT));
  return null;
}

export function renderMessagesRequest(
  request: IrRequest,
  mode: GatewayAdapterMode = request.compatibilityPolicy,
  model = request.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const messages: JsonObject[] = [];
  const hoistedTurnBlocks: IrContentBlock[] = [];
  let sawConversationTurn = false;
  for (const [turnIndex, turn] of request.turns.entries()) {
    const role = turn.role === "assistant" ? "assistant" : "user";
    if (turn.role === "system" || turn.role === "developer") {
      if (sawConversationTurn) {
        findings.push(finding(request.sourceFormat, `turns.${turnIndex}.role`, "unsupported", "pointer_messages_instruction_hoisted", "Messages cannot preserve a system or developer turn after conversation has started.", FORMAT));
      } else {
        findings.push(finding(request.sourceFormat, `turns.${turnIndex}.role`, "emulated", "pointer_messages_instruction_hoisted", "Messages hoists leading system and developer turns into the system field.", FORMAT));
        hoistedTurnBlocks.push(...turn.blocks);
      }
      continue;
    }
    sawConversationTurn = true;
    messages.push({ role, content: turn.blocks.map((block, blockIndex) => emitBlock(block, `turns.${turnIndex}.blocks.${blockIndex}`, request.sourceFormat, findings)).filter((block): block is JsonObject => block !== null) });
  }
  const instructionBlocks = [
    ...request.instructions,
    ...hoistedTurnBlocks,
  ].map((block, index) => emitBlock(block, `instructions.${index}`, request.sourceFormat, findings)).filter((block): block is JsonObject => block !== null);
  const extensionOutput = emitExtensions(request.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  const renderedTools: JsonObject[] = [];
  for (const [index, tool] of request.tools.entries()) {
    if (tool.type === "builtin") {
      findings.push(finding(request.sourceFormat, `tools.${index}`, "lossy", "pointer_messages_builtin_tool_dropped", `Messages cannot represent the Responses built-in tool ${tool.name}.`, FORMAT));
      continue;
    }
    const name = emittedToolName(tool.name, `tools.${index}.name`, request.sourceFormat, findings);
    if (!name) continue;
    renderedTools.push({
      name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.parameters,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}),
    });
  }
  let renderedToolChoice: JsonObject | undefined;
  if (request.toolChoice?.type === "function") {
    const name = emittedToolName(request.toolChoice.name, "toolChoice.name", request.sourceFormat, findings);
    if (name) renderedToolChoice = {
      type: "tool",
      name,
      ...(request.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {}),
    };
  } else if (request.toolChoice) {
    renderedToolChoice = {
      type: request.toolChoice.type === "required" ? "any" : request.toolChoice.type,
      ...(request.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {}),
    };
  } else if (request.parallelToolCalls === false && renderedTools.length > 0) {
    renderedToolChoice = { type: "auto", disable_parallel_tool_use: true };
  }
  if (request.reasoning?.effort !== undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.effort", "unsupported", "pointer_reasoning_control_unsupported", "Messages cannot represent a reasoning effort control without an exact budget mapping.", FORMAT));
  }
  if (request.reasoning?.summary !== undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.summary", "unsupported", "pointer_reasoning_control_unsupported", "Messages cannot represent a reasoning summary control.", FORMAT));
  }
  const value: JsonObject = {
    ...extensionOutput.values,
    model,
    ...(instructionBlocks.length > 0 ? { system: instructionBlocks } : {}),
    messages,
    max_tokens: request.sampling.maxOutputTokens ?? 4096,
    stream: request.stream,
    ...(request.sampling.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling.topK !== undefined ? { top_k: request.sampling.topK } : {}),
    ...(request.sampling.stopSequences ? { stop_sequences: request.sampling.stopSequences } : {}),
    ...(renderedTools.length > 0 ? { tools: renderedTools } : {}),
    ...(renderedToolChoice ? { tool_choice: renderedToolChoice } : {}),
    ...(request.reasoning
      ? {
          thinking: request.reasoning.enabled
            ? request.reasoning.adaptive
              ? { type: "adaptive" }
              : { type: "enabled", ...(request.reasoning.budgetTokens !== undefined ? { budget_tokens: request.reasoning.budgetTokens } : {}) }
            : { type: "disabled" },
        }
      : {}),
  };
  if (request.responseFormat) {
    findings.push(finding(request.sourceFormat, "responseFormat", "unsupported", "pointer_messages_structured_output_unsupported", "Messages cannot represent the requested structured response format.", FORMAT));
  }
  if ((request.sampling.candidateCount ?? 1) > 1) {
    findings.push(finding(request.sourceFormat, "sampling.candidateCount", "unsupported", "pointer_messages_candidate_count_unsupported", "Messages cannot request multiple response candidates.", FORMAT));
  }
  for (const [field, value] of [
    ["responseLogprobs", request.sampling.responseLogprobs],
    ["logprobs", request.sampling.logprobs],
    ["presencePenalty", request.sampling.presencePenalty],
    ["frequencyPenalty", request.sampling.frequencyPenalty],
    ["seed", request.sampling.seed],
  ] as const) {
    if (value !== undefined) {
      findings.push(finding(request.sourceFormat, `sampling.${field}`, "unsupported", "pointer_messages_sampling_control_unsupported", `Messages cannot represent ${field}.`, FORMAT));
    }
  }
  if (request.sampling.maxOutputTokens === undefined) findings.push(finding(request.sourceFormat, "sampling.maxOutputTokens", "lossy", "pointer_messages_default_max_tokens", "Messages requires max_tokens; the adapter used 4096 because the source omitted a limit.", FORMAT));
  return completeAdapter(FORMAT, mode, value, findings);
}

export function parseMessagesResponse(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrResponse> {
  const parsed = messagesResponseSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const findings: IrCompatibilityFinding[] = [];
  const output = messageBlocks(parsed.data.content, "content", findings);
  const normalized = normalizeFinishReason(FORMAT, parsed.data.stop_reason, output.some((block) => block.type === "tool_call"));
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
    status: responseStatusForFinishReason(normalized.finishReason),
    output,
    ...normalized,
    ...(usageFromMessages(parsed.data.usage) ? { usage: usageFromMessages(parsed.data.usage) } : {}),
  });
  return completeAdapter(FORMAT, mode, response, findings);
}

export function renderMessagesResponse(
  response: IrResponse,
  mode: GatewayAdapterMode = response.compatibilityPolicy,
  model = response.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const content = response.output.map((block, index) => emitBlock(block, `output.${index}`, response.sourceFormat, findings)).filter((block): block is JsonObject => block !== null);
  for (const [index, block] of response.output.entries()) {
    const itemId = block.type === "tool_call" ? block.itemId : block.id;
    if (itemId) {
      findings.push(finding(response.sourceFormat, `output.${index}.id`, "lossy", "pointer_messages_output_item_id_dropped", "Messages has no per-content output item ID.", FORMAT));
    }
  }
  const extensionOutput = emitExtensions(response.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  const value: JsonObject = {
    ...extensionOutput.values,
    id: response.id,
    type: "message",
    role: "assistant",
    model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: finishReasonForFormat(FORMAT, response.finishReason, response.rawFinishReason),
    ...(extensionOutput.values.stop_sequence === undefined ? { stop_sequence: null } : {}),
    ...(response.usage ? { usage: usageToMessages(response.usage) } : {}),
  };
  return completeAdapter(FORMAT, mode, value, findings);
}
