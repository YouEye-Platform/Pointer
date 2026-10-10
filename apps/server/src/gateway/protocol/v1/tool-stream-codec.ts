import { isRecord } from "./common";
import type { ToolCodecContext, ToolIdentity } from "./tool-codec";
import { restoreResponseTools, codecIdentityKey } from "./tool-codec";
import type { JsonObject } from "./schemas";
import type { PublicStreamEvent } from "./stream";

/** Decode only complete string wrappers; never leak JSON fragments into raw custom input. */
export function createToolStreamCodec(context?: ToolCodecContext) {
  const calls = new Map<number, { identity: ToolIdentity; arguments: string; id?: string; callId?: string }>();
  return (event: PublicStreamEvent): PublicStreamEvent[] => {
    if (!context || !isRecord(event.data)) return [event];
    const data = event.data;
    const type = String(data.type ?? event.event ?? "");
    const index = typeof data.output_index === "number" ? data.output_index : -1;
    if (type === "response.output_item.added" && isRecord(data.item) && data.item.type === "function_call" && typeof data.item.name === "string") {
      const item = data.item;
      const identity = context.aliases[codecIdentityKey({name:String(item.name),...(typeof item.namespace === "string" ? {namespace:item.namespace} : {})})];
      if (!identity) return [event];
      calls.set(index, { identity, arguments: "", id: typeof item.id === "string" ? item.id : undefined, callId: typeof item.call_id === "string" ? item.call_id : undefined });
      const restored: JsonObject = { ...item, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}) } as JsonObject;
      if (identity.toolKind === "tool_search") { restored.type = "tool_search_call"; restored.arguments = {}; restored.execution = "client"; }
      if (identity.inputKind === "text") { restored.type = "custom_tool_call"; restored.input = ""; delete restored.arguments; }
      return [{ ...event, data: { ...data, item: restored } as JsonObject }];
    }
    const call = calls.get(index);
    if (call?.identity.inputKind === "text" && type === "response.function_call_arguments.delta") {
      if (typeof data.delta !== "string") throw new Error("Invalid custom argument fragment");
      call.arguments += data.delta;
      return [];
    }
    if (call?.identity.inputKind === "text" && type === "response.function_call_arguments.done") {
      const args: unknown = JSON.parse(typeof data.arguments === "string" ? data.arguments : call.arguments);
      if (!isRecord(args) || typeof args.input !== "string") throw new Error("Invalid bridged custom input");
      const common = { output_index: index, ...(call.id ? { item_id: call.id } : {}), ...(call.callId ? { call_id: call.callId } : {}) };
      return [
        { event: "response.custom_tool_call_input.delta", data: { ...common, type: "response.custom_tool_call_input.delta", delta: args.input } },
        { event: "response.custom_tool_call_input.done", data: { ...common, type: "response.custom_tool_call_input.done", input: args.input } },
      ];
    }
    if (type === "response.output_item.done" && isRecord(data.item)) {
      const restored = restoreResponseTools({ output: [data.item as JsonObject] }, context);
      return [{ ...event, data: { ...data, item: (restored.output as JsonObject[])[0]! } as JsonObject }];
    }
    if (isRecord(data.response)) return [{ ...event, data: { ...data, response: restoreResponseTools(data.response as JsonObject, context) } as JsonObject }];
    return [event];
  };
}
