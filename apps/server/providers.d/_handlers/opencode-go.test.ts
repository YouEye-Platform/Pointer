import { expect, test } from "bun:test";
import handler, {goModelMetadata} from "./opencode-go";
import {providerSessionId} from "../../src/providers/provider-session";
const entry=(npm?:string)=>({name:"Verified",tool_call:true,limit:{context:12345,output:2345},modalities:{input:["text","image"]},...(npm?{provider:{npm}}:{})});
test("Go preserves declared reasoning effort options without model-name rules",()=>{
 const result=goModelMetadata([{id:"opaque"},{id:"undeclared"}],{"opencode-go":{npm:"@ai-sdk/openai",models:{opaque:{...entry(),reasoning:true,reasoning_options:[{type:"budget",values:[123]},{type:"effort",values:["minimal","low","medium","high","xhigh","medium","future-label"]}]},undeclared:{...entry(),reasoning:true}}}});
 expect(result[0].wireCapabilities?.reasoningEfforts).toEqual(["minimal","low","medium","high","xhigh"]);
 expect(result[1].wireCapabilities).toBeUndefined();
});
test("Go joins verified metadata and routes each native protocol without inferring names",()=>{
 const result=goModelMetadata(["chat","responses","messages","unknown","deprecated"].map(id=>({id})),{"opencode-go":{npm:"@ai-sdk/openai-compatible",models:{chat:entry(),responses:entry("@ai-sdk/openai"),messages:entry("@ai-sdk/anthropic"),deprecated:{...entry(),status:"deprecated"}}}});
 expect(result.map(m=>[m.id,m.nativeFormat,m.nativeEndpoint])).toEqual([["chat","chat-completions","/chat/completions"],["responses","responses","/responses"],["messages","messages","/messages"]]);
 expect(result[0]).toMatchObject({contextWindow:12345,maxOutput:2345,supportsTools:true,supportsVision:true});
 expect(()=>goModelMetadata([],{})).toThrow("metadata is unavailable");
});
test("Go identity is stable, distinct, validated and required at every translation",()=>{
 for(const nativeEndpoint of ["/responses","/messages","/chat/completions"]){
   for(const id of ["conversation-a","conversation-b"]){
    const ctx={providerSessionId:providerSessionId(new Headers({session_id:id})),providerNativeEndpoint:nativeEndpoint,providerApiKey:"fixture-key"} as any;
    expect(handler.buildHeaders!(ctx,{} as any)["x-opencode-session"]).toBe(id);
    expect(handler.buildHeaders!(ctx,{} as any)["User-Agent"]).toMatch(/^Pointer\/[0-9]/);
   }
 }
 expect(providerSessionId(new Headers({"x-opencode-session":"invalid session","session_id":"good-id"}))).toBe("good-id");
 expect(providerSessionId(new Headers({"x-request-id":"request","authorization":"Bearer fixture"}))).toBeUndefined();
 expect(()=>handler.buildHeaders!({} as any,{} as any)).toThrow("stable conversation");
 expect(handler.buildHeaders!({providerSessionId:"session",providerNativeEndpoint:"/messages",providerApiKey:"fixture-key"} as any,{} as any)["x-api-key"]).toBe("fixture-key");
});

