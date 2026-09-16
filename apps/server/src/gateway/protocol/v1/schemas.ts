import { z } from "zod";
import {
  compatibilityErrorCodeSchema,
  compatibilityPolicySchema,
  featureCompatibilitySchema,
  gatewayApiFormatSchema,
  safeUpstreamDiagnosticSchema,
} from "../../compatibility";

export const GATEWAY_IR_NAME = "pointer.gateway.ir" as const;
export const GATEWAY_IR_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema);

const nonEmptyStringSchema = z.string().min(1).max(4096);
const stableIdSchema = z.string().min(1).max(512);
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const irCompatibilityFindingSchema = z
  .object({
    assessment: featureCompatibilitySchema,
    detailCode: z.string().regex(/^pointer_[a-z0-9_]+$/).max(128),
    sourceFormat: gatewayApiFormatSchema,
    targetFormat: gatewayApiFormatSchema.optional(),
  })
  .strict();
export type IrCompatibilityFinding = z.infer<
  typeof irCompatibilityFindingSchema
>;

export const providerExtensionSchema = z
  .object({
    namespace: gatewayApiFormatSchema,
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    value: jsonValueSchema,
  })
  .strict();
export type ProviderExtension = z.infer<typeof providerExtensionSchema>;

const cacheControlSchema = z
  .object({
    type: z.literal("ephemeral"),
    ttl: z.string().optional(),
  })
  .strict();

export const irTextBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    id: stableIdSchema.optional(),
    cacheControl: cacheControlSchema.optional(),
    annotations: z.array(jsonValueSchema).optional(),
  })
  .strict();

export const irImageSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("base64"),
      mediaType: z.string().min(1),
      data: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("file"), fileId: stableIdSchema }).strict(),
]);

export const irImageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: irImageSourceSchema,
    detail: z.enum(["auto", "low", "high"]).optional(),
    id: stableIdSchema.optional(),
    cacheControl: cacheControlSchema.optional(),
  })
  .strict();

export const irAudioBlockSchema = z
  .object({
    type: z.literal("audio"),
    data: z.string(),
    format: nonEmptyStringSchema,
    id: stableIdSchema.optional(),
  })
  .strict();

export const irFileBlockSchema = z
  .object({
    type: z.literal("file"),
    fileId: stableIdSchema.optional(),
    filename: z.string().min(1).optional(),
    data: z.string().optional(),
    id: stableIdSchema.optional(),
  })
  .strict();

export const irReasoningBlockSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string(),
    id: stableIdSchema.optional(),
    signature: z.string().optional(),
    encryptedContent: z.string().optional(),
  })
  .strict();

export const irRefusalBlockSchema = z
  .object({
    type: z.literal("refusal"),
    text: z.string(),
    id: stableIdSchema.optional(),
  })
  .strict();

export const irToolCallBlockSchema = z
  .object({
    type: z.literal("tool_call"),
    id: stableIdSchema,
    name: nonEmptyStringSchema,
    arguments: jsonValueSchema,
    rawArguments: z.string().optional(),
    itemId: stableIdSchema.optional(),
    cacheControl: cacheControlSchema.optional(),
    providerMetadata: jsonObjectSchema.optional(),
  })
  .strict();

export const irToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    callId: stableIdSchema,
    output: jsonValueSchema,
    isError: z.boolean().default(false),
    id: stableIdSchema.optional(),
    cacheControl: cacheControlSchema.optional(),
  })
  .strict();

export const irExtensionBlockSchema = z
  .object({
    type: z.literal("extension"),
    extension: providerExtensionSchema,
    id: stableIdSchema.optional(),
  })
  .strict();

export const irContentBlockSchema = z.discriminatedUnion("type", [
  irTextBlockSchema,
  irImageBlockSchema,
  irAudioBlockSchema,
  irFileBlockSchema,
  irReasoningBlockSchema,
  irRefusalBlockSchema,
  irToolCallBlockSchema,
  irToolResultBlockSchema,
  irExtensionBlockSchema,
]);
export type IrContentBlock = z.infer<typeof irContentBlockSchema>;

