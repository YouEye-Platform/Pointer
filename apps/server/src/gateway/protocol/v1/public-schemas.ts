import { z } from "zod";
import { responsesNativeItemSchema } from "./responses-native";
import type { GatewayApiFormat } from "../../compatibility";
import { jsonObjectSchema, jsonValueSchema } from "./schemas";

const jsonRecord = z.object({}).catchall(jsonValueSchema);
const modelSchema = z.string().min(1).max(4096);
const usageIntegerSchema = z.number().int().nonnegative();
const cacheControlSchema = z
  .object({ type: z.literal("ephemeral"), ttl: z.string().optional() })
  .strict();

const chatContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), cache_control: cacheControlSchema.optional() }).strict(),
  z.object({ type: z.literal("input_text"), text: z.string(), cache_control: cacheControlSchema.optional() }).strict(),
  z.object({ type: z.literal("output_text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().min(1), detail: z.enum(["auto", "low", "high"]).optional() }).strict() }).strict(),
  z.object({ type: z.literal("input_audio"), input_audio: z.object({ data: z.string(), format: z.string().min(1) }).strict() }).strict(),
  z.object({ type: z.literal("file"), file_id: z.string().optional(), filename: z.string().optional(), file_data: z.string().optional() }).strict(),
  z.object({ type: z.literal("refusal"), refusal: z.string() }).strict(),
]);

const chatToolCallSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    id: z.string().optional(),
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1), arguments: z.union([z.string(), jsonValueSchema]).optional() }).strict(),
    extra_content: jsonObjectSchema.optional(),
  })
  .strict();

const chatGeneralContentSchema = z.union([
  z.string(),
  z.null(),
  z.array(chatContentBlockSchema),
]);
const chatMessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
    content: chatGeneralContentSchema.optional(),
    name: z.string().optional(),
    tool_call_id: z.string().min(1).optional(),
    tool_calls: z.array(chatToolCallSchema).optional(),
    reasoning_content: z.string().optional(),
    reasoning_details: z.array(jsonObjectSchema).optional(),
  })
  .strict()
  .superRefine((message, context) => {
    const requireContent = message.role !== "assistant";
    if (requireContent && message.content === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: `${message.role} messages require content` });
    }
    if ((message.role === "system" || message.role === "developer" || message.role === "user") && message.content === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: `${message.role} message content cannot be null` });
    }
    if (message.role !== "assistant" && message.tool_calls !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tool_calls"], message: "tool_calls are valid only on assistant messages" });
    }
    if (message.role !== "assistant" && message.reasoning_content !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasoning_content"], message: "reasoning_content is valid only on assistant messages" });
    }
    if (message.role !== "assistant" && message.reasoning_details !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasoning_details"], message: "reasoning_details is valid only on assistant messages" });
    }
    if (message.role === "tool" && message.tool_call_id === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tool_call_id"], message: "tool messages require tool_call_id" });
    }
    if (message.role !== "tool" && message.tool_call_id !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tool_call_id"], message: "tool_call_id is valid only on tool messages" });
    }
    if (message.role === "function") {
      if (!message.name) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "function messages require name" });
      }
      if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "function message content must be a string or null" });
      }
    }
  });

const chatToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1) }).strict(),
  }).strict(),
]);

const chatFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        parameters: jsonObjectSchema.optional(),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const chatCompletionsRequestSchema = z
  .object({
    model: modelSchema,
    messages: z.array(chatMessageSchema),
    stream: z.boolean().optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    max_tokens: z.number().int().nonnegative().optional(),
    max_completion_tokens: z.number().int().nonnegative().optional(),
    tools: z.array(chatFunctionToolSchema).optional(),
    tool_choice: chatToolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning_effort: z.string().optional(),
    n: z.number().int().positive().max(16).optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().int().nonnegative().optional(),
    presence_penalty: z.number().finite().optional(),
    frequency_penalty: z.number().finite().optional(),
    seed: z.number().int().optional(),
    response_format: jsonObjectSchema.optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .catchall(jsonValueSchema);
export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;

const messagesTextBlockSchema = z
  .object({ type: z.literal("text"), text: z.string(), cache_control: cacheControlSchema.optional() })
  .strict();
const messagesImageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("url"), url: z.string().min(1) }).strict(),
      z.object({ type: z.literal("base64"), media_type: z.string().min(1), data: z.string() }).strict(),
    ]),
    cache_control: cacheControlSchema.optional(),
  })
  .strict();
const messagesToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string().min(1),
    input: jsonValueSchema.optional(),
    cache_control: cacheControlSchema.optional(),
    extra_content: jsonObjectSchema.optional(),
  })
  .strict();
const messagesToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().min(1),
    content: z.union([z.string(), z.array(jsonObjectSchema)]).optional(),
    is_error: z.boolean().optional(),
    cache_control: cacheControlSchema.optional(),
  })
  .strict();
const messagesThinkingBlockSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional() })
  .strict();
const messagesRedactedThinkingBlockSchema = z
  .object({ type: z.literal("redacted_thinking"), data: z.string() })
  .strict();
const messagesUserContentBlockSchema = z.discriminatedUnion("type", [
  messagesTextBlockSchema,
  messagesImageBlockSchema,
  messagesToolResultBlockSchema,
]);
const messagesAssistantContentBlockSchema = z.discriminatedUnion("type", [
  messagesTextBlockSchema,
  messagesToolUseBlockSchema,
  messagesThinkingBlockSchema,
  messagesRedactedThinkingBlockSchema,
]);
const messagesMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(messagesUserContentBlockSchema)]),
  }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.array(messagesAssistantContentBlockSchema)]),
  }).strict(),
]);
const messagesToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: jsonObjectSchema,
    strict: z.boolean().optional(),
    cache_control: cacheControlSchema.optional(),
  })
  .strict();

const messagesToolChoiceSchema = z.union([
  z.enum(["none", "auto", "any", "required"]),
  z.object({
    type: z.enum(["none", "auto", "any"]),
    disable_parallel_tool_use: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1),
    disable_parallel_tool_use: z.boolean().optional(),
  }).strict(),
]);

export const messagesRequestSchema = z
  .object({
    model: modelSchema,
    system: z.union([z.string(), z.array(messagesTextBlockSchema)]).optional(),
    messages: z.array(messagesMessageSchema),
    max_tokens: z.number().int().nonnegative(),
    stream: z.boolean().optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    top_k: z.number().int().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(messagesToolSchema).optional(),
    tool_choice: messagesToolChoiceSchema.optional(),
    thinking: jsonObjectSchema.optional(),
  })
  .catchall(jsonValueSchema);
export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

const responsesContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }).strict(),
  z.object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(jsonValueSchema).optional(),
    logprobs: jsonValueSchema.optional(),
  }).strict(),
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("summary_text"), text: z.string() }).strict(),
  z.object({ type: z.literal("input_image"), image_url: z.string().optional(), file_id: z.string().optional(), detail: z.enum(["auto", "low", "high"]).optional() }).strict(),
  z.object({ type: z.literal("input_file"), file_id: z.string().optional(), filename: z.string().optional(), file_data: z.string().optional() }).strict(),
  z.object({ type: z.literal("input_audio"), data: z.string(), format: z.string().min(1) }).strict(),
  z.object({ type: z.literal("refusal"), refusal: z.string() }).strict(),
]);

const responsesMessageItemSchema = z
  .object({
    type: z.literal("message"),
    id: z.string().optional(),
    status: z.string().optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(responsesContentBlockSchema)]),
  })
  .strict();
const responsesPlainMessageItemSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(responsesContentBlockSchema)]),
  })
  .strict();
const responsesFunctionCallItemSchema = z
  .object({
    type: z.literal("function_call"),
    id: z.string().optional(),
    status: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string().min(1),
    arguments: z.union([z.string(), jsonValueSchema]).optional(),
  })
  .strict();
const responsesFunctionOutputItemSchema = z
  .object({
    type: z.literal("function_call_output"),
    id: z.string().optional(),
    call_id: z.string().optional(),
    output: jsonValueSchema,
  })
  .strict();
