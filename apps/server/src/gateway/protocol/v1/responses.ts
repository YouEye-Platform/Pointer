import { semanticResponseTools, resolveToolCatalog, emitResponseTools } from "./tool-codec";
import { RESPONSES_RESPONSE_METADATA_KEYS, nativeResponseItem, nativeResponseBlock, responseItemFromBlock } from "./responses-native";
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
  type JsonValue,
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
import { responsesRequestSchema, responsesResponseSchema } from "./public-schemas";
import {
  normalizeFinishReason,
  parseToolChoice,
  usageFromResponses,
  usageToResponses,
} from "./normalize";

const FORMAT = "responses" as const;
const MODELED_REQUEST_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "top_logprobs",
  "presence_penalty",
  "frequency_penalty",
  "seed",
]);
const PRESERVED_REQUEST_KEYS = new Set([
  "client_metadata",
  "background",
  "conversation",
  "include",
  "max_tool_calls",
  "metadata",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "safety_identifier",
  "service_tier",
  "store",
  "stream_options",
  "truncation",
  "user",
]);
const MODELED_RESPONSE_KEYS = new Set([
  "id",
  "object",
  "created_at",
  "status",
  "model",
  "output",
  "usage",
]);
const PRESERVED_RESPONSE_KEYS = RESPONSES_RESPONSE_METADATA_KEYS;

function responseContentBlocks(
  value: unknown,
  path: string,
  findings: IrCompatibilityFinding[],
): IrContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    findings.push(finding(FORMAT, path, "unsupported", "pointer_content_shape_unsupported", "Responses content must be a string or ordered block array."));
    return [];
  }
  const blocks: IrContentBlock[] = [];
  for (const [index, raw] of value.entries()) {
    const blockPath = `${path}.${index}`;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_invalid", "Responses content blocks require a string type discriminator."));
      continue;
    }
    if ((raw.type === "input_text" || raw.type === "output_text" || raw.type === "text" || raw.type === "summary_text") && typeof raw.text === "string") {
      blocks.push({
        type: "text",
        text: raw.text,
        ...(Array.isArray(raw.annotations) ? { annotations: raw.annotations as JsonValue[] } : {}),
      });
      continue;
    }
    if (raw.type === "input_image") {
      if (typeof raw.image_url === "string") {
        const data = raw.image_url.match(/^data:([^;]+);base64,(.*)$/s);
        blocks.push({
          type: "image",
          source: data ? { type: "base64", mediaType: data[1], data: data[2] } : { type: "url", url: raw.image_url },
          ...(raw.detail === "auto" || raw.detail === "low" || raw.detail === "high" ? { detail: raw.detail } : {}),
        });
        continue;
      }
      if (typeof raw.file_id === "string") {
        blocks.push({ type: "image", source: { type: "file", fileId: raw.file_id } });
        continue;
      }
    }
    if (raw.type === "input_file") {
      blocks.push({
        type: "file",
        ...(typeof raw.file_id === "string" ? { fileId: raw.file_id } : {}),
        ...(typeof raw.filename === "string" ? { filename: raw.filename } : {}),
        ...(typeof raw.file_data === "string" ? { data: raw.file_data } : {}),
      });
      continue;
    }
    if (raw.type === "input_audio" && typeof raw.data === "string" && typeof raw.format === "string") {
      blocks.push({ type: "audio", data: raw.data, format: raw.format });
      continue;
    }
    if (raw.type === "refusal" && typeof raw.refusal === "string") {
      blocks.push({ type: "refusal", text: raw.refusal });
      continue;
    }
    findings.push(finding(FORMAT, blockPath, "unsupported", "pointer_content_block_unsupported", `Responses content block ${raw.type} is not supported.`));
  }
  return blocks;
}

