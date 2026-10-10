import { createHash } from "node:crypto";
import type { GatewayApiFormat } from "../../compatibility";
import type { WireCapabilities } from "../../wire-capabilities";
import type { IrRequest, IrTool, IrContentBlock, IrResponse, JsonObject } from "./schemas";
import { isRecord } from "./common";

export type FunctionTool = Extract<IrTool, { type: "function" }>;
export interface ToolIdentity {
  name: string;
  namespace?: string;
  inputKind?: "json" | "text";
  toolKind?: "tool_search";
}
export interface ToolCodecContext {
  aliases: Readonly<Record<string, ToolIdentity>>;
  grammarPrompted: boolean;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const identityKey = (tool: ToolIdentity) => JSON.stringify([tool.namespace ?? "", tool.name]);
export const codecIdentityKey = (tool: ToolIdentity) => tool.namespace ? `namespace:${identityKey(tool)}` : tool.name;

export function semanticResponseTools(
  value: unknown,
  declarationSource: "top" | "deferred" = "top",
): IrTool[] {
  if (!Array.isArray(value)) return [];
  const result: IrTool[] = [];
  for (const tool of value) {
    if (!isRecord(tool) || typeof tool.type !== "string") throw new Error("Invalid tool declaration");
    if (tool.type === "namespace") {
      if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) throw new Error("Invalid tool namespace");
      for (const child of semanticResponseTools(tool.tools, declarationSource)) {
        if (child.type !== "function" || child.namespace) throw new Error("Unsupported nested tool namespace");
        result.push({ ...child, namespace: tool.name,
          ...(typeof tool.description === "string" ? { namespaceDescription: tool.description } : {}) });
      }
    } else if (tool.type === "tool_search" && tool.execution === "client") {
      if (!isRecord(tool.parameters)) throw new Error("Client tool search requires an argument schema");
      result.push({ type: "function", name: "tool_search", toolKind: "tool_search",
        parameters: tool.parameters as JsonObject,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}), declarationSource });
    } else if (tool.type === "function" || tool.type === "custom") {
      if (typeof tool.name !== "string" || !tool.name) throw new Error("Invalid tool name");
      if (tool.type === "function" && tool.parameters !== undefined && !isRecord(tool.parameters)) throw new Error("Invalid tool parameters");
      result.push({ type: "function", name: tool.name,
        parameters: tool.type === "custom"
          ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
          : (tool.parameters ?? {}) as JsonObject,
        ...(tool.type === "custom" ? { inputKind: "text" as const } : {}),
        ...(isRecord(tool.format) ? { format: tool.format as JsonObject } : {}),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}), ...(typeof tool.defer_loading === "boolean" ? { deferLoading: tool.defer_loading } : {}), declarationSource });
    } else {
      const { type, ...configuration } = tool;
      result.push({ type: "builtin", name: type, configuration: configuration as JsonObject });
    }
  }
  return result;
}

export function deduplicateTools(tools: IrTool[]): IrTool[] {
  const unique = new Map<string, IrTool>();
  for (const tool of tools) {
    const key = tool.type === "function" ? identityKey(tool) : `builtin:${tool.name}`;
    const prior = unique.get(key);
    if (!prior) { unique.set(key, tool); continue; }
    const comparable = (value: IrTool) => {
      const copy = { ...value };
      if (copy.type === "function") delete copy.declarationSource;
      return stableJson(copy);
    };
    if (comparable(prior) !== comparable(tool)) throw new Error("Conflicting tool declarations");
  }
  return [...unique.values()];
}

/** Current declarations outrank historical schemas; otherwise the latest
 * historical revision is callable. Each history block remains untouched. */
export function resolveToolCatalog(current: IrTool[], history: IrTool[][]): IrTool[] {
  const key = (tool: IrTool) => tool.type === "function" ? identityKey(tool) : `builtin:${tool.name}`;
  const catalog = new Map(deduplicateTools(current).map(tool => [key(tool), tool]));
  const currentKeys = new Set(catalog.keys());
  for (const declarations of history) for (const tool of deduplicateTools(declarations)) {
    const prior = catalog.get(key(tool));
    if (prior?.type === "function" && tool.type === "function"
      && ((prior.inputKind ?? "json") !== (tool.inputKind ?? "json") || prior.toolKind !== tool.toolKind)) {
      throw new Error("Conflicting tool identity kinds");
    }
    if (!currentKeys.has(key(tool))) catalog.set(key(tool), tool);
  }
  return [...catalog.values()];
}

