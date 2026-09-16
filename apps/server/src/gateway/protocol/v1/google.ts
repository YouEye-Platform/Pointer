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
  type IrToolChoice,
  type IrTurn,
  type JsonObject,
  type JsonValue,
  type ProviderExtension,
  irRequestSchema,
  irResponseSchema,
} from "./schemas";
import {
  asJsonObject,
  asJsonValue,
  completeAdapter,
  emitExtensions,
  finding,
  invalidPayloadFailure,
  isRecord,
  optionalBoolean,
  optionalInteger,
  optionalNumber,
  stableGatewayId,
  zodIssues,
} from "./common";
import {
  googleGenerateContentRequestSchema,
  googleGenerateContentResponseSchema,
} from "./public-schemas";
import {
  finishReasonForFormat,
  normalizeFinishReason,
  responseStatusForFinishReason,
  usageFromGoogle,
  usageToGoogle,
} from "./normalize";

const FORMAT = "google-generate-content" as const;
const NATIVE_REQUEST_EXTENSION = "nativeRequest";
const NATIVE_RESPONSE_EXTENSION = "nativeResponse";

function nativeExtension(
  key: typeof NATIVE_REQUEST_EXTENSION | typeof NATIVE_RESPONSE_EXTENSION,
  value: JsonObject,
): ProviderExtension {
  return { namespace: FORMAT, key, value };
}

function nativePayload(
  extensions: readonly ProviderExtension[],
  key: typeof NATIVE_REQUEST_EXTENSION | typeof NATIVE_RESPONSE_EXTENSION,
): JsonObject | undefined {
  const extension = extensions.find(
    (candidate) => candidate.namespace === FORMAT && candidate.key === key,
  );
  return extension ? asJsonObject(extension.value) ?? undefined : undefined;
}

function withoutInternalFields(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "model" || key === "stream") continue;
    const json = asJsonValue(child);
    if (json !== null || child === null) result[key] = json;
  }
  return result;
}

function mediaBlock(
  part: Record<string, unknown>,
  path: string,
): IrContentBlock {
  const inlineData = isRecord(part.inlineData) ? part.inlineData : undefined;
  if (
    inlineData
    && typeof inlineData.mimeType === "string"
    && typeof inlineData.data === "string"
  ) {
    if (inlineData.mimeType.startsWith("image/")) {
      return {
        type: "image",
        source: {
          type: "base64",
          mediaType: inlineData.mimeType,
          data: inlineData.data,
        },
      };
    }
    if (inlineData.mimeType.startsWith("audio/")) {
      return {
        type: "audio",
        data: inlineData.data,
        format: inlineData.mimeType,
      };
    }
    return {
      type: "file",
      data: inlineData.data,
      ...(typeof inlineData.displayName === "string"
        ? { filename: inlineData.displayName }
        : {}),
    };
  }
  const fileData = isRecord(part.fileData) ? part.fileData : undefined;
  if (
    fileData
    && typeof fileData.mimeType === "string"
    && typeof fileData.fileUri === "string"
  ) {
    if (fileData.mimeType.startsWith("image/")) {
      return {
        type: "image",
        source: { type: "url", url: fileData.fileUri },
      };
    }
    return {
      type: "file",
      fileId: fileData.fileUri,
      ...(typeof fileData.displayName === "string"
        ? { filename: fileData.displayName }
        : {}),
    };
  }
  return {
    type: "extension",
    extension: {
      namespace: FORMAT,
      key: `part.${stableGatewayId("media", path).slice(6)}`,
      value: asJsonObject(part) ?? {},
    },
  };
}