function parseInput(
  value: unknown,
  findings: IrCompatibilityFinding[],
): IrTurn[] {
  if (typeof value === "string") return [{ role: "user", blocks: [{ type: "text", text: value }] }];
  if (!Array.isArray(value)) return [];
  const turns: IrTurn[] = [];
  let adjacentToolCallId: string | undefined;
  for (const [index, raw] of value.entries()) {
    if (typeof raw === "string") {
      adjacentToolCallId = undefined;
      turns.push({ role: "user", blocks: [{ type: "text", text: raw }] });
      continue;
    }
    if (!isRecord(raw)) {
      adjacentToolCallId = undefined;
      continue;
    }
    if ((raw.type === "message" && !nativeResponseItem(raw)) || (typeof raw.role === "string" && raw.type === undefined)) {
      adjacentToolCallId = undefined;
      const role = raw.role === "assistant" ? "assistant" : raw.role === "developer" ? "developer" : raw.role === "system" ? "system" : "user";
      turns.push({ role, blocks: responseContentBlocks(raw.content, `input.${index}.content`, findings) });
      continue;
    }
    if (raw.type === "additional_tools" || raw.type === "tool_search_output") {
      if (!Array.isArray(raw.tools) || !raw.tools.every(isRecord)) {
        findings.push(finding(FORMAT, `input.${index}.tools`, "unsupported", "pointer_tool_definition_invalid", "Invalid deferred tools.")); continue;
      }
      turns.push({ role: "assistant", blocks: [{ type: "tool_declaration", source: raw.type,
        tools: raw.tools as JsonObject[], wireMetadata: Object.fromEntries(Object.entries(raw).filter(([key]) => !["type", "tools", "id", "call_id", "role"].includes(key))) as JsonObject, ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(typeof raw.call_id === "string" ? { callId: raw.call_id } : {}),
        ...(raw.role === "system" || raw.role === "developer" ? { role: raw.role } : {}) }] });
      continue;
    }
    if (raw.type === "custom_tool_call" && typeof raw.name === "string" && typeof raw.input === "string" && typeof raw.call_id === "string") {
      turns.push({ role: "assistant", blocks: [{ type: "tool_call", id: raw.call_id, name: raw.name,
        arguments: { input: raw.input }, rawArguments: JSON.stringify({ input: raw.input }), inputKind: "text",
        ...(typeof raw.namespace === "string" ? { namespace: raw.namespace } : {}),
        ...(typeof raw.id === "string" ? { itemId: raw.id } : {}) }] });
      continue;
    }
    if (raw.type === "custom_tool_call_output" && typeof raw.call_id === "string") {
      turns.push({ role: "tool", blocks: [{ type: "tool_result", callId: raw.call_id,
        output: asJsonValue(raw.output) ?? "", isError: false, inputKind: "text",
        ...(typeof raw.id === "string" ? { id: raw.id } : {}) }] });
      continue;
    }
    if (raw.type === "tool_search_call" && raw.execution === "client" && typeof raw.call_id === "string") {
      const args = asJsonValue(raw.arguments);
      if (args === undefined) { findings.push(finding(FORMAT, "input", "unsupported", "pointer_tool_search_invalid", "Invalid client tool-search call.")); continue; }
      const block: IrContentBlock = {type:"tool_call",id:raw.call_id,name:"tool_search",arguments:args,toolKind:"tool_search",providerMetadata:Object.fromEntries(Object.entries(raw).filter(([key])=>!["type","call_id","arguments","id"].includes(key))) as JsonObject,...(typeof raw.id === "string" ? {itemId:raw.id} : {})};
      turns.push({role:"assistant",blocks:[block]});
      continue;
    }
    const native = nativeResponseItem(raw);
    if (native) {
      adjacentToolCallId = undefined;
      turns.push({ role: String(native.type).endsWith("output") ? "tool" : "assistant", blocks: [nativeResponseBlock(native)] });
      continue;
    }
    if (raw.type === "function_call" && typeof raw.name === "string") {
      const rawArguments = typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {});
      const callId = typeof raw.call_id === "string"
        ? raw.call_id
        : typeof raw.id === "string"
          ? raw.id
          : stableGatewayId("call", "input", String(index), raw.name, rawArguments);
      adjacentToolCallId = callId;
      turns.push({
        role: "assistant",
        blocks: [{
          type: "tool_call",
          id: callId,
          name: raw.name,
          ...(typeof raw.namespace === "string" ? { namespace: raw.namespace } : {}),
          arguments: parseJsonValue(rawArguments),
          rawArguments,
          ...(typeof raw.id === "string" ? { itemId: raw.id } : {}),
        }],
      });
      continue;
    }
    if (raw.type === "function_call_output") {
      const output = asJsonValue(raw.output) ?? (typeof raw.output === "string" ? parseJsonValue(raw.output) : "");
      const callId = typeof raw.call_id === "string" ? raw.call_id : adjacentToolCallId;
      if (!callId) {
        findings.push(finding(
          FORMAT,
          `input.${index}.call_id`,
          "unsupported",
          "pointer_tool_call_invalid",
          "Responses function call output requires call_id unless it immediately follows its function call.",
        ));
      }
      turns.push({
        role: "tool",
        blocks: [{
          type: "tool_result",
          callId: callId ?? stableGatewayId("call", "orphan-output", String(index)),
          output,
          isError: false,
          ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        }],
      });
      adjacentToolCallId = undefined;
      continue;
    }
    if (raw.type === "reasoning") {
      adjacentToolCallId = undefined;
      const summary = responseContentBlocks(raw.summary, `input.${index}.summary`, findings).map((block) => block.type === "text" ? block.text : "").join("");
      turns.push({
        role: "assistant",
        blocks: [{
          type: "reasoning",
          text: summary,
          ...(Array.isArray(raw.summary) ? { summary: raw.summary } : {}),
          ...(typeof raw.id === "string" ? { id: raw.id } : {}),
          ...(typeof raw.encrypted_content === "string"
            ? { encryptedContent: raw.encrypted_content }
            : {}),
        }],
      });
      continue;
    }
    adjacentToolCallId = undefined;
    findings.push(finding(FORMAT, `input.${index}`, "unsupported", "pointer_response_input_item_unsupported", `Responses input item ${String(raw.type)} is not supported.`));
  }
  return turns;
}

