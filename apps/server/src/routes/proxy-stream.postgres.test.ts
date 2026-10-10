import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { hashApiKey } from "../middleware/api-key";
import { registry } from "../providers/registry";
import { encrypt } from "../services/encryption";
import { assertCatalogPostgresTestDatabase } from "../services/catalog-postgres-test-safety";
import proxy from "./proxy";
import { drainUsageWrites } from "../services/usage-telemetry";
import { EXTENDED_RESPONSES_CAPABILITIES } from "../gateway/wire-capabilities";

const enabled = process.env.CATALOG_POSTGRES_TEST === "1";
const prefix = "proxy-stream-test";
const key = "ptr_synthetic_stream_fixture";
const citation = {type:"url_citation",url:"https://example.org/source",title:"Source",start_index:0,end_index:7};
let upstream: ReturnType<typeof Bun.serve>;
let upstreamRequests = 0;
let lastUpstreamBody: any;

const opaqueReasoning = {type:"reasoning",id:"rs_fixture",encrypted_content:"synthetic_opaque_state",summary:[]};
const opaqueCall = {type:"function_call",id:"fc_fixture",call_id:"call_fixture",name:"lookup",arguments:"{}"};
function fixture(mode: string) {
  if (mode === "opaque-roundtrip") return [
    {type:"response.created",response:{id:"resp_fixture",model:"fixture",status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item:{type:"reasoning",id:"rs_fixture",summary:[]}},
    {type:"response.output_item.done",output_index:0,item:opaqueReasoning},
    {type:"response.output_item.added",output_index:1,item:{...opaqueCall,arguments:""}},
    {type:"response.function_call_arguments.delta",output_index:1,item_id:"fc_fixture",delta:"{}"},
    {type:"response.output_item.done",output_index:1,item:opaqueCall},
    {type:"response.completed",response:{id:"resp_fixture",object:"response",model:"fixture",status:"completed",output:[opaqueReasoning,opaqueCall]}},
  ];
  const part = {type:"output_text",text:"Fixture 🌍",annotations:[citation]};
  const item = {type:"message",id:"msg_fixture",role:"assistant",status:"completed",content:[part]};
  const response = {id:"resp_fixture",object:"response",model:"upstream",status:"completed",output:[item],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  const events = [
    {type:"response.created",response:{...response,status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    {type:"response.content_part.added",output_index:0,content_index:0,item_id:item.id,part:{...part,text:"",annotations:[]}},
    {type:"response.output_text.delta",output_index:0,content_index:0,item_id:item.id,delta:part.text},
    ...(mode === "final-only" ? [] : [{type:"response.output_text.annotation.added",output_index:0,content_index:0,item_id:item.id,annotation_index:0,annotation:citation}]),
    {type:"response.content_part.done",output_index:0,content_index:0,item_id:item.id,part},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response},
  ].map(event => structuredClone(event));
  if (mode === "eof") events.pop();
  if (mode === "dropped-citation") events[events.length-1] = {type:"response.completed",response:{...response,output:[{...item,content:[{...part,annotations:[]}]}]}};
  return events;
}

async function request(mode:string, stream=true) {
  return proxy.request("http://pointer.test/responses", {
    method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},
    body:JSON.stringify({model:"fixture",input:mode,stream}),
  });
}

describe.skipIf(!enabled)("Responses citation HTTP gateway PostgreSQL integration", () => {
  beforeAll(async () => {
    assertCatalogPostgresTestDatabase();
    await db.delete(schema.usageLogs).where(eq(schema.usageLogs.userId,prefix));
    await db.delete(schema.users).where(eq(schema.users.id,prefix));
    await db.delete(schema.providers).where(eq(schema.providers.id,prefix));
    upstream = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
      upstreamRequests++;
      const body = await req.json() as {input:unknown};
      lastUpstreamBody = body;
      const mode = JSON.stringify(body.input);
      const selected = ["opaque-roundtrip","eof","dropped-citation","final-only","multiline","crlf"].find(value => mode.includes(value)) ?? "normal";
      const newline = selected === "crlf" ? "\r\n" : "\n";
      const wire = fixture(selected).map(event => {
        const json = JSON.stringify(event);
        const data = selected === "multiline" ? json.replace(',"output_index"', ',\ndata: "output_index"') : json;
        return `: comment${newline}event:${event.type}${newline}data: ${data}${newline}${newline}`;
      }).join("");
      const bytes = new TextEncoder().encode(wire);
      return new Response(new ReadableStream({start(controller) {
        for (let i=0;i<bytes.length;i+=7) controller.enqueue(bytes.slice(i,i+7));
        controller.close();
      }}),{headers:{"content-type":"text/event-stream"}});
    }});
    await db.insert(schema.users).values({id:prefix,kind:"service",name:"Disposable stream fixture"});
    await db.insert(schema.instances).values({id:prefix,userId:prefix,name:"Disposable stream fixture"});
    await db.insert(schema.providers).values({id:prefix,name:"Synthetic Responses",type:"openai-compatible",baseUrl:`http://127.0.0.1:${upstream.port}`});
    await db.insert(schema.providerModels).values({id:prefix,providerId:prefix,modelId:"fixture",providerModelId:"fixture",nativeFormat:"responses",nativeEndpoint:"/responses",supportsTools:true,supportsStreaming:true,rawMetadata:{wireCapabilities:EXTENDED_RESPONSES_CAPABILITIES}});
    await db.insert(schema.providerKeys).values({id:prefix,userId:prefix,providerId:prefix,apiKeyEncrypted:encrypt("synthetic-upstream-key")});
    await db.insert(schema.instanceModels).values({id:prefix,instanceId:prefix,providerId:prefix,modelId:"fixture",alias:"fixture"});
    await db.insert(schema.apiKeys).values({id:prefix,userId:prefix,instanceId:prefix,keyHash:await hashApiKey(key),keyPreview:"synthetic",name:"Synthetic fixture",purpose:"internal_test"});
    await registry.initialize();
    registry.getProvider(prefix)!.manifest.gateway = { operations: { generate: { format: "responses", endpoint: "/responses" } }, wire: EXTENDED_RESPONSES_CAPABILITIES };
  });

  afterAll(async () => {
    upstream?.stop(true);
    await drainUsageWrites();
    await db.delete(schema.usageLogs).where(eq(schema.usageLogs.userId,prefix));
    await db.delete(schema.users).where(eq(schema.users.id,prefix));
    await db.delete(schema.providers).where(eq(schema.providers.id,prefix));
  });

  for (const mode of ["normal","final-only","multiline","crlf"]) test(`${mode} preserves citations through the actual HTTP upstream`, async () => {
    const before = upstreamRequests;
    const response = await request(mode);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(upstreamRequests).toBe(before+1);
    const terminal = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
    expect(terminal.response.output[0].content[0]).toEqual({type:"output_text",text:"Fixture 🌍",annotations:[citation]});
    expect(terminal.response.usage.total_tokens).toBe(5);
  });

  for (const mode of ["eof","dropped-citation"]) test(`${mode} cannot become a successful terminal`, async () => {
    const before = upstreamRequests;
    const response = await request(mode);
    const text = await response.text();
    expect(upstreamRequests).toBe(before+1);
    expect(text).not.toContain('"type":"response.completed"');
    expect(text).toContain(mode === "eof" ? "pointer_stream_interrupted" : "pointer_stream_translation_error");
  });

  test("forced upstream streaming retains citations for a buffered client", async () => {
    const response = await request("normal",false);
    expect(response.status).toBe(200);
    const terminal = await response.json() as any;
    expect(terminal.output[0].content[0].annotations).toEqual([citation]);
  });

  test("buffered EOF exposes the stable failure code", async () => {
    const response = await request("eof",false);
    expect(response.status).toBe(502);
    expect((await response.json() as any).error.code).toBe("pointer_stream_interrupted");
  });

  for (const stream of [true, false]) test(`repeated client search reaches the real upstream intact (stream=${stream})`, async () => {
    const tool = { type: "function", name: "save_record", defer_loading: true, parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
    const tools = [{ type: "namespace", name: "records", tools: [tool] }];
    const input = ["first", "followup", "recreated"].flatMap(call_id => [
      { type: "tool_search_call", execution: "client", call_id, arguments: { query: "save record" } },
      { type: "tool_search_output", execution: "client", status: "completed", call_id, tools: call_id === "recreated" ? [{type:"namespace",name:"records",tools:[{...tool,description:"Updated after reconnect",parameters:{type:"object",properties:{value:{type:"string"},version:{type:"integer"}},required:["value","version"]}}]}] : tools },
    ]);
    const before = upstreamRequests;
    const response = await proxy.request("http://pointer.test/responses", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", stream, input, tools: [{ type: "tool_search", execution: "client", parameters: { type: "object", properties: { query: { type: "string" } } } }] }) });
    expect(response.status).toBe(200);
    const result = await response.text();
    expect(upstreamRequests).toBe(before + 1);
    expect(lastUpstreamBody.input.filter((item: any) => item.type === "tool_search_output")).toEqual(input.filter(item => item.type === "tool_search_output"));
    expect(result).toContain(stream ? '"type":"response.completed"' : '"status":"completed"');
  });
  for (const stream of [true, false]) test(`Messages opaque reasoning returns to its actual HTTP provider (stream=${stream})`, async () => {
    const send = (messages: unknown[], streaming: boolean) => proxy.request("http://pointer.test/messages", {
      method:"POST", headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},
      body:JSON.stringify({model:"fixture",max_tokens:1024,stream:streaming,messages,tools:[{name:"lookup",input_schema:{type:"object",properties:{}}}]}),
    });
    const first = await send([{role:"user",content:"opaque-roundtrip"}],stream);
    expect(first.status).toBe(200);
    let content: any[];
    if (stream) {
      const wire = await first.text();
      const events = wire.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6)));
      expect(events.some(event=>event.type === "message_stop")).toBe(true);
      content = events.filter(event=>event.type === "content_block_start").map(event=>event.content_block);
    } else content = (await first.json() as any).content;
    expect(content.filter(block=>block.type === "redacted_thinking")).toHaveLength(1);
    expect(content.filter(block=>block.type === "tool_use")).toHaveLength(1);
    const before = upstreamRequests;
    const next = await send([{role:"assistant",content},{role:"user",content:[{type:"tool_result",tool_use_id:"call_fixture",content:"saved"}]}],false);
    expect(next.status).toBe(200);
    await next.text();
    expect(upstreamRequests).toBe(before+1);
    expect(lastUpstreamBody.input.find((item:any)=>item.type === "reasoning")).toEqual(opaqueReasoning);
    expect(lastUpstreamBody.input.find((item:any)=>item.type === "function_call_output").output).toBe("saved");
  });

});