const responsesReasoningItemSchema = z
  .object({
    type: z.literal("reasoning"),
    id: z.string().optional(),
    status: z.string().optional(),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() }).strict()).optional(),
    encrypted_content: z.string().optional(),
  })
  .strict();
const responsesInputItemSchema = z.union([
  responsesMessageItemSchema,
  responsesPlainMessageItemSchema,
  responsesFunctionCallItemSchema,
  responsesFunctionOutputItemSchema,
  responsesReasoningItemSchema,
  responsesNativeItemSchema,
]);

const responsesFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: jsonObjectSchema.optional(),
    strict: z.boolean().optional(),
  })
  .strict();
const responsesBuiltinToolSchema = z
  .object({ type: z.string().min(1).max(128) })
  .catchall(jsonValueSchema)
  .refine((tool) => tool.type !== "function", { message: "Function tools require the typed function schema" });

const responsesToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({ type: z.literal("function"), name: z.string().min(1) }).strict(),
]);

export const responsesRequestSchema = z
  .object({
    model: modelSchema,
    instructions: z.union([z.string(), z.array(responsesContentBlockSchema)]).optional(),
    input: z.union([z.string(), z.array(responsesInputItemSchema)]),
    stream: z.boolean().optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    tools: z.array(z.union([responsesFunctionToolSchema, responsesBuiltinToolSchema])).optional(),
    tool_choice: responsesToolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: jsonObjectSchema.optional(),
    text: jsonObjectSchema.optional(),
    top_logprobs: z.number().int().nonnegative().optional(),
    presence_penalty: z.number().finite().optional(),
    frequency_penalty: z.number().finite().optional(),
    seed: z.number().int().optional(),
  })
  .catchall(jsonValueSchema);
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

const googleBlobSchema = z
  .object({
    mimeType: z.string().min(1).max(255),
    data: z.string().max(32 * 1024 * 1024),
    displayName: z.string().max(1024).optional(),
  })
  .catchall(jsonValueSchema);
const googleFileDataSchema = z
  .object({
    mimeType: z.string().min(1).max(255),
    fileUri: z.string().min(1).max(8192),
    displayName: z.string().max(1024).optional(),
  })
  .catchall(jsonValueSchema);
export const googlePartSchema = z
  .object({
    text: z.string().optional(),
    inlineData: googleBlobSchema.optional(),
    fileData: googleFileDataSchema.optional(),
    functionCall: z.object({
      id: z.string().max(512).optional(),
      name: z.string().min(1).max(256).optional(),
      args: jsonObjectSchema.optional(),
    }).catchall(jsonValueSchema).optional(),
    functionResponse: z.object({
      id: z.string().max(512).optional(),
      name: z.string().min(1).max(256).optional(),
      response: jsonObjectSchema.optional(),
      parts: z.array(jsonRecord).max(256).optional(),
      willContinue: z.boolean().optional(),
      scheduling: z.string().optional(),
    }).catchall(jsonValueSchema).optional(),
    executableCode: jsonObjectSchema.optional(),
    codeExecutionResult: jsonObjectSchema.optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().max(1024 * 1024).optional(),
    videoMetadata: jsonObjectSchema.optional(),
    mediaResolution: jsonObjectSchema.optional(),
  })
  .catchall(jsonValueSchema)
  .superRefine((part, context) => {
    const payloads = [
      part.text,
      part.inlineData,
      part.fileData,
      part.functionCall,
      part.functionResponse,
      part.executableCode,
      part.codeExecutionResult,
    ].filter((value) => value !== undefined);
    if (payloads.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Google content parts require exactly one payload field",
      });
    }
  });
export const googleContentSchema = z
  .object({
    role: z.enum(["user", "model"]).optional(),
    parts: z.array(googlePartSchema).max(4096).optional(),
  })
  .catchall(jsonValueSchema);