function googleParts(
  value: unknown,
  path: string,
  callIdsByName: Map<string, string[]>,
): IrContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: IrContentBlock[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) continue;
    const blockPath = `${path}.${index}`;
    if (typeof raw.text === "string") {
      blocks.push(raw.thought === true
        ? {
            type: "reasoning",
            text: raw.text,
            ...(typeof raw.thoughtSignature === "string"
              ? { signature: raw.thoughtSignature }
              : {}),
          }
        : { type: "text", text: raw.text });
      continue;
    }
    if (raw.inlineData !== undefined || raw.fileData !== undefined) {
      blocks.push(mediaBlock(raw, blockPath));
      continue;
    }
    if (isRecord(raw.functionCall) && typeof raw.functionCall.name === "string") {
      const args = asJsonObject(raw.functionCall.args) ?? {};
      const id = typeof raw.functionCall.id === "string"
        ? raw.functionCall.id
        : stableGatewayId(
            "call",
            blockPath,
            raw.functionCall.name,
            JSON.stringify(args),
          );
      const ids = callIdsByName.get(raw.functionCall.name) ?? [];
      ids.push(id);
      callIdsByName.set(raw.functionCall.name, ids);
      const googleMetadata: JsonObject = {};
      if (typeof raw.thoughtSignature === "string") {
        googleMetadata.thoughtSignature = raw.thoughtSignature;
      }
      blocks.push({
        type: "tool_call",
        id,
        name: raw.functionCall.name,
        arguments: args,
        rawArguments: JSON.stringify(args),
        ...(Object.keys(googleMetadata).length > 0
          ? { providerMetadata: { google: googleMetadata } }
          : {}),
      });
      continue;
    }
    if (isRecord(raw.functionResponse) && typeof raw.functionResponse.name === "string") {
      const queued = callIdsByName.get(raw.functionResponse.name) ?? [];
      const callId = typeof raw.functionResponse.id === "string"
        ? raw.functionResponse.id
        : queued.shift()
          ?? stableGatewayId("call", "response", blockPath, raw.functionResponse.name);
      callIdsByName.set(raw.functionResponse.name, queued);
      const response = asJsonObject(raw.functionResponse.response) ?? {};
      blocks.push({
        type: "tool_result",
        callId,
        output: response,
        isError: Object.prototype.hasOwnProperty.call(response, "error"),
      });
      continue;
    }
    blocks.push({
      type: "extension",
      extension: {
        namespace: FORMAT,
        key: `part.${stableGatewayId("part", blockPath).slice(5)}`,
        value: asJsonObject(raw) ?? {},
      },
    });
  }
  return blocks;
}

function googleTurns(contents: unknown): IrTurn[] {
  if (!Array.isArray(contents)) return [];
  const callIdsByName = new Map<string, string[]>();
  return contents.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    return [{
      role: raw.role === "model" ? "assistant" as const : "user" as const,
      blocks: googleParts(raw.parts, `contents.${index}.parts`, callIdsByName),
    }];
  });
}

function googleInstructions(value: unknown): IrContentBlock[] {
  if (!isRecord(value)) return [];
  return googleParts(value.parts, "systemInstruction.parts", new Map());
}

function googleTools(value: unknown): IrTool[] {
  if (!Array.isArray(value)) return [];
  const tools: IrTool[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (Array.isArray(raw.functionDeclarations)) {
      for (const declaration of raw.functionDeclarations) {
        if (!isRecord(declaration) || typeof declaration.name !== "string") continue;
        tools.push({
          type: "function",
          name: declaration.name,
          ...(typeof declaration.description === "string"
            ? { description: declaration.description }
            : {}),
          parameters:
            asJsonObject(declaration.parametersJsonSchema)
            ?? asJsonObject(declaration.parameters)
            ?? {},
          ...(declaration.behavior === "NON_BLOCKING" ? { strict: false } : {}),
        });
      }
    }
    for (const [key, configuration] of Object.entries(raw)) {
      if (key === "functionDeclarations") continue;
      const parsed = asJsonObject(configuration);
      if (parsed) tools.push({ type: "builtin", name: key, configuration: parsed });
    }
  }
  return tools;
}

