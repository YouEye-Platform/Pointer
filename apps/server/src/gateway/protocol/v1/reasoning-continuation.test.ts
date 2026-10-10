import {expect,test} from 'bun:test';
import {createGatewayProxyStreamSelector,selectGatewayProxyRequest,selectGatewayProxyResponse} from './runtime-proxy';
import {EXTENDED_RESPONSES_CAPABILITIES} from '../../wire-capabilities';
const reasoning={type:'reasoning',id:'rs_fixture',encrypted_content:'synthetic_opaque_state',summary:[]};
const response={id:'resp_fixture',object:'response',model:'fixture',status:'completed',output:[reasoning,{type:'function_call',call_id:'call_fixture',name:'lookup',arguments:'{}'}]};
test('Responses opaque state survives a Messages client tool-result round trip with source identity',()=>{
 const outbound=selectGatewayProxyResponse({sourceFormat:'responses',targetFormat:'messages',model:'fixture',payload:response});expect(outbound.ok).toBe(true);if(!outbound.ok)return;
 const request=selectGatewayProxyRequest({sourceFormat:'messages',targetFormat:'responses',providerModelId:'fixture',wireCapabilities:EXTENDED_RESPONSES_CAPABILITIES,payload:{model:'fixture',max_tokens:1024,messages:[{role:'assistant',content:outbound.response.content},{role:'user',content:[{type:'tool_result',tool_use_id:'call_fixture',content:'saved'}]}],tools:[{name:'lookup',input_schema:{type:'object',properties:{}}}]}});
 expect(request.ok).toBe(true);if(!request.ok)return;
 expect((request.request.input as any[]).find(x=>x.type==='reasoning')).toEqual(reasoning);
});
test('untagged native Messages ciphertext remains native and cannot be relabelled as Responses state',()=>{
 const payload={model:'fixture',max_tokens:1024,messages:[{role:'assistant',content:[{type:'redacted_thinking',data:'native_messages_cipher'}]}]};
 expect(selectGatewayProxyRequest({sourceFormat:'messages',targetFormat:'responses',providerModelId:'fixture',payload}).ok).toBe(false);
 expect(selectGatewayProxyRequest({sourceFormat:'messages',targetFormat:'messages',providerModelId:'fixture',payload}).ok).toBe(true);
});
test('streamed Responses state is enveloped once and accepted on the next Messages tool-result turn',()=>{
 const selector=createGatewayProxyStreamSelector({sourceFormat:'responses',targetFormat:'messages',model:'fixture',requestId:'reasoning-fixture'});
 const frames=[{type:'response.created',response:{id:'r',model:'fixture',status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:'rs_fixture',summary:[]}},
  {type:'response.output_item.done',output_index:0,item:reasoning},
  {type:'response.output_item.added',output_index:1,item:{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'lookup',arguments:''}},
  {type:'response.function_call_arguments.delta',output_index:1,item_id:'fc_fixture',delta:'{}'},
  {type:'response.output_item.done',output_index:1,item:{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'lookup',arguments:'{}'}},
  {type:'response.completed',response}];
 const lines=frames.flatMap(data=>selector.push({event:data.type,data}).lines);lines.push(...selector.finish().lines);expect(selector.failed()).toBe(false);
 const events=lines.flatMap(line=>line.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))));
 const content=events.filter(e=>e.type==='content_block_start'&&e.content_block.type==='redacted_thinking').map(e=>e.content_block);expect(content).toHaveLength(1);
 const next=selectGatewayProxyRequest({sourceFormat:'messages',targetFormat:'responses',providerModelId:'fixture',payload:{model:'fixture',max_tokens:1024,messages:[{role:'assistant',content},{role:'user',content:'Continue'}]}});
 expect(next.ok).toBe(true);if(next.ok)expect((next.request.input as any[]).find(x=>x.type==='reasoning')).toEqual(reasoning);
});
test('malformed or wrong-origin envelopes cannot bypass protocol scoping',()=>{
 for(const data of ['pointer:reasoning:v1:not-json', 'pointer:reasoning:v1:'+Buffer.from(JSON.stringify({type:'reasoning',text:'',encryptedContent:'synthetic',encryptedSourceFormat:'messages'})).toString('base64url')]){
  expect(selectGatewayProxyRequest({sourceFormat:'messages',targetFormat:'responses',providerModelId:'fixture',payload:{model:'fixture',max_tokens:1024,messages:[{role:'assistant',content:[{type:'redacted_thinking',data}]}]}}).ok).toBe(false);
 }
});
