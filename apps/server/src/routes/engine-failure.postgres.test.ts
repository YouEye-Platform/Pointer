import {test,expect} from 'bun:test';
import {and,eq} from 'drizzle-orm';
import {db,schema} from '../db';
import {createStandaloneApp} from '../app';
import {signJwt} from '../middleware/auth';
import {enginePool} from '../services/engine';
import {drainUsageWrites} from '../services/usage-telemetry';
const enabled=process.env.POINTER_ENGINE_POSTGRES_TEST==='1';
if(enabled && new URL(process.env.DATABASE_URL!).pathname!=='/pointer_engine_test')throw Error('Requires disposable engine database');
test.skipIf(!enabled)('controlled initial-200 premature failure retains actual request and engine attempt through authenticated stats',async()=>{
 const owner='failure-engine-'+crypto.randomUUID();let sends=0;
 const provider=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
  if(new URL(req.url).pathname.endsWith('/models'))return Response.json({data:[{id:'owned-model'}]});
  sends++;
  return new Response([
   {type:'response.created',response:{id:'resp_owned',object:'response',status:'in_progress',output:[]}},
   {type:'error',code:'upstream_reset',message:'Owned fixture premature close'}
  ].map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 try {
  await db.insert(schema.users).values({id:owner,kind:'local',email:owner+'@example.test',name:'Owned failure fixture',passwordHash:'fixture',role:'user'});
  const token=await signJwt({id:owner,email:owner+'@example.test',name:'Owned fixture',role:'user'}),app=createStandaloneApp();
  const call=async(path:string,body?:object,credential=token)=>{
   const r=await app.request(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   expect(r.ok).toBe(true);return await r.json() as any;
  };
  await call('/api/connections/providers',{name:'fixture',setDefault:true,provider:{adapter:'openai-responses',authMode:'key',baseUrl:`http://127.0.0.1:${provider.port}/v1`,apiKey:'owned-fixture-only',models:['owned-model'],allowPrivateNetwork:true}});
  await call('/api/connections/sync',{reference:false});
  const [account]=await db.select().from(schema.providerAccounts).where(and(eq(schema.providerAccounts.userId,owner),eq(schema.providerAccounts.engineProvider,'fixture')));
  expect(account).toBeTruthy();
  const [model]=await db.select().from(schema.providerModels).where(and(eq(schema.providerModels.providerId,account!.providerId),eq(schema.providerModels.providerModelId,'owned-model')));
  expect(model).toBeTruthy();
  const group=await call('/api/groups',{name:'Owned failure'});
  await call('/api/groups/'+group.id+'/entries',{catalogEntityId:model!.catalogEntityId,providerModelKey:model!.id,providerAccountId:account!.id,alias:'Fixture'});
  const instance=await call('/api/instances',{name:'Owned failure',modelGroupId:group.id}),key=await call('/api/keys',{instanceId:instance.id});
  const response=await app.request('/v1/responses',{method:'POST',headers:{authorization:'Bearer '+key.key,'content-type':'application/json'},body:JSON.stringify({model:'default',input:'Owned synthetic failure',stream:true})});
  if(response.status!==200){const failure=await response.json() as any;throw Error(JSON.stringify({status:response.status,code:failure.error?.code,type:failure.error?.type,sends,nativeAuth:/Codex.*(?:credential|account)|native main/.test(failure.error?.message||''),validFixtureKey:typeof key.key==='string'&&key.key.startsWith('ptr_')}));}
  expect(response.status).toBe(200);const request=response.headers.get('x-pointer-request-id')!;expect(request).toBeTruthy();await response.text();
  expect(await drainUsageWrites()).toBe(true);
  const detail=await call('/api/stats/summary?days=90&request='+request),receipt=detail.recent[0].failureReceipt;
  expect(detail.recent).toHaveLength(1);expect(detail.recent[0].outcome).toBe('upstream_error');expect(detail.recent[0].statusCode).toBe(502);
  expect(receipt.initialHttpStatus).toBe(200);expect(receipt.terminal).toBe('failed');expect(receipt.failureCode).toBe('upstream_reset');
  expect(receipt.events).toBeGreaterThanOrEqual(2);expect(receipt.engineRequestId).toMatch(/^ocx-[a-f0-9]{32}$/);
  expect(receipt.engine.generation).toMatch(/^[a-f0-9]{32}$/);expect(receipt.attempts.length).toBeGreaterThan(0);
  expect(receipt.physicalAttempts).toBeNull();expect(receipt.upstreamCloseCode).toBeNull();expect(sends).toBe(1);
  expect(JSON.stringify(receipt)).not.toContain('premature close');expect(JSON.stringify(receipt)).not.toContain('synthetic failure');
  await enginePool.stop();expect((await call('/api/stats/summary?days=90&request='+request)).recent[0].failureReceipt).toEqual(receipt);
 }finally{await drainUsageWrites();await enginePool.stop();provider.stop(true);await db.delete(schema.usageLogs).where(eq(schema.usageLogs.userId,owner));await db.delete(schema.users).where(eq(schema.users.id,owner));}
},30000);