const googleGenerationConfigSchema = z
  .object({
    temperature: z.number().finite().optional(),
    topP: z.number().finite().optional(),
    topK: z.number().int().optional(),
    candidateCount: z.number().int().positive().max(16).optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    stopSequences: z.array(z.string()).max(64).optional(),
    responseLogprobs: z.boolean().optional(),
    logprobs: z.number().int().nonnegative().optional(),
    presencePenalty: z.number().finite().optional(),
    frequencyPenalty: z.number().finite().optional(),
    seed: z.number().int().optional(),
    responseMimeType: z.string().max(255).optional(),
    responseSchema: jsonValueSchema.optional(),
    responseJsonSchema: jsonValueSchema.optional(),
    thinkingConfig: jsonObjectSchema.optional(),
    responseModalities: z.array(z.string()).max(16).optional(),
    mediaResolution: z.string().optional(),
    speechConfig: jsonValueSchema.optional(),
    audioTimestamp: z.boolean().optional(),
    imageConfig: jsonObjectSchema.optional(),
  })
  .catchall(jsonValueSchema);

export const googleGenerateContentRequestSchema = z
  .object({
    // Pointer injects model and stream from the action route before normalization.
    model: modelSchema,
    stream: z.boolean().optional(),
    contents: z.array(googleContentSchema).min(1).max(4096),
    systemInstruction: googleContentSchema.optional(),
    tools: z.array(jsonRecord).max(256).optional(),
    toolConfig: jsonObjectSchema.optional(),
    safetySettings: z.array(jsonRecord).max(128).optional(),
    cachedContent: z.string().max(4096).optional(),
    generationConfig: googleGenerationConfigSchema.optional(),
    labels: z.record(z.string().max(1024)).optional(),
  })
  .catchall(jsonValueSchema);
export type GoogleGenerateContentRequest = z.infer<
  typeof googleGenerateContentRequestSchema
>;

export const publicRequestSchemaByFormat = {
  "chat-completions": chatCompletionsRequestSchema,
  messages: messagesRequestSchema,
  responses: responsesRequestSchema,
  "google-generate-content": googleGenerateContentRequestSchema,
} as const satisfies Record<GatewayApiFormat, z.ZodType>;

const chatResponseMessageSchema = z
  .object({
    role: z.enum(["assistant", "model"]),
    content: z.union([z.string(), z.null(), z.array(chatContentBlockSchema)]).optional(),
    name: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    reasoning: z.string().nullable().optional(),
    reasoning_details: z.array(jsonObjectSchema).nullable().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(chatToolCallSchema).nullable().optional(),
  })
  .catchall(jsonValueSchema);
const chatChoiceSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    message: chatResponseMessageSchema,
    finish_reason: z.string().nullable().optional(),
    logprobs: jsonValueSchema.optional(),
  })
  .catchall(jsonValueSchema);
const chatUsageSchema = z
  .object({
    prompt_tokens: usageIntegerSchema,
    completion_tokens: usageIntegerSchema,
    total_tokens: usageIntegerSchema.optional(),
    prompt_tokens_details: z.object({ cached_tokens: usageIntegerSchema.optional() }).catchall(jsonValueSchema).nullable().optional(),
    completion_tokens_details: z.object({ reasoning_tokens: usageIntegerSchema.optional() }).catchall(jsonValueSchema).nullable().optional(),
  })
  .catchall(jsonValueSchema);
export const chatCompletionsResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.string().optional(),
    model: modelSchema,
    choices: z.array(chatChoiceSchema).min(1),
    created: z.number().int().nonnegative().optional(),
    usage: chatUsageSchema.optional(),
  })
  .catchall(jsonValueSchema);

const messagesUsageSchema = z
  .object({
    input_tokens: usageIntegerSchema,
    output_tokens: usageIntegerSchema,
    cache_read_input_tokens: usageIntegerSchema.optional(),
    cache_creation_input_tokens: usageIntegerSchema.optional(),
    reasoning_tokens: usageIntegerSchema.optional(),
  })
  .strict();
export const messagesResponseSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    model: modelSchema,
    role: z.literal("assistant"),
    content: z.array(messagesAssistantContentBlockSchema),
    stop_reason: z.string().nullable().optional(),
    usage: messagesUsageSchema.optional(),
  })
  .catchall(jsonValueSchema);

