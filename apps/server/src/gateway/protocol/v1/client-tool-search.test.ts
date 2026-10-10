import { expect, test } from "bun:test";
import { z } from "zod";
import type { GatewayApiFormat } from "../../compatibility";
import { EXTENDED_RESPONSES_CAPABILITIES, resolveWireCapabilities } from "../../wire-capabilities";
import { selectGatewayProxyRequest, selectGatewayProxyResponse } from "./runtime-proxy";

const parameters = {
  type: "object",
  properties: { goal: { type: "string" }, limit: { type: "integer", minimum: 1 } },
  required: ["goal", "limit"],
  additionalProperties: false,
};
const search = {
  type: "tool_search" as const, execution: "client" as const,
  description: "Discover project tools for the specified goal.", parameters,
};

// Check the emitted public declaration independently of Pointer's IR/parser.
// Client execution requires the caller's argument schema, unlike hosted search.
const clientSearchWire = z.object({
  type: z.literal("tool_search"), execution: z.literal("client"),
  description: z.string().optional(), parameters: z.record(z.unknown()),
}).strict();

for (const deferred of [false, true]) test(`client-search native declaration preserves its contract (${deferred ? "deferred" : "top"})`, () => {
  const payload = { model: "public", ...(deferred
    ? { input: [{ type: "additional_tools", role: "developer", tools: [search] }, { role: "user", content: "Find a tool." }] }
    : { input: "Find a tool.", tools: [search] }) };
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const declarations = deferred ? (selected.request.input as any[])[0].tools : selected.request.tools as any[];
  expect(clientSearchWire.parse(declarations[0])).toEqual(search);
  expect(declarations).toHaveLength(1);
});

for (const format of ["responses", "chat-completions", "messages", "google-generate-content"] as GatewayApiFormat[]) test(`client-search lowering preserves caller arguments through ${format}`, () => {
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: format, providerModelId: "provider", payload: { model: "public", input: "Find a tool.", tools: [search] }, wireCapabilities: resolveWireCapabilities(format) });
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const declaration = (selected.request.tools as any[])[0];
  const lowered = format === "chat-completions" ? declaration.function
    : format === "google-generate-content" ? declaration.functionDeclarations[0] : declaration;
  expect(lowered.description).toBe(search.description);
  expect(format === "messages" ? lowered.input_schema
    : format === "google-generate-content" ? lowered.parametersJsonSchema : lowered.parameters).toEqual(parameters);
  const returned = selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat: "responses", model: "public", toolContext: selected.toolContext,
    payload: { id: "response", model: "provider", status: "completed", output: [{ type: "function_call", name: lowered.name, call_id: "search1", arguments: JSON.stringify({ goal: "Find lookup", limit: 2 }) }] } });
  expect(returned.ok).toBe(true); if (!returned.ok) return;
  expect(returned.response.output).toMatchObject([{ type: "tool_search_call", execution: "client", call_id: "search1", arguments: { goal: "Find lookup", limit: 2 } }]);
});

test("client search, ordinary functions and custom grammar retain separate declarations", () => {
  const ordinary = { type: "function", name: "lookup", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, strict: true };
  const custom = { type: "custom", name: "inert_text", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } };
  const tools = [ordinary, search, custom];
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input: "Find a tool.", tools }, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
  expect(selected.ok).toBe(true); if (selected.ok) expect(selected.request.tools).toEqual(tools);
});

for (const invalid of [undefined, null, [], "invalid", 3]) test(`client search rejects absent or invalid parameter schema (${JSON.stringify(invalid)})`, () => {
  const declaration = { ...search, parameters: invalid };
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input: "Find a tool.", tools: [declaration] }, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
  expect(selected.ok).toBe(false);
});

test("native client-search discovery and result history preserve argument and call identity", () => {
  const discovered = { type: "function", name: "lookup", defer_loading: true, parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } };
  const input = [
    { type: "tool_search_call", execution: "client", call_id: "search1", arguments: { goal: "Find lookup", limit: 2 } },
    { type: "tool_search_output", execution: "client", call_id: "search1", tools: [discovered] },
    { type: "function_call", name: "lookup", call_id: "lookup1", arguments: '{"id":"record1"}' },
    { type: "function_call_output", call_id: "lookup1", output: "Diagnostic record." },
    { role: "user", content: "Report the record." },
  ];
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input, tools: [search] }, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  expect(selected.request.tools).toEqual([search]);
  expect((selected.request.input as any[]).slice(0, 4)).toEqual(input.slice(0, 4));
});