test("Go's actual provider builder preserves native endpoint, model and conversation through translated tool fixtures",async()=>{
 const {registry}=await import('../../src/providers/registry');
 const {selectGatewayProxyRequest,createGatewayProxyStreamSelector}=await import('../../src/gateway/protocol/v1/runtime-proxy');
 const {FORMAT_FIXTURES}=await import('../../src/gateway/fixtures/corpus');
 const isolated=new (registry.constructor as any)();
 const manifest={id:'opencode-go',name:'OpenCode Go',type:'openai-compatible',baseUrl:'https://opencode.ai/zen/go/v1',auth:{type:'bearer'},gateway:{operations:{generate:{format:'chat-completions',endpoint:'/chat/completions'}}}};
 isolated.providers.set('opencode-go',{manifest,handler});
 for(const targetFormat of ['chat-completions','responses','messages'] as const){
  const endpoint={'chat-completions':'/chat/completions',responses:'/responses',messages:'/messages'}[targetFormat];
  for(const sourceFormat of ['chat-completions','responses','messages'] as const){
   const selected=selectGatewayProxyRequest({sourceFormat,targetFormat,payload:FORMAT_FIXTURES[sourceFormat].request,providerModelId:'verified-model'});
   expect(selected.ok).toBe(true);if(!selected.ok)continue;
   for(const session of ['loop-a','loop-b']){
    const request=await isolated.buildProxyRequest(selected.request,{providerId:'opencode-go',providerModelId:'verified-model',providerNativeEndpoint:endpoint,providerSessionId:session},'fixture-key');
    expect(request.url).toBe('https://opencode.ai/zen/go/v1'+endpoint);
    expect(request.headers['x-opencode-session']).toBe(session);expect(request.body.model).toBe('verified-model');
   }
   const stream=createGatewayProxyStreamSelector({sourceFormat:targetFormat,targetFormat:sourceFormat,model:'verified-model',requestId:'fixture'});
   const output=FORMAT_FIXTURES[targetFormat].stream.flatMap(line=>stream.push({event:line.match(/^event: ([^\n]+)/m)?.[1],data:line.match(/^data: (.*)$/m)?.[1] === "[DONE]" ? "[DONE]" : JSON.parse(line.match(/^data: (.*)$/m)![1])}).lines).concat(stream.finish().lines).join('\n');
   expect(output).not.toContain('pointer_stream_translation_error');
   expect(stream.upstreamFailed()).toBe(false);
  }
 }
});

