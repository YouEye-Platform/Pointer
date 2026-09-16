import { expect, test } from "bun:test";
import { createGatewayProxyStreamSelector, selectGatewayProxyRequest, selectGatewayProxyResponse } from "./runtime-proxy";

const call = { type: "tool_search_call", id: "ts_1", call_id: "call_1", execution: "client", status: "completed", arguments: { query: "current environment" } };
const result = { type: "tool_search_output", call_id: "call_1", execution: "client", status: "completed", tools: [{ type: "function", name: "environment", defer_loading: true, parameters: { type: "object" } }] };
const namespaced = { type: "function_call", id: "fc_2", call_id: "call_2", name: "environment", namespace: "crew", arguments: "{}" };
const custom = { type: "custom_tool_call", id: "ct_3", call_id: "call_3", name: "apply_patch", input: "patch text" };

test("Codex additional tool declarations preserve exact definitions and ordering", () => {
  const item = { type: "additional_tools", role: "developer", id: "tools_1", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }] };
  const input = [item, { type: "message", role: "user", content: [{ type: "input_text", text: "Run the tool" }] }];
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input } });
  expect(selected.ok).toBe(true);
  if (selected.ok) expect(selected.request.input).toEqual(input);
  const cross = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "messages", providerModelId: "provider", payload: { model: "public", input } });
  expect(cross.ok).toBe(false);
  const invalid = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input: [{ ...item, tools: "invalid" }] } });
  expect(invalid.ok).toBe(false);
});

test("Codex reasoning context and client metadata survive Responses routing", () => {
  const payload = { model: "public", input: "Hello", reasoning: { effort: "medium", context: "all_turns" }, client_metadata: { turn_id: "fixture" } };
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload });
  expect(selected.ok).toBe(true);
  if (selected.ok) {
    expect(selected.request.reasoning).toEqual(payload.reasoning);
    expect(selected.request.client_metadata).toEqual(payload.client_metadata);
  }
  const cross = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "messages", providerModelId: "provider", payload });
  expect(cross.ok).toBe(false);
});

test("native tool items survive a Responses continuation with IDs and definitions intact", () => {
  const input = [call, result, namespaced, custom, { type: "custom_tool_call_output", call_id: "call_3", output: "ok" }];
  const selected = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input } });
  expect(selected.ok).toBe(true);
  if (selected.ok) expect(selected.request.input).toEqual(input);
  const cross = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "messages", providerModelId: "provider", payload: { model: "public", input } });
  expect(cross.ok).toBe(false);
  const invalid = selectGatewayProxyRequest({ sourceFormat: "responses", targetFormat: "responses", providerModelId: "provider", payload: { model: "public", input: [{ type: "tool_search_output", tools: "invalid" }] } });
  expect(invalid.ok).toBe(false);
});

test("native items survive non-stream output and fail closed across protocols", () => {
  const payload = { id: "resp", object: "response", model: "provider", status: "completed", output: [call, custom] };
  const selected = selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat: "responses", model: "public", payload });
  expect(selected.ok).toBe(true);
  if (selected.ok) expect(selected.response.output).toEqual([call, custom]);
  expect(selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat: "messages", model: "public", payload }).ok).toBe(false);
});

for (const item of [call, custom, namespaced]) test(`stream ${item.type} keeps native item and terminal usage`, () => {
  const selector = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "responses", model: "public", requestId: "req" });
  const lines: string[] = [];
  for (const data of [
    { type: "response.created", response: { id: "resp", model: "provider" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp", model: "provider", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
  ]) lines.push(...selector.push({ event: data.type, data }).lines);
  expect(selector.failed()).toBe(false);
  expect(selector.ended()).toBe(true);
  expect(selector.usage()?.inputTokens).toBe(12);
  const terminal = lines.map(line => JSON.parse(line.split("data: ")[1]!)).find(data => data.type === "response.completed");
  expect(terminal.response.output).toEqual([item]);
  expect(terminal.response.usage.input_tokens).toBe(12);
  expect(selector.finish().lines).toEqual([]);
});

test("native output cannot silently disappear in translated or incomplete streams", () => {
  const cross = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "messages", model: "public", requestId: "req" });
  cross.push({ data: { type: "response.output_item.added", output_index: 0, item: call } });
  expect(cross.failed()).toBe(true);
  const incomplete = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "responses", model: "public", requestId: "req" });
  incomplete.push({ data: { type: "response.output_item.added", output_index: 0, item: call } });
  incomplete.push({ data: { type: "response.completed", response: { status: "completed", output: [] } } });
  expect(incomplete.failed()).toBe(true);
});

for (const phase of ["commentary", "final_answer"] as const) test(`phased ${phase} messages preserve history, streaming text and terminal output`, () => {
  const item = { type: "message", id: "msg_phase", role: "assistant", phase, status: "completed", content: [{type:"output_text",text:"Hello",annotations:[]}] };
  const selected = selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",payload:{model:"public",input:[item]}});
  expect(selected.ok).toBe(true);
  if(selected.ok) expect(selected.request.input).toEqual([item]);
  const selector=createGatewayProxyStreamSelector({sourceFormat:"responses",targetFormat:"responses",model:"public",requestId:"phase"});
  const lines:string[]=[];
  for(const data of [
    {type:"response.created",response:{id:"resp",model:"provider"}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    {type:"response.output_text.delta",output_index:0,item_id:item.id,content_index:0,delta:"Hello"},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response:{id:"resp",model:"provider",status:"completed",output:[item]}},
  ])lines.push(...selector.push({event:data.type,data}).lines);
  expect(selector.failed()).toBe(false);
  expect(selector.ended()).toBe(true);
  const events=lines.map(line=>JSON.parse(line.split("data: ")[1]!));
  expect(events.find(x=>x.type==="response.output_text.delta").delta).toBe("Hello");
  expect(events.find(x=>x.type==="response.completed").response.output).toEqual([item]);
  const cross=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"messages",providerModelId:"provider",payload:{model:"public",input:[item]}});
  expect(cross.ok).toBe(false);
});
