import { renderPublicStreamTrace } from "./stream";
import { expect, test } from "bun:test";
import { selectGatewayProxyRequest, selectGatewayProxyResponse, createGatewayProxyStreamSelector, selectGatewayProxyError } from "./runtime-proxy";
import { parsePublicRequest, renderPublicResponse } from "./adapters";
import { resolveWireCapabilities, EXTENDED_RESPONSES_CAPABILITIES } from "../../wire-capabilities";
import { deduplicateTools, semanticResponseTools } from "./tool-codec";
import { GATEWAY_IR_NAME, GATEWAY_IR_VERSION, type IrResponse, type IrStreamEvent } from "./schemas";
import type { GatewayApiFormat } from "../../compatibility";

const tools = [
  { type:"function", name:"functions__exec", parameters:{type:"object"} },
  { type:"namespace", name:"functions", description:"", tools:[
    { type:"custom", name:"exec", description:"Execute text", format:{ type:"grammar", syntax:"lark", definition:"start: /.+/" } },
    { type:"function", name:"wait", parameters:{type:"object", properties:{id:{type:"string"}}} },
  ] },
];
const raw = 'print("λ\\n🙂")\nsecond line';
const corpus = { model:"public", input:[
  { type:"additional_tools", role:"developer", tools },
  { type:"reasoning", id:"r1", encrypted_content:"synthetic_reasoning_replay", summary:[] },
  { type:"custom_tool_call", call_id:"c1", id:"ct1", namespace:"functions", name:"exec", input:raw },
  { type:"custom_tool_call_output", call_id:"c1", output:"ok" },
  { role:"user", content:"Continue" },
], tool_choice:{type:"custom", namespace:"functions",name:"exec"} };

for (const format of ["responses","chat-completions","messages","google-generate-content"] as GatewayApiFormat[]) test(`shared custom tool loop through ${format}`, () => {
  // Encrypted reasoning has no portable replay on other wires: it must fail
  // explicitly rather than discard the history. A portable corpus uses text.
  const payload = format === "responses" ? corpus : {...corpus, input:corpus.input.filter(x=>x.type!=="reasoning")};
  const selected = selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:format,providerModelId:"provider",payload,wireCapabilities:resolveWireCapabilities(format)});
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const parsed = parsePublicRequest(format, selected.request);
  expect(parsed.ok).toBe(true); if (!parsed.ok) return;
  const custom = parsed.value.tools.find(t=>t.type==="function" && Array.isArray(t.parameters.required) && t.parameters.required.includes("input"));
  expect(custom?.type).toBe("function"); if (!custom || custom.type!=="function") return;
  expect(custom.name).not.toBe("functions__exec");
  expect(parsed.value.toolChoice).toMatchObject({type:"function",name:custom.name});
  const call = parsed.value.turns.flatMap(t=>t.blocks).find(b=>b.type==="tool_call");
  expect(call).toMatchObject({id:"c1",name:custom.name,arguments:{input:raw}});
  expect(parsed.value.turns.flatMap(t=>t.blocks).some(b=>b.type==="tool_result" && b.callId==="c1")).toBe(true);
  expect(selected.toolContext?.grammarPrompted).toBe(true);
  const ir: IrResponse = { protocol:GATEWAY_IR_NAME,version:GATEWAY_IR_VERSION,kind:"response",sourceFormat:format,compatibilityPolicy:"best-effort",compatibility:[],extensions:[],id:"resp",model:"provider",status:"completed",finishReason:"tool_calls",output:[{type:"tool_call",id:"c2",name:custom.name,arguments:{input:raw},rawArguments:JSON.stringify({input:raw})}] };
  const rendered = renderPublicResponse(format, ir);
  expect(rendered.ok).toBe(true); if (!rendered.ok) return;
  const returned = selectGatewayProxyResponse({sourceFormat:format,targetFormat:"responses",model:"public",payload:rendered.value,toolContext:selected.toolContext});
  expect(returned.ok).toBe(true); if (!returned.ok) return;
  expect(returned.response.output).toMatchObject([{type:"custom_tool_call",name:"exec",namespace:"functions",call_id:"c2",input:raw}]);
});

test("native extended Responses keeps declaration location, namespaces and grammar", () => {
  const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",payload:corpus,wireCapabilities:EXTENDED_RESPONSES_CAPABILITIES});
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  expect((selected.request.input as any[])[0]).toEqual(corpus.input[0]);
  expect((selected.request.input as any[])[1]).toMatchObject({encrypted_content:"synthetic_reasoning_replay",id:"r1"});
  expect((selected.request.input as any[]).slice(2,4)).toEqual(corpus.input.slice(2,4));
  expect(selected.request.tool_choice).toEqual(corpus.tool_choice);
  expect(selected.toolContext?.grammarPrompted).toBe(false);
});