function googleToolChoice(value: unknown): IrToolChoice | undefined {
  if (!isRecord(value) || !isRecord(value.functionCallingConfig)) return undefined;
  const config = value.functionCallingConfig;
  if (config.mode === "NONE") return { type: "none" };
  if (config.mode === "AUTO" || config.mode === "VALIDATED") return { type: "auto" };
  if (config.mode === "ANY") {
    const names = Array.isArray(config.allowedFunctionNames)
      ? config.allowedFunctionNames.filter((name): name is string => typeof name === "string")
      : [];
    return names.length === 1
      ? { type: "function", name: names[0]! }
      : { type: "required" };
  }
  return undefined;
}

function googleReasoning(value: unknown): IrRequest["reasoning"] | undefined {
  if (!isRecord(value)) return undefined;
  const includeThoughts = optionalBoolean(value.includeThoughts);
  const budgetTokens = optionalInteger(value.thinkingBudget);
  const level = typeof value.thinkingLevel === "string"
    ? value.thinkingLevel.toLowerCase()
    : undefined;
  const effort = level && ["minimal", "low", "medium", "high"].includes(level)
    ? level as "minimal" | "low" | "medium" | "high"
    : undefined;
  if (includeThoughts === undefined && budgetTokens === undefined && !effort) return undefined;
  if (includeThoughts === false && budgetTokens === undefined && !effort) return undefined;
  return {
    enabled: budgetTokens === 0
      ? false
      : budgetTokens !== undefined || includeThoughts === true || Boolean(effort),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function parseGoogleRequest(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrRequest> {
  const parsed = googleGenerateContentRequestSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const generation = parsed.data.generationConfig;
  const findings: IrCompatibilityFinding[] = [];
  const native = withoutInternalFields(parsed.data);
  const request = irRequestSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "request",
    sourceFormat: FORMAT,
    compatibilityPolicy: mode,
    compatibility: findings,
    extensions: [nativeExtension(NATIVE_REQUEST_EXTENSION, native)],
    model: parsed.data.model,
    stream: parsed.data.stream ?? false,
    instructions: googleInstructions(parsed.data.systemInstruction),
    turns: googleTurns(parsed.data.contents),
    tools: googleTools(parsed.data.tools),
    ...(googleToolChoice(parsed.data.toolConfig)
      ? { toolChoice: googleToolChoice(parsed.data.toolConfig) }
      : {}),
    ...(googleReasoning(generation?.thinkingConfig)
      ? { reasoning: googleReasoning(generation?.thinkingConfig) }
      : {}),
    ...(generation?.responseMimeType || generation?.responseSchema || generation?.responseJsonSchema
      ? {
          responseFormat: {
            type: generation.responseSchema || generation.responseJsonSchema
              ? "json_schema"
              : generation.responseMimeType === "application/json"
                ? "json_object"
                : "text",
            ...(generation.responseMimeType
              ? { mimeType: generation.responseMimeType }
              : {}),
            ...(generation.responseJsonSchema !== undefined
              ? { schema: generation.responseJsonSchema }
              : generation.responseSchema !== undefined
                ? { schema: generation.responseSchema }
                : {}),
          },
        }
      : {}),
    sampling: {
      ...(optionalNumber(generation?.temperature) !== undefined
        ? { temperature: generation?.temperature }
        : {}),
      ...(optionalNumber(generation?.topP) !== undefined ? { topP: generation?.topP } : {}),
      ...(typeof generation?.topK === "number" ? { topK: generation.topK } : {}),
      ...(optionalInteger(generation?.candidateCount) !== undefined
        ? { candidateCount: generation?.candidateCount }
        : {}),
      ...(optionalInteger(generation?.maxOutputTokens) !== undefined
        ? { maxOutputTokens: generation?.maxOutputTokens }
        : {}),
      ...(generation?.stopSequences ? { stopSequences: generation.stopSequences } : {}),
      ...(optionalBoolean(generation?.responseLogprobs) !== undefined
        ? { responseLogprobs: generation?.responseLogprobs }
        : {}),
      ...(optionalInteger(generation?.logprobs) !== undefined
        ? { logprobs: generation?.logprobs }
        : {}),
      ...(optionalNumber(generation?.presencePenalty) !== undefined
        ? { presencePenalty: generation?.presencePenalty }
        : {}),
      ...(optionalNumber(generation?.frequencyPenalty) !== undefined
        ? { frequencyPenalty: generation?.frequencyPenalty }
        : {}),
      ...(typeof generation?.seed === "number" ? { seed: generation.seed } : {}),
    },
  });
  return completeAdapter(FORMAT, mode, request, findings);
}

function googleBlock(
  block: IrContentBlock,
  path: string,
  findings: IrCompatibilityFinding[],
  toolNamesByCallId: Map<string, string>,
): JsonObject | null {
  if (block.type === "text") return { text: block.text };
  if (block.type === "reasoning") {
    return {
      text: block.text,
      thought: true,
      ...(block.signature ? { thoughtSignature: block.signature } : {}),
    };
  }
  if (block.type === "image") {
    if (block.source.type === "base64") {
      return {
        inlineData: { mimeType: block.source.mediaType, data: block.source.data },
      };
    }
    if (block.source.type === "url") {
      return { fileData: { mimeType: "image/*", fileUri: block.source.url } };
    }
    return { fileData: { mimeType: "application/octet-stream", fileUri: block.source.fileId } };
  }
  if (block.type === "audio") {
    return { inlineData: { mimeType: block.format, data: block.data } };
  }
  if (block.type === "file") {
    if (block.data) {
      return {
        inlineData: {
          mimeType: "application/octet-stream",
          data: block.data,
          ...(block.filename ? { displayName: block.filename } : {}),
        },
      };
    }
    if (block.fileId) {
      return {
        fileData: {
          mimeType: "application/octet-stream",
          fileUri: block.fileId,
          ...(block.filename ? { displayName: block.filename } : {}),
        },
      };
    }
  }
  if (block.type === "tool_call") {
    toolNamesByCallId.set(block.id, block.name);
    const google = asJsonObject(block.providerMetadata?.google);
    return {
      functionCall: {
        id: block.id,
        name: block.name,
        args: block.arguments,
      },
      ...(typeof google?.thoughtSignature === "string"
        ? { thoughtSignature: google.thoughtSignature }
        : {}),
    };
  }
  if (block.type === "tool_result") {
    const response = asJsonObject(block.output) ?? {
      [block.isError ? "error" : "output"]: block.output,
    };
    return {
      functionResponse: {
        id: block.callId,
        name: toolNamesByCallId.get(block.callId) ?? "tool",
        response,
      },
    };
  }
  if (block.type === "refusal") return { text: block.text };
  if (block.type === "extension" && block.extension.namespace === FORMAT) {
    return asJsonObject(block.extension.value);
  }
  findings.push(finding(
    block.type === "extension" ? block.extension.namespace : FORMAT,
    path,
    "lossy",
    "pointer_google_block_dropped",
    "The content block cannot be represented in Google GenerateContent.",
    FORMAT,
  ));
  return null;
}

function googleContent(
  role: "user" | "model",
  blocks: readonly IrContentBlock[],
  path: string,
  findings: IrCompatibilityFinding[],
  toolNamesByCallId: Map<string, string>,
): JsonObject | null {
  const parts = blocks.flatMap((block, index) => {
    const rendered = googleBlock(block, `${path}.${index}`, findings, toolNamesByCallId);
    return rendered ? [rendered] : [];
  });
  return parts.length > 0 ? { role, parts } : null;
}

function googleToolDefinition(tool: IrTool): JsonObject {
  if (tool.type === "builtin") {
    const name = tool.name === "web_search" || tool.name === "web_search_preview"
      ? "googleSearch"
      : tool.name;
    return { [name]: tool.configuration };
  }
  return {
    functionDeclarations: [{
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parametersJsonSchema: tool.parameters,
    }],
  };
}

function googleToolConfig(choice: IrToolChoice | undefined): JsonObject | undefined {
  if (!choice) return undefined;
  if (choice.type === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice.type === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice.type === "required") return { functionCallingConfig: { mode: "ANY" } };
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [choice.name],
    },
  };
}