const responsesOutputItemSchema = z.union([
  responsesMessageItemSchema,
  responsesFunctionCallItemSchema,
  responsesReasoningItemSchema,
  responsesNativeItemSchema,
  z.object({ type: z.literal("refusal"), id: z.string().optional(), refusal: z.string() }).strict(),
]);
const responsesUsageSchema = z
  .object({
    input_tokens: usageIntegerSchema,
    output_tokens: usageIntegerSchema,
    total_tokens: usageIntegerSchema.optional(),
    input_tokens_details: z.object({
      cached_tokens: usageIntegerSchema.optional(),
      cache_write_tokens: usageIntegerSchema.optional(),
    }).strict().optional(),
    output_tokens_details: z.object({ reasoning_tokens: usageIntegerSchema.optional() }).strict().optional(),
  })
  // Providers may report additional bounded usage dimensions. Pointer
  // normalizes the V1 token fields and safely ignores unmodeled extensions.
  .catchall(jsonValueSchema);
export const responsesResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.string().optional(),
    model: modelSchema,
    status: z.enum(["in_progress", "completed", "incomplete", "failed", "cancelled"]),
    output: z.array(responsesOutputItemSchema),
    created_at: z.number().int().nonnegative().optional(),
    usage: responsesUsageSchema.optional(),
  })
  .catchall(jsonValueSchema);

const googleCandidateSchema = z
  .object({
    content: googleContentSchema.optional(),
    finishReason: z.string().optional(),
    finishMessage: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    tokenCount: usageIntegerSchema.optional(),
    safetyRatings: z.array(jsonRecord).optional(),
    citationMetadata: jsonObjectSchema.optional(),
    groundingMetadata: jsonObjectSchema.optional(),
    urlContextMetadata: jsonObjectSchema.optional(),
    avgLogprobs: z.number().finite().optional(),
    logprobsResult: jsonObjectSchema.optional(),
  })
  .catchall(jsonValueSchema);
const googleUsageMetadataSchema = z
  .object({
    promptTokenCount: usageIntegerSchema.optional(),
    candidatesTokenCount: usageIntegerSchema.optional(),
    responseTokenCount: usageIntegerSchema.optional(),
    totalTokenCount: usageIntegerSchema.optional(),
    cachedContentTokenCount: usageIntegerSchema.optional(),
    thoughtsTokenCount: usageIntegerSchema.optional(),
    toolUsePromptTokenCount: usageIntegerSchema.optional(),
    promptTokensDetails: z.array(jsonRecord).optional(),
    cacheTokensDetails: z.array(jsonRecord).optional(),
    candidatesTokensDetails: z.array(jsonRecord).optional(),
    responseTokensDetails: z.array(jsonRecord).optional(),
    toolUsePromptTokensDetails: z.array(jsonRecord).optional(),
  })
  .catchall(jsonValueSchema);
export const googleGenerateContentResponseSchema = z
  .object({
    // Pointer injects the route model for IR normalization. It is never sent upstream.
    model: modelSchema,
    candidates: z.array(googleCandidateSchema).max(16).optional(),
    promptFeedback: jsonObjectSchema.optional(),
    usageMetadata: googleUsageMetadataSchema.optional(),
    modelVersion: z.string().optional(),
    responseId: z.string().optional(),
    createTime: z.string().optional(),
    automaticFunctionCallingHistory: z.array(googleContentSchema).optional(),
  })
  .catchall(jsonValueSchema);
export type GoogleGenerateContentResponse = z.infer<
  typeof googleGenerateContentResponseSchema
>;

export const publicResponseSchemaByFormat = {
  "chat-completions": chatCompletionsResponseSchema,
  messages: messagesResponseSchema,
  responses: responsesResponseSchema,
  "google-generate-content": googleGenerateContentResponseSchema,
} as const satisfies Record<GatewayApiFormat, z.ZodType>;

export const publicErrorEnvelopeSchema = z
  .object({ error: jsonObjectSchema })
  .catchall(jsonValueSchema);

export const publicStreamDataSchema = jsonRecord;