// Connection checks must exercise authenticated inference, never public inventory.
test("Go connection check probes each verified native protocol and isolates credentials/session identity", async () => {
 const {FORMAT_FIXTURES}=await import('../../src/gateway/fixtures/corpus');
 const original=globalThis.fetch;
 const manifest={id:'opencode-go',name:'OpenCode Go',type:'openai-compatible',baseUrl:'https://opencode.ai/zen/go/v1',auth:{type:'bearer'},endpoints:{models:'/models'},models:{discovery:{enabled:true,listPath:'data',idField:'id'}}} as any;
 const sessions=new Set<string>();
 try {
  for (const [npm,format,endpoint] of [['@ai-sdk/openai-compatible','chat-completions','/chat/completions'],['@ai-sdk/openai','responses','/responses'],['@ai-sdk/anthropic','messages','/messages']] as const) {
   const calls:{url:string;init?:RequestInit}[]=[];
   globalThis.fetch=(async(input:any,init?:RequestInit)=>{
    const url=String(input);calls.push({url,init});
    const body=url.endsWith('/models')?{data:[{id:'free'},{id:'regional'},{id:'glm-5.3-flash'}]}:url==='https://models.dev/api.json'?{'opencode-go':{npm,models:{free:{...entry(),cost:{input:0,output:0}},regional:{...entry(),cost:{input:0.001,output:0.001}},'glm-5.3-flash':{...entry(),cost:{input:0.1,output:0.2}}}}}:FORMAT_FIXTURES[format].response;
    return Response.json(body);
   }) as typeof fetch;
   expect(await handler.testConnection!(manifest,'fixture-account-secret')).toEqual({success:true,status:200});
   expect(calls).toHaveLength(3);const request=calls[2];expect(request.url).toBe(manifest.baseUrl+endpoint);
   const headers=new Headers(request.init!.headers);expect(headers.get('authorization')).toBe('Bearer fixture-account-secret');
   expect(headers.get('user-agent')).toMatch(/^Pointer\//);expect(headers.get('x-opencode-session')).toMatch(/^pointer-connection-/);
   sessions.add(headers.get('x-opencode-session')!);expect(JSON.parse(request.init!.body as string).model).toBe('glm-5.3-flash');
   expect(request.init!.body).toContain('function add');
   if(format==='messages')expect(headers.get('x-api-key')).toBe('fixture-account-secret');
  }
  expect(sessions.size).toBe(3);
 } finally {globalThis.fetch=original;}
});

test("Go public inventory never masks rejected keys, quota, invalid bodies or free-only availability",async()=>{
 const original=globalThis.fetch;const manifest={id:'opencode-go',name:'OpenCode Go',type:'openai-compatible',baseUrl:'https://opencode.ai/zen/go/v1',auth:{type:'bearer'},endpoints:{models:'/models'},models:{discovery:{enabled:true,listPath:'data',idField:'id'}}} as any;
 try {
  for(const status of [401,403,429,500,200]){
   globalThis.fetch=(async(input:any)=>{
    const url=String(input);
    return Response.json(url.endsWith('/models')?{data:[{id:'glm-5.3-flash'}]}:url==='https://models.dev/api.json'?{'opencode-go':{npm:'@ai-sdk/openai-compatible',models:{'glm-5.3-flash':{...entry(),cost:{input:0.1,output:0.2}}}}}:{error:'fixture-secret-must-not-leak'}, {status:url.endsWith('/models')||url==='https://models.dev/api.json'?200:status});
   }) as typeof fetch;
   const result=await handler.testConnection!(manifest,'fixture-secret-must-not-leak');expect(result.success).toBe(false);expect(result.status).toBe(status===200?502:status);expect(JSON.stringify(result)).not.toContain('fixture-secret');
  }
  let calls=0;globalThis.fetch=(async(input:any)=>{calls++;return Response.json(String(input).endsWith('/models')?{data:[{id:'free'}]}:{'opencode-go':{npm:'@ai-sdk/openai-compatible',models:{free:{...entry(),cost:{input:0,output:0}}}}});}) as typeof fetch;
  expect((await handler.testConnection!(manifest,'invalid')).success).toBe(false);expect(calls).toBe(2);
  globalThis.fetch=(async()=>{throw Error('fixture-secret');}) as typeof fetch;
  expect(await handler.testConnection!(manifest,'invalid')).toMatchObject({success:false,status:0});
 }finally{globalThis.fetch=original;}
});

test("Go Messages empty signature markers preserve streamed thinking and subsequent tool calls", async()=>{
 const {createGatewayProxyStreamSelector}=await import('../../src/gateway/protocol/v1/runtime-proxy');
 for(const format of ['chat-completions','responses','messages'] as const){
  const stream=createGatewayProxyStreamSelector({sourceFormat:'messages',targetFormat:format,model:'fixture',requestId:'empty-signature-fixture'});
  const frames=[
   {type:'message_start',message:{id:'msg_fixture',model:'fixture',usage:{input_tokens:10,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
   {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Read the code fixture.'}},
   {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:''}},
   {type:'content_block_stop',index:0},
   {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_fixture',name:'read_code_fixture',input:{}}},
   {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{}'}},
   {type:'content_block_stop',index:1},
   {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:20}},
   {type:'message_stop'},
  ];
  const output=frames.flatMap(data=>stream.push({event:data.type,data}).lines).concat(stream.finish().lines).join('\n');
  expect(stream.failure()).toBeNull();expect(stream.ended()).toBe(true);expect(output).toContain('read_code_fixture');expect(output).toContain('Read the code fixture.');expect(output).not.toContain('pointer_stream_translation_error');
 }
 // A meaningful signature must never be silently dropped by this narrow fix.
 const signed=createGatewayProxyStreamSelector({sourceFormat:'messages',targetFormat:'chat-completions',model:'fixture',requestId:'signed-fixture'});
 signed.push({event:'content_block_delta',data:{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'opaque-signature-fixture'}}});
 expect(signed.failure()?.kind).toBe('translation');
});