function parseTools(value: unknown, findings: IrCompatibilityFinding[]): IrTool[] {
  try { return semanticResponseTools(value); }
  catch { findings.push(finding(FORMAT, "tools", "unsupported", "pointer_tool_definition_invalid", "Invalid tool declaration or namespace.")); return []; }
}

function repairInvalidFunctionParameters(input: unknown): {
  input: unknown;
  findings: IrCompatibilityFinding[];
} {
  if (!isRecord(input) || !Array.isArray(input.tools)) return { input, findings: [] };

  const findings: IrCompatibilityFinding[] = [];
  let changed = false;
  const tools = input.tools.map((raw, index) => {
    if (
      !isRecord(raw)
      || raw.type !== "function"
      || raw.parameters === undefined
      || asJsonObject(raw.parameters) !== null
    ) {
      return raw;
    }

    changed = true;
    findings.push(finding(
      FORMAT,
      `tools.${index}.parameters`,
      "unsupported",
      "pointer_responses_function_parameters_invalid",
      "Responses function parameters must be a JSON object.",
    ));
    return { ...raw, parameters: {} };
  });

  return {
    input: changed ? { ...input, tools } : input,
    findings,
  };
}

function parseInstructions(value: unknown, findings: IrCompatibilityFinding[]): IrContentBlock[] {
  if (value === undefined) return [];
  return responseContentBlocks(value, "instructions", findings);
}