test("deduplication is deterministic under JSON property order and rejects conflicting identities", () => {
  const a=semanticResponseTools([{type:"function",name:"same",parameters:{type:"object",properties:{a:{type:"string"}}}}]);
  const b=semanticResponseTools([{type:"function",name:"same",parameters:{properties:{a:{type:"string"}},type:"object"}}],"deferred");
  expect(deduplicateTools([...a,...b])).toHaveLength(1);
  expect(()=>deduplicateTools([...a,...semanticResponseTools([{type:"function",name:"same",parameters:{type:"array"}}])])).toThrow();
});

test("fragmented custom arguments become ordered raw-string events with call identity", () => {
  const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",payload:{...corpus,input:corpus.input.filter(x=>x.type!=="reasoning")},wireCapabilities:resolveWireCapabilities("responses")});
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const alias=Object.entries(selected.toolContext!.aliases).find(([,v])=>v.inputKind==="text")![0];
  const selector=createGatewayProxyStreamSelector({sourceFormat:"responses",targetFormat:"responses",model:"public",requestId:"fixture",toolContext:selected.toolContext});
  const item={id:"fc1",type:"function_call",call_id:"c2",name:alias,arguments:"",status:"in_progress"};
  const events:any[]=[{type:"response.created",response:{id:"resp",model:"provider"}}, {type:"response.output_item.added",output_index:0,item}];
  const argumentsText=JSON.stringify({input:raw});
  for(const char of argumentsText)events.push({type:"response.function_call_arguments.delta",output_index:0,item_id:"fc1",delta:char});
  events.push({type:"response.function_call_arguments.done",output_index:0,item_id:"fc1",arguments:argumentsText}, {type:"response.output_item.done",output_index:0,item:{...item,status:"completed",arguments:argumentsText}}, {type:"response.completed",response:{id:"resp",model:"provider",status:"completed",output:[{...item,status:"completed",arguments:argumentsText}]}});
  const lines=events.flatMap(data=>selector.push({event:data.type,data}).lines);
  expect(selector.failed()).toBe(false); expect(selector.ended()).toBe(true);
  const output=lines.map(line=>JSON.parse(line.split("data: ")[1]!));
  expect(output.filter(x=>x.type==="response.function_call_arguments.delta")).toHaveLength(0);
  expect(output.find(x=>x.type==="response.custom_tool_call_input.delta")).toMatchObject({delta:raw,call_id:"c2"});
  expect(output.findIndex(x=>x.type==="response.custom_tool_call_input.done")).toBeLessThan(output.findIndex(x=>x.type==="response.output_item.done"));
  expect(output.find(x=>x.type==="response.completed").response.output[0]).toMatchObject({name:"exec",namespace:"functions",type:"custom_tool_call",input:raw,call_id:"c2"});
});

test("unsupported encrypted replay and malformed custom return fail visibly", () => {
  expect(selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"messages",providerModelId:"provider",payload:corpus,wireCapabilities:resolveWireCapabilities("messages")}).ok).toBe(false);
  const returned=selectGatewayProxyResponse({sourceFormat:"responses",targetFormat:"responses",model:"public",toolContext:{aliases:{exec:{name:"exec",inputKind:"text"}},grammarPrompted:true},payload:{id:"resp",model:"provider",status:"completed",output:[{type:"function_call",name:"exec",call_id:"c",arguments:'{"input":42}'}]}});
  expect(returned.ok).toBe(false);
});

test("endpoint overrides take precedence and impossible wire features are clamped",()=>{
  expect(resolveWireCapabilities("responses",{customTools:true},{customTools:false},{customTools:true}).customTools).toBe(true);
  expect(resolveWireCapabilities("messages",{customTools:true,namespaceTools:true}).customTools).toBe(false);
});


test("client tool-search histories retain results and eagerly expose discovered tools", () => {
  const payload={model:"public",input:[
    {type:"tool_search_call",execution:"client",call_id:"search1",arguments:{query:"environment"}},
    {type:"tool_search_output",execution:"client",call_id:"search1",tools:[{type:"function",name:"environment",defer_loading:true,parameters:{type:"object"}}]},
    {role:"user",content:"Continue"},
  ]};
  for (const targetFormat of ["responses","chat-completions","messages","google-generate-content"] as GatewayApiFormat[]) {
    const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat,providerModelId:"provider",payload,wireCapabilities:resolveWireCapabilities(targetFormat)});
    expect(selected.ok).toBe(true); if (!selected.ok) continue;
    const parsed=parsePublicRequest(targetFormat,selected.request);
    expect(parsed.ok).toBe(true); if (!parsed.ok) continue;
    expect(parsed.value.tools).toMatchObject([{name:"environment"}]);
    expect(parsed.value.turns.flatMap(t=>t.blocks)).toEqual(expect.arrayContaining([expect.objectContaining({type:"tool_call",id:"search1"}),expect.objectContaining({type:"tool_result",callId:"search1"})]));
  }
  expect(selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",payload:{model:"public",input:"hi",tools:[{type:"tool_search",execution:"server"}]},wireCapabilities:resolveWireCapabilities("responses")}).ok).toBe(false);
});


