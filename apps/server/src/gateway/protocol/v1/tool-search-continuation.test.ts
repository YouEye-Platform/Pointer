import { expect, test } from "bun:test";
import { EXTENDED_RESPONSES_CAPABILITIES } from "../../wire-capabilities";
import { resolveWireCapabilities } from "../../wire-capabilities";
import { parsePublicRequest } from "./adapters";
import { requestFailureShapes, selectGatewayProxyRequest } from "./runtime-proxy";

const search = { type: "tool_search", execution: "client", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
const read = { type: "function", name: "read_record", description: "Read a record", defer_loading: true, strict: false, parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } };
const write = { ...read, name: "save_record", description: "Save a record" };
const group = (tools: unknown[]) => [{ type: "namespace", name: "records", description: "Record tools", tools }];
const pair = (id: string, tools: unknown[], status = "completed") => [
  { type: "tool_search_call", execution: "client", call_id: id, arguments: { query: "record" } },
  { type: "tool_search_output", execution: "client", call_id: id, status, tools },
];
function replay(input: unknown[], tools: unknown[] = [search]) {
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input, tools }, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error(JSON.stringify(selected));
  return selected.request;
}

for (const namespaced of [false, true]) {
  const found = namespaced ? group([read, write]) : [read, write];
  test(`repeated native search preserves every call's complete result (namespace=${namespaced})`, () => {
    const input = [...pair("first", found), { type: "message", role: "user", content: "Continue and save." }, ...pair("again", found)];
    const output = replay(input).input as any[];
    expect(output.filter(x => x.type === "tool_search_output")).toEqual(input.filter(x => x.type === "tool_search_output"));
  });
  test(`already declared tools remain present in search results (namespace=${namespaced})`, () => {
    const input = pair("loaded", found);
    expect((replay(input, [search, ...found]).input as any[]).find(x => x.type === "tool_search_output")).toEqual(input[1]);
  });
  test(`additional declaration does not consume later search results (namespace=${namespaced})`, () => {
    const input = [{ type: "additional_tools", tools: found }, ...pair("loaded", found)];
    expect((replay(input).input as any[]).find(x => x.type === "tool_search_output")).toEqual(input[2]);
  });
}

test("overlapping search results preserve their individual contents and order", () => {
  const input = [...pair("a", group([read])), ...pair("b", group([write, read])), ...pair("c", group([write]))];
  expect((replay(input).input as any[]).filter(x => x.type === "tool_search_output")).toEqual(input.filter(x => x.type === "tool_search_output"));
});
test("empty and failed results remain empty and failed between successful repeated searches", () => {
  const input = [...pair("a", [read]), ...pair("empty", []), ...pair("failed", [], "failed"), ...pair("b", [read])];
  expect((replay(input).input as any[]).filter(x => x.type === "tool_search_output")).toEqual(input.filter(x => x.type === "tool_search_output"));
});
test("replaying a request twice does not mutate its search history", () => {
  const input = [...pair("a", group([read])), ...pair("b", group([read]))];
  const before = structuredClone(input);
  const first = replay(input);
  const second = replay(input);
  expect(input).toEqual(before);
  expect(second).toEqual(first);
  expect((second.input as any[]).filter(x => x.type === "tool_search_output")).toEqual(before.filter(x => x.type === "tool_search_output"));
});

test("invalid top-level deferred-loading flags remain rejected", () => {
  for (const defer_loading of ["true", 1, null, {}]) {
    const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input: "Read", tools: [{ ...read, defer_loading }] }, wireCapabilities: EXTENDED_RESPONSES_CAPABILITIES });
    expect(selected.ok).toBe(false);
  }
});

test("retained history preserves each schema revision after a runtime/tool update", () => {
  const updated = { ...read, description: "Read the current record", parameters: { type: "object", properties: { id: {type:"string"}, revision:{type:"integer"} }, required:["id"] } };
  const input = [...pair("old", group([read])), ...pair("new", group([updated]))];
  expect((replay(input).input as any[]).filter(x=>x.type==='tool_search_output')).toEqual(input.filter(x=>x.type==='tool_search_output'));
  expect((replay(input,[search,...group([updated])]).input as any[]).filter(x=>x.type==='tool_search_output')).toEqual(input.filter(x=>x.type==='tool_search_output'));
});

for (const format of ['responses','chat-completions','messages','google-generate-content'] as const) test(`schema revisions lower through ${format} with current catalog and original search evidence`,()=>{
  const updated={...read,description:'Updated schema',parameters:{type:'object',properties:{revision:{type:'integer'}},required:['revision']}};
  const input=[...pair('old',[read]),...pair('new',[updated])];
  for(const current of [[],[read]]){
    const selected=selectGatewayProxyRequest({sourceFormat:'responses',targetFormat:format,providerModelId:'provider',payload:{model:'public',input,tools:[search,...current]},wireCapabilities:resolveWireCapabilities(format)});
    expect(selected.ok).toBe(true);if(!selected.ok)return;
    const parsed=parsePublicRequest(format,selected.request);expect(parsed.ok).toBe(true);if(!parsed.ok)return;
    expect(parsed.value.tools.find(t=>t.type==='function'&&t.name===read.name)).toMatchObject({parameters:current.length?read.parameters:updated.parameters});
    const outputs=parsed.value.turns.flatMap(t=>t.blocks).filter(b=>b.type==='tool_result');
    expect(JSON.stringify(outputs)).toContain('Read a record');expect(JSON.stringify(outputs)).toContain('Updated schema');
  }
});
test('conflicting duplicate schemas within one catalog or one result still fail',()=>{
  const other={...read,parameters:{type:'object',properties:{other:{type:'boolean'}}}};
  for(const payload of [{model:'public',input:'Read',tools:[read,other]},{model:'public',input:pair('bad',[read,other]),tools:[search]}]){
    expect(selectGatewayProxyRequest({sourceFormat:'responses',targetFormat:'responses',providerModelId:'provider',payload,wireCapabilities:EXTENDED_RESPONSES_CAPABILITIES}).ok).toBe(false);
  }
});
test('request rejection diagnostics contain protocol structure only',()=>{
 const secret='must-never-be-logged';
 const shape=requestFailureShapes({tools:[{name:secret,input_schema:{secret},defer_loading:true,[secret]:secret}]},['tools.0',secret]);
 expect(JSON.stringify(shape)).not.toContain(secret);
 expect(shape[0]).toMatchObject({path:'tools.0',shape:{kind:'object',keys:['name','input_schema','defer_loading','other']}});
});