export function emitResponseTools(tools: readonly IrTool[]): JsonObject[] {
  const result: JsonObject[] = [];
  const namespaces = new Map<string, JsonObject>();
  for (const tool of tools) {
    if (tool.type === "builtin") { result.push({ type: tool.name === "googleSearch" ? "web_search" : tool.name, ...tool.configuration }); continue; }
    if (tool.toolKind === "tool_search") {
      result.push({ type: "tool_search", execution: "client", parameters: tool.parameters,
        ...(tool.description !== undefined ? { description: tool.description } : {}) });
      continue;
    }
    const definition: JsonObject = { type: tool.inputKind === "text" ? "custom" : "function", name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputKind === "text" ? (tool.format ? { format: tool.format } : {}) : { parameters: tool.parameters }),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}), ...(tool.deferLoading !== undefined ? { defer_loading: tool.deferLoading } : {}) };
    if (!tool.namespace) { result.push(definition); continue; }
    let group = namespaces.get(tool.namespace);
    if (!group) {
      group = { type: "namespace", name: tool.namespace, ...(tool.namespaceDescription !== undefined ? { description: tool.namespaceDescription } : {}), tools: [] };
      namespaces.set(tool.namespace, group); result.push(group);
    }
    (group.tools as JsonObject[]).push(definition);
  }
  return result;
}

/** Lower once, then use the same identity table for history, tool choice and return events. */
export function prepareToolCodec(request: IrRequest, target: GatewayApiFormat, caps: WireCapabilities): { request: IrRequest; context: ToolCodecContext } {
  const aliases: Record<string, ToolIdentity> = Object.create(null);
  const names = new Map<string, string>();
  const allocated = new Set<string>();
  let grammarPrompted = false;
  const definitions = deduplicateTools(request.tools);
  // Reserve all already-valid names before assigning synthetic aliases.
  for (const tool of definitions) if (tool.type === "function" && !tool.namespace && /^[A-Za-z0-9_-]+$/.test(tool.name) && tool.name.length <= caps.toolNameMaxLength) allocated.add(tool.name);
  const alias = (tool: ToolIdentity) => {
    const key = identityKey(tool);
    const existing = names.get(key); if (existing) return existing;
    if (caps.namespaceTools && target === "responses") {
      names.set(key, tool.name);
      aliases[codecIdentityKey(tool)] = { name: tool.name, ...(tool.namespace ? {namespace:tool.namespace} : {}), ...(tool.inputKind ? {inputKind:tool.inputKind} : {}), ...(tool.toolKind ? {toolKind:tool.toolKind} : {}) };
      return tool.name;
    }
    let name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    const nativeName = name;
    name = name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (name.length > caps.toolNameMaxLength || (tool.namespace && allocated.has(name)) || name !== nativeName) {
      const hash = createHash("sha256").update(key).digest("hex").slice(0,12);
      name = `t_${hash}_${name.slice(0, caps.toolNameMaxLength - 15)}`;
    }
    if (aliases[name] && identityKey(aliases[name]) !== key) throw new Error("Ambiguous tool alias");
    allocated.add(name); aliases[name] = { name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), ...(tool.inputKind ? { inputKind: tool.inputKind } : {}), ...(tool.toolKind ? {toolKind:tool.toolKind} : {}) };
    names.set(key, name); return name;
  };
  const lookup = (tool: ToolIdentity): FunctionTool | undefined => {
    const exact = definitions.find(t => t.type === "function" && identityKey(t) === identityKey(tool));
    if (exact?.type === "function") return exact;
    const candidates = definitions.filter((t): t is FunctionTool => t.type === "function" && t.name === tool.name);
    if (candidates.length === 1 && !tool.namespace) return candidates[0];
    if (candidates.length > 1) throw new Error("Ambiguous tool identity");
    return undefined;
  };
  const lowerTool = (tool: IrTool): IrTool => {
    if (tool.type !== "function") { if (["web_search", "web_search_preview", "googleSearch"].includes(tool.name) && !caps.webSearch) throw new Error("Hosted web search is unsupported on this endpoint"); if (tool.name === "tool_search" && !caps.toolSearch) throw new Error("Server tool search is unsupported on this endpoint"); return tool; }
    const name = alias(tool);
    const nativeCustom = caps.customTools && target === "responses";
    const lowered = { ...tool, name };
    if (!caps.toolSearch) delete lowered.toolKind;
    if (!caps.namespaceTools) {
      delete lowered.namespace;
      lowered.description = [tool.namespaceDescription, tool.description].filter(Boolean).join("\n\n");
      delete lowered.namespaceDescription;
    }
    if (tool.inputKind === "text" && !nativeCustom) {
      delete lowered.inputKind; delete lowered.format;
      if (tool.format) {
        grammarPrompted = true;
        lowered.description = `${lowered.description ?? ""}\n\nReturn the raw input string following this format. This endpoint does not enforce the grammar:\n${String(tool.format.definition ?? "")}`;
      }
    }
    if (tool.format && nativeCustom && !caps.grammar) {
      delete lowered.format;
      grammarPrompted = true;
      lowered.description = `${lowered.description ?? ""}\n\nRequested format (grammar enforcement unavailable):\n${String(tool.format.definition ?? "")}`;
    }
    if (!caps.additionalTools) { delete lowered.declarationSource; delete lowered.deferLoading; }
    if (lowered.description === "" && !caps.namespaceTools) delete lowered.description;
    return lowered;
  };
  const loweredTools = definitions.map(lowerTool);
  const emittedDeclarations = new Set<string>();
  const turns = request.turns.map(turn => ({ ...turn, blocks: turn.blocks.flatMap<IrContentBlock>(block => {
    if (block.type === "tool_declaration") {
      if (caps.additionalTools) {
        const normalized = semanticResponseTools(block.tools, "deferred").filter(tool => {
          // A search result is the answer to this call, even when its schemas
          // already appeared in a catalog or an earlier result. Deduplicating
          // across history falsely turns successful repeat searches into []
          // and tells the model that the tools are unavailable on continuation.
          if (block.source === "tool_search_output") return true;
          const key = tool.type === "function" ? identityKey(tool) : `builtin:${tool.name}`;
          const original = definitions.find(value => value.type === "function" && tool.type === "function" && identityKey(value) === key);
          if ((original?.type === "function" && original.declarationSource === "top") || emittedDeclarations.has(key)) return false;
          emittedDeclarations.add(key);
          return true;
        }).map(lowerTool);
        return [{ ...block, tools: emitResponseTools(normalized) }];
      }
      if (block.source === "tool_search_output") {
        if (!block.callId) throw new Error("Unpaired deferred tool result");
        return [{ type: "tool_result", callId: block.callId, output: { tools: block.tools }, isError: false }];
      }
      return [];
    }
    if (block.type !== "tool_call") return [block];
    const original = lookup(block) ?? block;
    const value = { ...block, name: alias(original) };
    if (!caps.namespaceTools) delete value.namespace;
    if (!caps.customTools) delete value.inputKind;
    if (!caps.toolSearch) { delete value.toolKind; if (block.toolKind === "tool_search") delete value.providerMetadata; }
    return [value];
  }) })).map(turn => ({ ...turn, role: turn.blocks.every(b => b.type === "tool_result") ? "tool" as const : turn.role })).filter(turn => turn.blocks.length > 0);
  let toolChoice = request.toolChoice;
  if (toolChoice?.type === "function") {
    const original = lookup(toolChoice) ?? toolChoice;
    toolChoice = { ...toolChoice, name: alias(original) };
    if (!caps.namespaceTools) delete toolChoice.namespace;
    if (!caps.customTools) delete toolChoice.inputKind;
  }
  // Output markers follow the paired call even when declaration capabilities differ.
  const customCalls = new Set(turns.flatMap(t=>t.blocks).filter(b=>b.type === "tool_call" && b.inputKind === "text").map(b=>b.type === "tool_call" ? b.id : ""));
  for (const turn of turns) for (const block of turn.blocks) if (block.type === "tool_result" && (!caps.customTools || !customCalls.has(block.callId))) delete block.inputKind;
  return { request: { ...request, tools: loweredTools, turns, ...(toolChoice ? { toolChoice } : {}) }, context: { aliases, grammarPrompted } };
}