test("provider rejections expose a safe category and parameter without leaking provider prose", () => {
  const result=selectGatewayProxyError({sourceFormat:"responses",targetFormat:"responses",status:400,requestId:"ptrreq_synthetic0001",body:{error:{code:"unsupported_parameter",param:"input[0]",message:"secret upstream prompt and credentials"}}});
  expect(result.status).toBe(400);
  expect(result.responseBody.error).toMatchObject({code:"pointer_upstream_rejected",param:"input[0]"});
  expect(JSON.stringify(result)).not.toContain("secret upstream");
  const unsafe=selectGatewayProxyError({sourceFormat:"responses",targetFormat:"responses",status:404,requestId:"ptrreq_synthetic0001",body:{error:{param:"https://secret.invalid/token",code:"sk-secret-credential"}}});
  expect(unsafe.responseBody.error).toMatchObject({code:"pointer_upstream_not_found"});
  expect(JSON.stringify(unsafe)).not.toContain("secret");
});


for (const sourceFormat of ["responses","chat-completions","messages","google-generate-content"] as GatewayApiFormat[]) test(`custom streamed return through ${sourceFormat}`, () => {
  const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:sourceFormat,providerModelId:"provider",payload:{...corpus,input:corpus.input.filter(x=>x.type!=="reasoning")},wireCapabilities:resolveWireCapabilities(sourceFormat)});
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const alias=Object.entries(selected.toolContext!.aliases).find(([,v])=>v.inputKind==="text")![0];
  const base={protocol:GATEWAY_IR_NAME,version:GATEWAY_IR_VERSION,sourceFormat,responseId:"resp_stream",model:"provider"};
  let sequence=0;
  const events:IrStreamEvent[]=[{...base,sequence:sequence++,type:"response_start"},{...base,sequence:sequence++,type:"tool_call_start",index:0,callId:"c_stream",name:alias}];
  for(const delta of JSON.stringify({input:raw}))events.push({...base,sequence:sequence++,type:"tool_arguments_delta",index:0,callId:"c_stream",delta});
  events.push({...base,sequence:sequence++,type:"content_end",index:0},{...base,sequence:sequence++,type:"response_end",finishReason:"tool_calls"});
  const selector=createGatewayProxyStreamSelector({sourceFormat,targetFormat:"responses",model:"public",requestId:"ptrreq_streamfixture",toolContext:selected.toolContext});
  const lines=renderPublicStreamTrace(sourceFormat,events).flatMap(event=>selector.push(event).lines);
  lines.push(...selector.finish().lines);
  expect(selector.failed()).toBe(false); expect(selector.ended()).toBe(true);
  const output=lines.map(line=>JSON.parse(line.split("data: ")[1]!));
  expect(output.find(x=>x.type==="response.custom_tool_call_input.done")).toMatchObject({input:raw,call_id:"c_stream"});
  expect(output.find(x=>x.type==="response.completed").response.output[0]).toMatchObject({type:"custom_tool_call",name:"exec",namespace:"functions",input:raw,call_id:"c_stream"});
});


test("native capability identity context never substitutes a tool definition for a returned call", () => {
  const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",payload:corpus,wireCapabilities:EXTENDED_RESPONSES_CAPABILITIES});
  expect(selected.ok).toBe(true); if (!selected.ok) return;
  const returned=selectGatewayProxyResponse({sourceFormat:"responses",targetFormat:"responses",model:"public",toolContext:selected.toolContext,payload:{id:"native_resp",model:"provider",status:"completed",output:[{type:"custom_tool_call",id:"ct",name:"exec",namespace:"functions",call_id:"custom",input:raw},{type:"function_call",id:"fc",name:"wait",namespace:"functions",call_id:"json",arguments:'{"id":"job"}'}]}});
  expect(returned.ok).toBe(true); if (!returned.ok) return;
  expect(returned.response.output).toHaveLength(2);
  expect(returned.response.output).toMatchObject([{type:"custom_tool_call",name:"exec",input:raw,namespace:"functions"},{type:"function_call",name:"wait",namespace:"functions",arguments:'{"id":"job"}'}]);
});