export const irTurnSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    blocks: z.array(irContentBlockSchema),
    name: z.string().min(1).optional(),
  })
  .strict();
export type IrTurn = z.infer<typeof irTurnSchema>;

export const irFunctionToolSchema = z
  .object({
    type: z.literal("function"),
    name: nonEmptyStringSchema,
    description: z.string().optional(),
    parameters: jsonObjectSchema,
    strict: z.boolean().optional(),
    cacheControl: cacheControlSchema.optional(),
  })
  .strict();

export const irBuiltinToolSchema = z
  .object({
    type: z.literal("builtin"),
    name: nonEmptyStringSchema,
    configuration: jsonObjectSchema,
  })
  .strict();

export const irToolSchema = z.discriminatedUnion("type", [
  irFunctionToolSchema,
  irBuiltinToolSchema,
]);
export type IrTool = z.infer<typeof irToolSchema>;

export const irToolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }).strict(),
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("required") }).strict(),
  z
    .object({ type: z.literal("function"), name: nonEmptyStringSchema })
    .strict(),
]);
export type IrToolChoice = z.infer<typeof irToolChoiceSchema>;

export const irReasoningControlSchema = z
  .object({
    enabled: z.boolean(),
    adaptive: z.boolean().optional(),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    budgetTokens: nonNegativeIntegerSchema.optional(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
  })
  .strict();

export const irSamplingSchema = z
  .object({
    temperature: z.number().finite().optional(),
    topP: z.number().finite().optional(),
    topK: z.number().int().optional(),
    candidateCount: z.number().int().positive().max(16).optional(),
    maxOutputTokens: nonNegativeIntegerSchema.optional(),
    stopSequences: z.array(z.string()).optional(),
    responseLogprobs: z.boolean().optional(),
    logprobs: nonNegativeIntegerSchema.optional(),
    presencePenalty: z.number().finite().optional(),
    frequencyPenalty: z.number().finite().optional(),
    seed: z.number().int().optional(),
  })
  .strict();

export const irResponseFormatSchema = z
  .object({
    type: z.enum(["text", "json_object", "json_schema"]),
    mimeType: z.string().min(1).max(255).optional(),
    name: z.string().min(1).max(256).optional(),
    schema: jsonValueSchema.optional(),
    strict: z.boolean().optional(),
  })
  .strict();

const irEnvelopeFields = {
  protocol: z.literal(GATEWAY_IR_NAME),
  version: z.literal(GATEWAY_IR_VERSION),
  sourceFormat: gatewayApiFormatSchema,
  compatibilityPolicy: compatibilityPolicySchema,
  compatibility: z.array(irCompatibilityFindingSchema),
  extensions: z.array(providerExtensionSchema),
};

export const irRequestSchema = z
  .object({
    ...irEnvelopeFields,
    kind: z.literal("request"),
    model: nonEmptyStringSchema,
    stream: z.boolean(),
    instructions: z.array(irContentBlockSchema),
    turns: z.array(irTurnSchema),
    tools: z.array(irToolSchema),
    toolChoice: irToolChoiceSchema.optional(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: irReasoningControlSchema.optional(),
    outputEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    responseFormat: irResponseFormatSchema.optional(),
    sampling: irSamplingSchema,
  })
  .strict();
export type IrRequest = z.infer<typeof irRequestSchema>;

export const irFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "error",
  "cancelled",
  "unknown",
]);
export type IrFinishReason = z.infer<typeof irFinishReasonSchema>;

export const irUsageSchema = z
  .object({
    inputTokens: nonNegativeIntegerSchema,
    outputTokens: nonNegativeIntegerSchema,
    totalTokens: nonNegativeIntegerSchema,
    cachedInputTokens: nonNegativeIntegerSchema.optional(),
    cacheCreationInputTokens: nonNegativeIntegerSchema.optional(),
    reasoningTokens: nonNegativeIntegerSchema.optional(),
  })
  .strict()
  .refine((usage) => usage.totalTokens >= usage.inputTokens + usage.outputTokens, {
    message: "totalTokens cannot be less than inputTokens + outputTokens",
  });