export function renderGoogleRequest(
  request: IrRequest,
  mode: GatewayAdapterMode = request.compatibilityPolicy,
  model = request.model,
): GatewayAdapterResult<JsonObject> {
  const findings = [...request.compatibility];
  const native = nativePayload(request.extensions, NATIVE_REQUEST_EXTENSION);
  if (native) {
    return completeAdapter(FORMAT, mode, {
      ...native,
      model,
      stream: request.stream,
    }, findings);
  }

  const contents: JsonObject[] = [];
  const toolNamesByCallId = new Map<string, string>();
  for (const [index, turn] of request.turns.entries()) {
    const content = googleContent(
      turn.role === "assistant" ? "model" : "user",
      turn.blocks,
      `contents.${index}.parts`,
      findings,
      toolNamesByCallId,
    );
    if (content) contents.push(content);
  }
  const instructions = googleContent(
    "user",
    request.instructions,
    "systemInstruction.parts",
    findings,
    toolNamesByCallId,
  );
  const generationConfig: JsonObject = {
    ...(request.sampling.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.sampling.topP !== undefined ? { topP: request.sampling.topP } : {}),
    ...(request.sampling.topK !== undefined ? { topK: request.sampling.topK } : {}),
    ...(request.sampling.candidateCount !== undefined
      ? { candidateCount: request.sampling.candidateCount }
      : {}),
    ...(request.sampling.maxOutputTokens !== undefined
      ? { maxOutputTokens: request.sampling.maxOutputTokens }
      : {}),
    ...(request.sampling.stopSequences
      ? { stopSequences: request.sampling.stopSequences }
      : {}),
    ...(request.sampling.responseLogprobs !== undefined
      ? { responseLogprobs: request.sampling.responseLogprobs }
      : {}),
    ...(request.sampling.logprobs !== undefined
      ? { logprobs: request.sampling.logprobs }
      : {}),
    ...(request.sampling.presencePenalty !== undefined
      ? { presencePenalty: request.sampling.presencePenalty }
      : {}),
    ...(request.sampling.frequencyPenalty !== undefined
      ? { frequencyPenalty: request.sampling.frequencyPenalty }
      : {}),
    ...(request.sampling.seed !== undefined ? { seed: request.sampling.seed } : {}),
    ...(request.responseFormat
      ? {
          responseMimeType: request.responseFormat.mimeType
            ?? (request.responseFormat.type === "text" ? "text/plain" : "application/json"),
          ...(request.responseFormat.schema !== undefined
            ? { responseJsonSchema: request.responseFormat.schema }
            : {}),
        }
      : {}),
    ...(request.reasoning ? {
      thinkingConfig: {
        includeThoughts: request.reasoning.enabled,
        ...(request.reasoning.budgetTokens !== undefined
          ? { thinkingBudget: request.reasoning.budgetTokens }
          : {}),
        ...(request.reasoning.effort
          ? { thinkingLevel: request.reasoning.effort.toUpperCase() }
          : {}),
      },
    } : {}),
  };
  const externalExtensions = request.extensions.filter(
    (extension) => !(extension.namespace === FORMAT && extension.key === NATIVE_REQUEST_EXTENSION),
  );
  const emitted = emitExtensions(externalExtensions, FORMAT);
  findings.push(...emitted.findings);
  const value: JsonObject = {
    ...emitted.values,
    model,
    stream: request.stream,
    contents,
    ...(instructions ? { systemInstruction: instructions } : {}),
    ...(request.tools.length > 0 ? { tools: request.tools.map(googleToolDefinition) } : {}),
    ...(googleToolConfig(request.toolChoice)
      ? { toolConfig: googleToolConfig(request.toolChoice) }
      : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
  return completeAdapter(FORMAT, mode, value, findings);
}

function responseBlocks(parts: unknown): IrContentBlock[] {
  return googleParts(parts, "candidates.0.content.parts", new Map());
}

export function parseGoogleResponse(
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrResponse> {
  const parsed = googleGenerateContentResponseSchema.safeParse(input);
  if (!parsed.success) return invalidPayloadFailure(FORMAT, zodIssues(parsed.error));
  const candidate = parsed.data.candidates?.[0];
  const output = responseBlocks(candidate?.content?.parts);
  const promptBlockReason = typeof parsed.data.promptFeedback?.blockReason === "string"
    ? parsed.data.promptFeedback.blockReason
    : undefined;
  const normalized = promptBlockReason && !candidate
    ? { finishReason: "content_filter" as const, rawFinishReason: promptBlockReason }
    : normalizeFinishReason(
        FORMAT,
        candidate?.finishReason,
        output.some((block) => block.type === "tool_call"),
      );
  const native = withoutInternalFields(parsed.data);
  const findings: IrCompatibilityFinding[] = [];
  if ((parsed.data.candidates?.length ?? 0) > 1) {
    findings.push(finding(
      FORMAT,
      "candidates",
      "lossy",
      "pointer_multiple_choices_lossy",
      "Only the first Google candidate is portable across gateway formats.",
    ));
  }
  const response = irResponseSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "response",
    sourceFormat: FORMAT,
    compatibilityPolicy: mode,
    compatibility: findings,
    extensions: [nativeExtension(NATIVE_RESPONSE_EXTENSION, native)],
    id: parsed.data.responseId
      ?? stableGatewayId("response", parsed.data.model, JSON.stringify(native).slice(0, 4096)),
    model: parsed.data.model,
    status: responseStatusForFinishReason(normalized.finishReason),
    output,
    ...normalized,
    ...(usageFromGoogle(parsed.data.usageMetadata)
      ? { usage: usageFromGoogle(parsed.data.usageMetadata) }
      : {}),
  });
  return completeAdapter(FORMAT, mode, response, findings);
}

export function renderGoogleResponse(
  response: IrResponse,
  mode: GatewayAdapterMode = response.compatibilityPolicy,
  model = response.model,
): GatewayAdapterResult<JsonObject> {
  const findings = [...response.compatibility];
  const native = nativePayload(response.extensions, NATIVE_RESPONSE_EXTENSION);
  if (native) {
    return completeAdapter(FORMAT, mode, {
      ...native,
      model,
      modelVersion: model,
    }, findings);
  }
  const parts = response.output.flatMap((block, index) => {
    const rendered = googleBlock(
      block,
      `candidates.0.content.parts.${index}`,
      findings,
      new Map(),
    );
    return rendered ? [rendered] : [];
  });
  const externalExtensions = response.extensions.filter(
    (extension) => !(extension.namespace === FORMAT && extension.key === NATIVE_RESPONSE_EXTENSION),
  );
  const emitted = emitExtensions(externalExtensions, FORMAT);
  findings.push(...emitted.findings);
  const value: JsonObject = {
    ...emitted.values,
    model,
    modelVersion: model,
    responseId: response.id,
    candidates: [{
      index: 0,
      content: { role: "model", parts },
      finishReason:
        finishReasonForFormat(FORMAT, response.finishReason, response.rawFinishReason)
        ?? "OTHER",
    }],
    ...(response.usage ? { usageMetadata: usageToGoogle(response.usage) } : {}),
  };
  return completeAdapter(FORMAT, mode, value, findings);
}

export function stripGoogleInternalFields(value: JsonObject): JsonObject {
  const { model: _model, stream: _stream, ...publicValue } = value;
  return publicValue;
}