export function parseResponsesRequest(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrRequest> {
  const repaired = repairInvalidFunctionParameters(input);
  const parsed = responsesRequestSchema.safeParse(repaired.input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const findings: IrCompatibilityFinding[] = [...repaired.findings];
  const rawChoice: Record<string, unknown> | undefined = isRecord(parsed.data.tool_choice) ? parsed.data.tool_choice : undefined;
  const toolChoice = parseToolChoice(FORMAT, rawChoice?.type === "custom" ? { ...rawChoice, type: "function" } : parsed.data.tool_choice);
  if (toolChoice.choice?.type === "function" && rawChoice) {
    if (typeof rawChoice.namespace === "string") toolChoice.choice.namespace = rawChoice.namespace;
    if (rawChoice.type === "custom") toolChoice.choice.inputKind = "text";
  }
  findings.push(...toolChoice.findings);
  const collected = collectExtensions(parsed.data, {
    sourceFormat: FORMAT,
    modeledKeys: MODELED_REQUEST_KEYS,
    preservedKeys: PRESERVED_REQUEST_KEYS,
  });
  findings.push(...collected.findings);
  const reasoning = isRecord(parsed.data.reasoning) ? parsed.data.reasoning : undefined;
  for (const key of Object.keys(reasoning ?? {})) {
    if (key !== "effort" && key !== "summary" && key !== "context") {
      findings.push(finding(FORMAT, `reasoning.${key}`, "unsupported", "pointer_responses_reasoning_control_unknown", "Responses reasoning contains an unsupported control."));
    }
  }
  if (reasoning?.context !== undefined) {
    collected.extensions.push({ namespace: FORMAT, key: "reasoning", value: { context: reasoning.context } });
  }
  const allowedEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
  const allowedSummaries = ["auto", "concise", "detailed", "none"] as const;
  const effort = reasoning && allowedEfforts.includes(reasoning.effort as typeof allowedEfforts[number])
    ? reasoning.effort as typeof allowedEfforts[number]
    : undefined;
  const summary = reasoning && allowedSummaries.includes(reasoning.summary as typeof allowedSummaries[number])
    ? reasoning.summary as typeof allowedSummaries[number]
    : undefined;
  const textConfig = isRecord(parsed.data.text) ? parsed.data.text : undefined;
  const textFormat = isRecord(textConfig?.format) ? textConfig.format : undefined;
  const responseFormatType = textFormat?.type;
  if (reasoning?.effort !== undefined && effort === undefined) {
    findings.push(finding(
      FORMAT,
      "reasoning.effort",
      "unsupported",
      "pointer_responses_reasoning_effort_invalid",
      "Responses reasoning effort is not supported.",
    ));
  }
  if (reasoning?.summary !== undefined && summary === undefined) {
    findings.push(finding(
      FORMAT,
      "reasoning.summary",
      "unsupported",
      "pointer_responses_reasoning_summary_invalid",
      "Responses reasoning summary is not supported.",
    ));
  }
  const turns = parseInput(parsed.data.input, findings);
  let tools = parseTools(parsed.data.tools, findings);
  try {
    tools = resolveToolCatalog(tools, turns.flatMap(turn => turn.blocks.flatMap(block =>
      block.type === "tool_declaration" ? [semanticResponseTools(block.tools, "deferred")] : [])));
  } catch { findings.push(finding(FORMAT, "tools", "unsupported", "pointer_tool_declaration_conflict", "Conflicting or invalid tool declarations.")); }
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
    instructions: parseInstructions(parsed.data.instructions, findings),
    turns,
    tools,
    ...(toolChoice.choice ? { toolChoice: toolChoice.choice } : {}),
    ...(optionalBoolean(parsed.data.parallel_tool_calls) !== undefined ? { parallelToolCalls: parsed.data.parallel_tool_calls } : {}),
    ...(reasoning ? { reasoning: { enabled: effort !== "none", ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) } } : {}),
    ...(responseFormatType === "text" || responseFormatType === "json_object"
      ? { responseFormat: { type: responseFormatType } }
      : responseFormatType === "json_schema"
        ? {
            responseFormat: {
              type: "json_schema",
              ...(typeof textFormat?.name === "string" ? { name: textFormat.name } : {}),
              ...(textFormat?.schema !== undefined ? { schema: textFormat.schema } : {}),
              ...(typeof textFormat?.strict === "boolean" ? { strict: textFormat.strict } : {}),
            },
          }
        : {}),
    sampling: {
      ...(optionalInteger(parsed.data.max_output_tokens) !== undefined ? { maxOutputTokens: parsed.data.max_output_tokens } : {}),
      ...(optionalNumber(parsed.data.temperature) !== undefined ? { temperature: parsed.data.temperature } : {}),
      ...(optionalNumber(parsed.data.top_p) !== undefined ? { topP: parsed.data.top_p } : {}),
      ...(optionalInteger(parsed.data.top_logprobs) !== undefined
        ? { logprobs: parsed.data.top_logprobs, responseLogprobs: true }
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

function emitResponseContent(
  block: IrContentBlock,
  role: IrTurn["role"],
  path: string,
  sourceFormat: IrRequest["sourceFormat"],
  findings: IrCompatibilityFinding[],
): JsonObject | null {
  if (block.type === "text") return {
    type: role === "assistant" ? "output_text" : "input_text",
    text: block.text,
    ...(role === "assistant" && block.annotations ? { annotations: block.annotations } : {}),
  };
  if (block.type === "image") {
    if (block.source.type === "file") return { type: "input_image", file_id: block.source.fileId, ...(block.detail ? { detail: block.detail } : {}) };
    const imageUrl = block.source.type === "base64" ? `data:${block.source.mediaType};base64,${block.source.data}` : block.source.url;
    return { type: "input_image", image_url: imageUrl, ...(block.detail ? { detail: block.detail } : {}) };
  }
  if (block.type === "file") return { type: "input_file", ...(block.fileId ? { file_id: block.fileId } : {}), ...(block.filename ? { filename: block.filename } : {}), ...(block.data ? { file_data: block.data } : {}) };
  if (block.type === "audio") return { type: "input_audio", data: block.data, format: block.format };
  if (block.type === "refusal") return { type: "refusal", refusal: block.text };
  findings.push(finding(sourceFormat, path, "lossy", "pointer_responses_message_block_split", `Responses emits ${block.type} as a separate item rather than message content.`, FORMAT));
  return null;
}

function emitInputItems(
  turns: readonly IrTurn[],
  sourceFormat: IrRequest["sourceFormat"],
  findings: IrCompatibilityFinding[],
): JsonObject[] {
  const items: JsonObject[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    if (turn.role === "system" || turn.role === "developer") continue;
    let pending: JsonObject[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      items.push({ type: "message", role: turn.role === "assistant" ? "assistant" : "user", content: pending });
      pending = [];
    };
    for (const [blockIndex, block] of turn.blocks.entries()) {
      const path = `turns.${turnIndex}.blocks.${blockIndex}`;
      if ("cacheControl" in block && block.cacheControl) {
        findings.push(finding(sourceFormat, `${path}.cacheControl`, "lossy", "pointer_responses_cache_control_dropped", "Responses does not have a portable content-block cache control.", FORMAT));
      }
      const native = responseItemFromBlock(block);
      if (native) {
        flush();
        items.push(native);
      } else if (block.type === "tool_declaration") {
        flush(); items.push({ ...block.wireMetadata, type: block.source, tools: block.tools,
          ...(block.id ? { id: block.id } : {}), ...(block.callId ? { call_id: block.callId } : {}),
          ...(block.role ? { role: block.role } : {}) });
      } else if (block.type === "tool_call") {
        flush();
        if (block.toolKind === "tool_search") { items.push({...block.providerMetadata,type:"tool_search_call",call_id:block.id,arguments:block.arguments,...(block.itemId ? {id:block.itemId} : {})}); continue; }
        items.push({ type: block.inputKind === "text" ? "custom_tool_call" : "function_call", ...(block.itemId ? { id: block.itemId } : {}), call_id: block.id, name: block.name,
          ...(block.namespace ? { namespace: block.namespace } : {}),
          ...(block.inputKind === "text" ? { input: isRecord(block.arguments) ? String(block.arguments.input ?? "") : String(block.arguments) } : { arguments: block.rawArguments ?? stringifyJsonValue(block.arguments) }) });
      } else if (block.type === "tool_result") {
        flush();
        items.push({
          type: block.inputKind === "text" ? "custom_tool_call_output" : "function_call_output",
          ...(block.id ? { id: block.id } : {}),
          call_id: block.callId,
          output: block.isError
            ? JSON.stringify({ error: block.output })
            : block.inputKind === "text" ? block.output : stringifyJsonValue(block.output),
        });
      } else if (block.type === "reasoning") {
        flush();
        if (block.signature) {
          findings.push(finding(
            sourceFormat,
            `${path}.signature`,
            "lossy",
            "pointer_responses_reasoning_signature_dropped",
            "Responses reasoning items cannot preserve reasoning signatures.",
            FORMAT,
          ));
        }
        items.push({ type: "reasoning", ...(block.id ? { id: block.id } : {}), summary: block.summary ?? [{ type: "summary_text", text: block.text }], ...(block.encryptedContent !== undefined ? { encrypted_content: block.encryptedContent } : {}) });
      } else {
        const content = emitResponseContent(block, turn.role, path, sourceFormat, findings);
        if (content) pending.push(content);
      }
    }
    flush();
  }
  return items;
}

export function renderResponsesRequest(
  request: IrRequest,
  mode: GatewayAdapterMode = request.compatibilityPolicy,
  model = request.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const instructionBlocks = [
    ...request.instructions,
    ...request.turns.filter((turn) => turn.role === "system" || turn.role === "developer").flatMap((turn) => turn.blocks),
  ];
  const instructions = instructionBlocks.map((block, index) => {
    if ("cacheControl" in block && block.cacheControl) {
      findings.push(finding(request.sourceFormat, `instructions.${index}.cacheControl`, "lossy", "pointer_responses_cache_control_dropped", "Responses does not have a portable content-block cache control.", FORMAT));
    }
    if (block.type === "text") return block.text;
    findings.push(finding(request.sourceFormat, `instructions.${index}`, "lossy", "pointer_responses_instruction_block_dropped", `Responses instructions cannot represent ${block.type}.`, FORMAT));
    return "";
  }).join("\n");
  const extensionOutput = emitExtensions(request.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  for (const tool of request.tools) {
    if (tool.type === "function" && tool.cacheControl) {
      findings.push(finding(request.sourceFormat, `tools.${tool.name}.cacheControl`, "lossy", "pointer_responses_cache_control_dropped", "Responses does not have a portable tool-definition cache control.", FORMAT));
    }
  }
  const effectiveReasoningEffort = request.outputEffort
    ?? request.reasoning?.effort
    ?? (request.reasoning?.enabled === false ? "none" : undefined);
  const value: JsonObject = {
    ...extensionOutput.values,
    model,
    ...(instructions ? { instructions } : {}),
    input: emitInputItems(request.turns, request.sourceFormat, findings),
    stream: request.stream,
    ...(request.sampling.maxOutputTokens !== undefined ? { max_output_tokens: request.sampling.maxOutputTokens } : {}),
    ...(request.sampling.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.tools.length > 0 ? { tools: emitResponseTools(request.tools.filter(tool => tool.type !== "function" || tool.declarationSource !== "deferred")) } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice.type === "function" ? { type: request.toolChoice.inputKind === "text" ? "custom" : "function", name: request.toolChoice.name, ...(request.toolChoice.namespace ? { namespace: request.toolChoice.namespace } : {}) } : request.toolChoice.type } : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(effectiveReasoningEffort || request.reasoning?.summary || extensionOutput.values.reasoning
      ? { reasoning: { ...(isRecord(extensionOutput.values.reasoning) ? extensionOutput.values.reasoning : {}), ...(effectiveReasoningEffort ? { effort: effectiveReasoningEffort } : {}), ...(request.reasoning?.summary ? { summary: request.reasoning.summary } : {}) } }
      : {}),
    ...(request.responseFormat
      ? {
          text: {
            format: request.responseFormat.type === "json_schema"
              ? {
                  type: "json_schema",
                  name: request.responseFormat.name ?? "pointer_response",
                  ...(request.responseFormat.schema !== undefined
                    ? { schema: request.responseFormat.schema }
                    : {}),
                  ...(request.responseFormat.strict !== undefined
                    ? { strict: request.responseFormat.strict }
                    : {}),
                }
              : { type: request.responseFormat.type },
          },
        }
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
  };
  if ((request.sampling.candidateCount ?? 1) > 1) {
    findings.push(finding(request.sourceFormat, "sampling.candidateCount", "unsupported", "pointer_responses_candidate_count_unsupported", "Responses cannot request multiple response candidates.", FORMAT));
  }
  if (request.reasoning?.enabled && request.reasoning.effort === undefined && request.outputEffort === undefined) {
    findings.push(finding(request.sourceFormat, "reasoning.enabled", "lossy", "pointer_responses_reasoning_control_dropped", "Responses has no exact adaptive or enabled-only reasoning control.", FORMAT));
  }
  return completeAdapter(FORMAT, mode, value, findings);
}

function outputBlocks(value: unknown, findings: IrCompatibilityFinding[]): IrContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: IrContentBlock[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.type !== "string") continue;
    if (raw.type === "message" && !nativeResponseItem(raw)) {
      blocks.push(...responseContentBlocks(raw.content, `output.${index}.content`, findings).map((block) => ({ ...block, ...(typeof raw.id === "string" && block.id === undefined ? { id: raw.id } : {}) })));
      continue;
    }
    if (raw.type === "tool_search_call" && raw.execution === "client" && typeof raw.call_id === "string") {
      const args = asJsonValue(raw.arguments);
      if (args === undefined) { findings.push(finding(FORMAT, "input", "unsupported", "pointer_tool_search_invalid", "Invalid client tool-search call.")); continue; }
      const block: IrContentBlock = {type:"tool_call",id:raw.call_id,name:"tool_search",arguments:args,toolKind:"tool_search",providerMetadata:Object.fromEntries(Object.entries(raw).filter(([key])=>!["type","call_id","arguments","id"].includes(key))) as JsonObject,...(typeof raw.id === "string" ? {itemId:raw.id} : {})};
      blocks.push(block);
      continue;
    }
    const native = nativeResponseItem(raw);
    if (native) { blocks.push(nativeResponseBlock(native)); continue; }
    if (raw.type === "custom_tool_call" && typeof raw.name === "string" && typeof raw.input === "string" && typeof raw.call_id === "string") {
      blocks.push({ type: "tool_call", id: raw.call_id, name: raw.name, arguments: { input: raw.input },
        rawArguments: JSON.stringify({ input: raw.input }), inputKind: "text",
        ...(typeof raw.namespace === "string" ? { namespace: raw.namespace } : {}),
        ...(typeof raw.id === "string" ? { itemId: raw.id } : {}) }); continue;
    }
    if (raw.type === "function_call" && typeof raw.name === "string") {
      const rawArguments = typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {});
      blocks.push({
        type: "tool_call",
        id: typeof raw.call_id === "string" ? raw.call_id : stableGatewayId("call", "output", String(index), raw.name, rawArguments),
        name: raw.name,
        ...(typeof raw.namespace === "string" ? { namespace: raw.namespace } : {}),
        arguments: parseJsonValue(rawArguments),
        rawArguments,
        ...(typeof raw.id === "string" ? { itemId: raw.id } : {}),
      });
      continue;
    }
    if (raw.type === "reasoning") {
      const summary = responseContentBlocks(raw.summary, `output.${index}.summary`, findings).filter((block) => block.type === "text").map((block) => block.text).join("");
      const encryptedContent =
        typeof raw.encrypted_content === "string"
          ? raw.encrypted_content
          : undefined;
      // Some Responses providers emit a lifecycle-only reasoning placeholder.
      // It has no semantic content and must not become unsigned Messages thinking.
      if (!summary && encryptedContent === undefined) continue;
      blocks.push({
        type: "reasoning",
        text: summary,
        ...(Array.isArray(raw.summary) ? { summary: raw.summary as { type: "summary_text"; text: string }[] } : {}),
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(encryptedContent !== undefined ? { encryptedContent } : {}),
      });
      continue;
    }
    if (raw.type === "refusal") {
      const text = typeof raw.refusal === "string" ? raw.refusal : "";
      blocks.push({ type: "refusal", text, ...(typeof raw.id === "string" ? { id: raw.id } : {}) });
      continue;
    }
    findings.push(finding(FORMAT, `output.${index}`, "unsupported", "pointer_response_output_item_unsupported", `Responses output item ${raw.type} is not supported.`));
  }
  return blocks;
}

export function parseResponsesResponse(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrResponse> {
  const parsed = responsesResponseSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const findings: IrCompatibilityFinding[] = [];
  const output = outputBlocks(parsed.data.output, findings);
  const status = parsed.data.status;
  const responseData: Record<string, unknown> = parsed.data;
  const incompleteDetails = isRecord(responseData.incomplete_details)
    ? responseData.incomplete_details
    : undefined;
  const normalized = status === "incomplete" && incompleteDetails?.reason === "content_filter"
    ? normalizeFinishReason(FORMAT, "content_filter")
    : normalizeFinishReason(FORMAT, status, output.some((block) => block.type === "tool_call"));
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
    ...(optionalInteger(parsed.data.created_at) !== undefined ? { createdAt: parsed.data.created_at } : {}),
    status: status === "completed" || status === "in_progress" || status === "incomplete" || status === "failed" || status === "cancelled" ? status : "failed",
    output,
    ...normalized,
    ...(usageFromResponses(parsed.data.usage) ? { usage: usageFromResponses(parsed.data.usage) } : {}),
  });
  return completeAdapter(FORMAT, mode, response, findings);
}

export function renderResponsesResponse(
  response: IrResponse,
  mode: GatewayAdapterMode = response.compatibilityPolicy,
  model = response.model,
): GatewayAdapterResult<JsonObject> {
  const findings: IrCompatibilityFinding[] = [];
  const output: JsonObject[] = [];
  let previousContentIndex: number | null = null;
  let previousMessageSourceId: string | undefined;

  for (const [index, block] of response.output.entries()) {
    const native = responseItemFromBlock(block);
    if (native) {
      previousContentIndex = null;
      previousMessageSourceId = undefined;
      output.push(native);
    } else if (block.type === "reasoning") {
      previousContentIndex = null;
      previousMessageSourceId = undefined;
      if (block.signature) {
        findings.push(finding(
          response.sourceFormat,
          `output.${index}.signature`,
          "lossy",
          "pointer_responses_reasoning_signature_dropped",
          "Responses reasoning items cannot preserve reasoning signatures.",
          FORMAT,
        ));
      }
      output.push({ id: block.id ?? stableGatewayId("rs", response.id, String(index)), type: "reasoning", summary: block.summary ?? [{ type: "summary_text", text: block.text }], ...(block.encryptedContent !== undefined ? { encrypted_content: block.encryptedContent } : {}) });
    } else if (block.type === "tool_call") {
      previousContentIndex = null;
      previousMessageSourceId = undefined;
      if (block.toolKind === "tool_search") { output.push({...block.providerMetadata,type:"tool_search_call",call_id:block.id,arguments:block.arguments,...(block.itemId ? {id:block.itemId} : {})}); continue; }
      output.push({ id: block.itemId ?? stableGatewayId("fc", response.id, String(index), block.id), type: block.inputKind === "text" ? "custom_tool_call" : "function_call", ...(block.inputKind === "text" ? {} : { status: "completed" }), call_id: block.id, name: block.name,
        ...(block.namespace ? { namespace: block.namespace } : {}),
        ...(block.inputKind === "text" ? { input: isRecord(block.arguments) ? String(block.arguments.input ?? "") : String(block.arguments) } : { arguments: block.rawArguments ?? stringifyJsonValue(block.arguments) }) });
    } else if (block.type === "text" || block.type === "refusal") {
      const content: JsonObject = block.type === "text"
        ? { type: "output_text", text: block.text, annotations: block.annotations ?? [] }
        : { type: "refusal", refusal: block.text };
      const previous = output.at(-1);
      if (
        block.id !== undefined
        && previousContentIndex === index - 1
        && previousMessageSourceId === block.id
        && previous?.type === "message"
        && Array.isArray(previous.content)
      ) {
        previous.content.push(content);
      } else {
        output.push({
          id: block.id ?? stableGatewayId("msg", response.id, String(index)),
          type: "message",
          status: "completed",
          role: "assistant",
          content: [content],
        });
      }
      previousContentIndex = index;
      previousMessageSourceId = block.id;
    } else {
      previousContentIndex = null;
      previousMessageSourceId = undefined;
      findings.push(finding(response.sourceFormat, `output.${index}`, "lossy", "pointer_responses_output_block_dropped", `Responses output cannot represent ${block.type} in a completed response.`, FORMAT));
    }
  }
  if (response.usage?.cacheCreationInputTokens !== undefined) {
    findings.push(finding(
      response.sourceFormat,
      "usage.cacheCreationInputTokens",
      "lossy",
      "pointer_responses_cache_creation_usage_dropped",
      "Responses usage has no cache-creation token field.",
      FORMAT,
    ));
  }
  const extensionOutput = emitExtensions(response.extensions, FORMAT);
  findings.push(...extensionOutput.findings);
  const value: JsonObject = {
    ...extensionOutput.values,
    id: response.id,
    object: "response",
    ...(response.createdAt !== undefined ? { created_at: response.createdAt } : {}),
    status: response.status,
    model,
    output,
    ...(extensionOutput.values.error === undefined ? { error: response.status === "failed" ? { code: "pointer_generation_failed", message: "Generation failed." } : null } : {}),
    ...(extensionOutput.values.incomplete_details === undefined
      ? {
          incomplete_details: response.status === "incomplete"
            ? {
                reason: response.finishReason === "length"
                  ? "max_output_tokens"
                  : response.finishReason === "content_filter"
                    ? "content_filter"
                    : "unknown",
              }
            : null,
        }
      : {}),
    ...(response.usage ? { usage: usageToResponses(response.usage) } : {}),
  };
  return completeAdapter(FORMAT, mode, value, findings);
}