export function restoreResponseTools(payload: JsonObject, context?: ToolCodecContext): JsonObject {
  if (!context || !Array.isArray(payload.output)) return payload;
  return { ...payload, output: payload.output.map(item => {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") return item as JsonObject;
    const identity = context.aliases[codecIdentityKey({name:item.name, ...(typeof item.namespace === "string" ? {namespace:item.namespace} : {})})]; if (!identity) return item as JsonObject;
    const restored: JsonObject = { ...item, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}) } as JsonObject;
    if (identity.toolKind === "tool_search") { restored.type = "tool_search_call"; restored.arguments = JSON.parse(String(item.arguments ?? "{}")); restored.execution = "client"; }
    if (identity.inputKind === "text") {
      const args = JSON.parse(String(item.arguments ?? "{}"));
      if (!isRecord(args) || typeof args.input !== "string") throw new Error("Invalid bridged custom input");
      restored.type = "custom_tool_call"; restored.input = args.input; delete restored.arguments;
    }
    return restored;
  }) as JsonObject[] };
}

/** Restore semantic identities before rendering a response into any public protocol. */
export function restoreIrTools(response: IrResponse, context?: ToolCodecContext): IrResponse {
  if (!context) return response;
  return { ...response, output: response.output.map(block => {
    if (block.type !== "tool_call") return block;
    const identity = context.aliases[codecIdentityKey(block)];
    if (!identity) return block;
    if (identity.inputKind === "text" && (!isRecord(block.arguments) || typeof block.arguments.input !== "string")) throw new Error("Invalid bridged custom input");
    return { ...block, ...identity,
      ...(identity.toolKind === "tool_search"
        ? { providerMetadata: { ...block.providerMetadata, execution: "client" } } : {}) };
  }) };
}