test("native reasoning null placeholders permit the next tool-result turn", () => {
 const selected=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",wireCapabilities:resolveWireCapabilities("responses"),payload:{model:"public",tools:[{type:"function",name:"exec",parameters:{type:"object"}}],input:[{type:"reasoning",id:"reason1",summary:[{type:"summary_text",text:""}],content:null,encrypted_content:null},{type:"function_call",name:"exec",call_id:"native-call",arguments:"{}"},{type:"function_call_output",call_id:"native-call",output:"accepted"}]}});
 expect(selected.ok).toBe(true);if(!selected.ok)return;
 expect(selected.request.input).toMatchObject([{type:"reasoning",id:"reason1"},{type:"function_call",call_id:"native-call"},{type:"function_call_output",call_id:"native-call",output:"accepted"}]);
});
test("hosted web search is explicit endpoint capability, never silently removed",()=>{
 const payload={model:"public",input:"Search",tools:[{type:"web_search"}]};
 expect(selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",wireCapabilities:resolveWireCapabilities("responses"),payload}).ok).toBe(false);
 const enabled=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",wireCapabilities:resolveWireCapabilities("responses",{webSearch:true}),payload});
 expect(enabled.ok).toBe(true);if(enabled.ok)expect(enabled.request.tools).toEqual(payload.tools);
});

test("explicit hosted search survives capability resolution for Gemini", () => {
 const caps=resolveWireCapabilities("google-generate-content",{webSearch:true});expect(caps.webSearch).toBe(true);
 const selected=selectGatewayProxyRequest({sourceFormat:"google-generate-content",targetFormat:"google-generate-content",providerModelId:"provider",wireCapabilities:caps,payload:{model:"public",contents:[{role:"user",parts:[{text:"Search"}]}],tools:[{googleSearch:{}}]}});expect(selected.ok).toBe(true);
});

test("completed-stream encrypted reasoning survives the next native tool-result turn", () => {
 const rawReason={id:"rs_replay",type:"reasoning",status:"completed",summary:[],encrypted_content:"synthetic_opaque_replay"};
 const frames=[{type:"response.created",response:{id:"resp",model:"provider"}},{type:"response.output_item.added",output_index:0,item:{id:rawReason.id,type:"reasoning",status:"in_progress",summary:[]}},{type:"response.output_item.done",output_index:0,item:rawReason},{type:"response.output_item.added",output_index:1,item:{id:"fc1",type:"function_call",name:"exec",call_id:"c",arguments:""}},{type:"response.function_call_arguments.delta",output_index:1,item_id:"fc1",delta:"{}"},{type:"response.output_item.done",output_index:1,item:{id:"fc1",type:"function_call",name:"exec",call_id:"c",arguments:"{}"}},{type:"response.completed",response:{id:"resp",model:"provider",status:"completed",output:[rawReason,{id:"fc1",type:"function_call",name:"exec",call_id:"c",arguments:"{}"}]}}];
 const selector=createGatewayProxyStreamSelector({sourceFormat:"responses",targetFormat:"responses",model:"public",requestId:"reasoning-replay"});
 const outputs=frames.flatMap(data=>selector.push({event:data.type,data}).lines).map(line=>JSON.parse(line.split("data: ")[1]!));
 expect(selector.failed()).toBe(false);expect(selector.ended()).toBe(true);
 const done=outputs.find(x=>x.type==="response.output_item.done").item;
 expect(done).toMatchObject({id:rawReason.id,summary:[],encrypted_content:rawReason.encrypted_content});
 expect(outputs.find(x=>x.type==="response.completed").response.output[0]).toEqual(done);
 const next=selectGatewayProxyRequest({sourceFormat:"responses",targetFormat:"responses",providerModelId:"provider",wireCapabilities:resolveWireCapabilities("responses"),payload:{model:"public",input:[done,{type:"function_call",name:"exec",call_id:"c",arguments:"{}"},{type:"function_call_output",call_id:"c",output:"done"}],tools:[{type:"function",name:"exec",parameters:{type:"object"}}]}});
 expect(next.ok).toBe(true);if(next.ok)expect((next.request.input as any[])[0]).toMatchObject({id:rawReason.id,summary:[],encrypted_content:rawReason.encrypted_content});
 for(const target of ["chat-completions","google-generate-content"] as GatewayApiFormat[]){const cross=createGatewayProxyStreamSelector({sourceFormat:"responses",targetFormat:target,model:"public",requestId:"opaque-cross"});for(const data of frames)cross.push({event:data.type,data});expect(cross.failed()).toBe(true);}
});
