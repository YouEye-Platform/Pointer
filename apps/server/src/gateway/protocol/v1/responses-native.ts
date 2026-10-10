import { z } from "zod";
import { jsonValueSchema, type JsonObject, type IrContentBlock } from "./schemas";

const indexSchema = z.number().int().nonnegative();
export const responseAnnotationSchema = z.union([
  z.object({ type: z.literal("url_citation"), url: z.string(), title: z.string(), start_index: indexSchema, end_index: indexSchema }).catchall(jsonValueSchema),
  z.object({ type: z.literal("file_citation"), file_id: z.string(), filename: z.string(), index: indexSchema }).catchall(jsonValueSchema),
  z.object({ type: z.literal("container_file_citation"), container_id: z.string(), file_id: z.string(), filename: z.string(), start_index: indexSchema, end_index: indexSchema }).catchall(jsonValueSchema),
  z.object({ type: z.literal("file_path"), file_id: z.string(), index: indexSchema }).catchall(jsonValueSchema),
]);
export const responseTextPartSchema = z.object({ type: z.literal("output_text"), text: z.string(), annotations: z.array(responseAnnotationSchema).optional() }).catchall(jsonValueSchema);
export const responseContentPartSchema = z.union([responseTextPartSchema, z.object({ type: z.literal("refusal"), refusal: z.string() }).catchall(jsonValueSchema)]);
export const responseMessageSchema = z.object({ type: z.literal("message"), id: z.string().min(1), role: z.literal("assistant"),
  phase: z.enum(["commentary", "final_answer"]).optional(), content: z.array(responseContentPartSchema) }).catchall(jsonValueSchema);

/** Ordinary messages remain portable in semantic conversion; preserve them only on native streams. */
export function streamResponseItem(value: unknown, preserveMessages: boolean): JsonObject | null {
  if (preserveMessages && typeof value === "object" && value !== null && (value as Record<string, unknown>).type === "message") {
    const parsed = responseMessageSchema.safeParse(value);
    return parsed.success ? parsed.data as JsonObject : null;
  }
  return nativeResponseItem(value, false);
}

// Existing allowlisted response metadata is shared by JSON and streamed terminals.
export const RESPONSES_RESPONSE_METADATA_KEYS = new Set([
  "created_at", "usage", "background", "completed_at", "error", "frequency_penalty",
  "incomplete_details", "instructions", "max_output_tokens", "max_tool_calls",
  "metadata", "moderation", "parallel_tool_calls", "presence_penalty",
  "previous_response_id", "prompt_cache_key", "prompt_cache_retention", "reasoning",
  "safety_identifier", "service_tier", "store", "temperature", "text", "tool_choice",
  "tool_usage", "tools", "top_logprobs", "top_p", "truncation", "user",
]);

// Protocol-scoped items have no lossless equivalent on other API families.
// Keep their exact JSON (including deferred tool definitions) within Responses.
export const responsesNativeItemSchema = z.union([
  z.object({ type: z.literal("message"), role: z.literal("assistant"),
    phase: z.enum(["commentary", "final_answer"]), content: z.union([z.string(), z.array(jsonValueSchema)]) }).catchall(jsonValueSchema),
  z.object({ type: z.literal("additional_tools"), tools: z.array(jsonValueSchema),
    role: z.enum(["system", "developer"]).optional(), id: z.string().optional() }).catchall(jsonValueSchema),
  z.object({ type: z.literal("tool_search_call"), arguments: jsonValueSchema,
    call_id: z.string().nullable().optional(), execution: z.enum(["client", "server"]).optional() }).catchall(jsonValueSchema),
  z.object({ type: z.literal("tool_search_output"), tools: z.array(jsonValueSchema),
    call_id: z.string().nullable().optional(), execution: z.enum(["client", "server"]).optional() }).catchall(jsonValueSchema),
  z.object({ type: z.literal("custom_tool_call"), call_id: z.string(), name: z.string().min(1), input: z.string() }).catchall(jsonValueSchema),
  z.object({ type: z.literal("custom_tool_call_output"), call_id: z.string(), output: jsonValueSchema }).catchall(jsonValueSchema),
  z.object({ type: z.literal("web_search_call"), id: z.string(), status: z.string() }).catchall(jsonValueSchema),
  z.object({ type: z.literal("function_call"), namespace: z.string(), call_id: z.string(), name: z.string().min(1), arguments: z.string() }).catchall(jsonValueSchema),
]);

export function nativeResponseItem(value: unknown, semantic = true): JsonObject | null {
  if (semantic && typeof value === "object" && value !== null && ["additional_tools", "custom_tool_call", "custom_tool_call_output", "function_call"].includes(String((value as Record<string,unknown>).type))) return null;
  const parsed = responsesNativeItemSchema.safeParse(value);
  return parsed.success ? parsed.data as JsonObject : null;
}
export function nativeResponseBlock(value: JsonObject): IrContentBlock {
  return { type: "extension", extension: { namespace: "responses", key: "output_item", value } };
}
export function responseItemFromBlock(block: IrContentBlock): JsonObject | null {
  return block.type === "extension" && block.extension.namespace === "responses" && block.extension.key === "output_item"
    ? nativeResponseItem(block.extension.value) : null;
}

export const NATIVE_RESPONSE_EVENTS = new Set([
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.tool_search_call.in_progress", "response.tool_search_call.searching", "response.tool_search_call.completed",
  "response.web_search_call.in_progress", "response.web_search_call.searching", "response.web_search_call.completed",
]);
