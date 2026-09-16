import { z } from "zod";
import { jsonValueSchema, type JsonObject, type IrContentBlock } from "./schemas";

// Protocol-scoped items have no lossless equivalent on other API families.
// Keep their exact JSON (including deferred tool definitions) within Responses.
export const responsesNativeItemSchema = z.union([
  z.object({ type: z.literal("message"), role: z.literal("assistant"),
    phase: z.enum(["commentary", "final_answer"]), content: z.array(jsonValueSchema) }).catchall(jsonValueSchema),
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

export function nativeResponseItem(value: unknown): JsonObject | null {
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