export type IrUsage = z.infer<typeof irUsageSchema>;

export const irResponseSchema = z
  .object({
    ...irEnvelopeFields,
    kind: z.literal("response"),
    id: stableIdSchema,
    model: nonEmptyStringSchema,
    createdAt: nonNegativeIntegerSchema.optional(),
    status: z.enum(["in_progress", "completed", "incomplete", "failed", "cancelled"]),
    output: z.array(irContentBlockSchema),
    finishReason: irFinishReasonSchema,
    rawFinishReason: z.string().optional(),
    usage: irUsageSchema.optional(),
  })
  .strict();
export type IrResponse = z.infer<typeof irResponseSchema>;

export const irErrorSchema = z
  .object({
    ...irEnvelopeFields,
    kind: z.literal("error"),
    status: z.number().int().min(100).max(599),
    type: z.literal("pointer_gateway_error"),
    code: compatibilityErrorCodeSchema,
    message: z.string().min(1),
    param: z.string().nullable().optional(),
    retryAfterMs: nonNegativeIntegerSchema.optional(),
    diagnostics: safeUpstreamDiagnosticSchema.optional(),
  })
  .strict();
export type IrError = z.infer<typeof irErrorSchema>;

const irEventBaseFields = {
  protocol: z.literal(GATEWAY_IR_NAME),
  version: z.literal(GATEWAY_IR_VERSION),
  sourceFormat: gatewayApiFormatSchema,
  responseId: stableIdSchema,
  model: nonEmptyStringSchema,
  sequence: nonNegativeIntegerSchema,
};

export const irStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ ...irEventBaseFields, type: z.literal("responses_native_event"), event: z.string(), data: jsonObjectSchema }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("response_start") }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("content_start"), index: nonNegativeIntegerSchema, block: irContentBlockSchema }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("text_delta"), index: nonNegativeIntegerSchema, delta: z.string() }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("reasoning_delta"), index: nonNegativeIntegerSchema, delta: z.string() }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("tool_call_start"), index: nonNegativeIntegerSchema, callId: stableIdSchema, itemId: stableIdSchema.optional(), name: nonEmptyStringSchema, providerMetadata: jsonObjectSchema.optional() }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("tool_arguments_delta"), index: nonNegativeIntegerSchema, callId: stableIdSchema, delta: z.string() }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("content_end"), index: nonNegativeIntegerSchema }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("usage"), usage: irUsageSchema }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("response_end"), finishReason: irFinishReasonSchema, rawFinishReason: z.string().optional() }).strict(),
  z.object({ ...irEventBaseFields, type: z.literal("error"), error: irErrorSchema }).strict(),
]);
export type IrStreamEvent = z.infer<typeof irStreamEventSchema>;

export const irEnvelopeSchema = z.discriminatedUnion("kind", [
  irRequestSchema,
  irResponseSchema,
  irErrorSchema,
]);
export type IrEnvelope = z.infer<typeof irEnvelopeSchema>;

export const gatewayAdapterModeSchema = compatibilityPolicySchema;
export type GatewayAdapterMode = z.infer<typeof gatewayAdapterModeSchema>;

export const gatewayAdapterFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: compatibilityErrorCodeSchema,
        message: z.string().min(1),
        format: gatewayApiFormatSchema,
        issues: z.array(
          z.object({ path: z.string(), message: z.string() }).strict(),
        ),
        findings: z.array(irCompatibilityFindingSchema),
      })
      .strict(),
  })
  .strict();
export type GatewayAdapterFailure = z.infer<
  typeof gatewayAdapterFailureSchema
>;

export interface GatewayAdapterSuccess<T> {
  ok: true;
  value: T;
  findings: IrCompatibilityFinding[];
}

export type GatewayAdapterResult<T> =
  | GatewayAdapterSuccess<T>
  | GatewayAdapterFailure;
