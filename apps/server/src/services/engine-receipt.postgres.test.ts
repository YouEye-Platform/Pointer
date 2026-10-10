import {test,expect} from 'bun:test';
import {eq} from 'drizzle-orm';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {db,schema} from '../db';
import {createStandaloneApp} from '../app';
import {signJwt} from '../middleware/auth';
import {EngineReceiptSpool} from './engine-receipt-spool';
const enabled=process.env.POINTER_ENGINE_POSTGRES_TEST==='1';
if(enabled && new URL(process.env.DATABASE_URL!).pathname!=='/pointer_engine_test')throw Error('Requires disposable engine database');
test.skipIf(!enabled)('restart receipt replay persists once and exact authenticated owner retrieval survives source removal',async()=>{
 const owner='receipt-'+crypto.randomUUID(),other='receipt-other-'+crypto.randomUUID(),requestId='ptrreq_owned-'+crypto.randomUUID();
 const root=mkdtempSync(join(tmpdir(),'pointer-receipt-pg-'));
 const receipt={schema:'pointer.engine-failure.v1',observedAt:new Date().toISOString(),initialHttpStatus:200,terminal:'failed',failureCode:'upstream_reset',stage:'after_response_start',lastEventType:'error',events:2,firstEventMs:1,lastEventMs:2,totalMs:3,localCancellation:null,
 engine:{generation:'a'.repeat(32),startedAt:new Date().toISOString(),engineVersion:'2.79.0',exitCode:null,signal:null},engineRequestId:'ocx-'+'b'.repeat(32),attempts:[{ordinal:1,sendCount:2,status:502,durationMs:3,streamAborted:true,errorCode:'upstream_reset'}],privatePrompt:'withheld-content'};
 try {
  for(const id of [owner,other])await db.insert(schema.users).values({id,kind:'local',email:id+'@example.test',name:'Owned receipt fixture',passwordHash:'fixture',role:'user'});
  const value={userId:owner,modelId:'owned-model',providerId:'owned-provider',requestId,inputTokens:0,outputTokens:0,statusCode:502,outcome:'upstream_error',source:'proxy',createdAt:new Date(Date.now()-100*86400000),failureReceipt:receipt,errorMessage:'withheld-secret'};
  expect(new EngineReceiptSpool(root).retain('owned-replay',value)).toBe(true);
  // A new spool instance models process restart. Stable ID makes a crash
  // after insertion but before acknowledgement safe on the next replay.
  const insert=async(id:string,v:Record<string,unknown>)=>{await db.insert(schema.usageLogs).values({id,...v,createdAt:new Date(v.createdAt as string)} as any).onConflictDoNothing();};
  await new EngineReceiptSpool(root).replay(async(id,v)=>{await insert(id,v);return false;});
  await new EngineReceiptSpool(root).replay(insert);
  expect(await db.select().from(schema.usageLogs).where(eq(schema.usageLogs.requestId,requestId))).toHaveLength(1);
  const app=createStandaloneApp();
  for(const id of [owner,other]){
   const token=await signJwt({id,email:id+'@example.test',name:'Owned fixture',role:'user'});
   const response=await app.request('/api/stats/summary?days=90&request='+requestId,{headers:{authorization:'Bearer '+token}});
   expect(response.status).toBe(200);const result=await response.json() as any;
   expect(result.recent).toHaveLength(id===owner?1:0);
   if(id===owner){expect(result.recent[0].requestId).toBe(requestId);expect(result.recent[0].failureReceipt.engineRequestId).toBe(receipt.engineRequestId);expect(result.recent[0].failureReceipt.attempts[0].sendCount).toBe(2);}
   expect(JSON.stringify(result)).not.toContain('withheld-content');expect(JSON.stringify(result)).not.toContain('withheld-secret');
  }
 }finally{await db.delete(schema.usageLogs).where(eq(schema.usageLogs.userId,owner));for(const id of [owner,other])await db.delete(schema.users).where(eq(schema.users.id,id));rmSync(root,{recursive:true});}
},30000);
