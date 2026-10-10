import {test,expect} from "bun:test";
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {EngineReceiptSpool} from "./engine-receipt-spool";
test("safe spool survives reconstruction and replay, isolates coverage and withholds arbitrary payload",async()=>{
 const root=mkdtempSync('/tmp/pointer-receipt-');
 try {
  const spool=new EngineReceiptSpool(root);
  const receipt={schema:'pointer.engine-failure.v1',observedAt:'2026-10-09T01:00:00Z',initialHttpStatus:200,terminal:'failed',failureCode:'upstream_reset',stage:'after_response_start',events:2,firstEventMs:1,lastEventMs:2,totalMs:3,lastEventType:'error',upstreamCloseReason:'private-secret',rawPrompt:'private-prompt'};
  expect(spool.retain('row-one',{userId:'owner',instanceId:'instance',modelId:'fixture',providerId:'fixture',source:'proxy',outcome:'upstream_error',statusCode:502,createdAt:new Date(),failureReceipt:receipt,rawPrompt:'private-prompt',errorMessage:'private-secret'})).toBe(true);
  const file=readdirSync(root).find(n=>n.endsWith('.json'))!;
  const bytes=readFileSync(join(root,file),'utf8');expect(bytes).not.toContain('private');
  const next=new EngineReceiptSpool(root);expect(next.coverage('owner').pendingInFirst100).toBe(1);expect(next.coverage('other').pendingInFirst100).toBe(0);
  const rows=new Map();const insert=async(id:string,v:any)=>{if(!rows.has(id))rows.set(id,v);};
  await next.replay(insert);await next.replay(insert);expect(rows.size).toBe(1);expect(rows.get('row-one').failureReceipt.initialHttpStatus).toBe(200);
  expect(next.coverage('owner').pendingInFirst100).toBe(0);
 }finally{rmSync(root,{recursive:true});}
});
test("overflow remains visible after restart; capture failure and corruption do not dispatch effects",async()=>{
 const root=mkdtempSync('/tmp/pointer-receipt-');
 try {
  const spool=new EngineReceiptSpool(root,1);
  expect(spool.retain('first',{userId:'owner'})).toBe(true);
  expect(spool.retain('first',{userId:'owner',statusCode:502})).toBe(true);
  expect(spool.retain('second',{userId:'owner'})).toBe(false);
  expect(new EngineReceiptSpool(root,1).coverage('owner').captureGap).toBe('overflow');
  const file=readdirSync(root).find(n=>n.endsWith('.json'))!;writeFileSync(join(root,file),'broken');
  let effects=0;await expect(spool.replay(async()=>{effects++;})).rejects.toThrow();expect(effects).toBe(0);
  const link=join(root,'link');symlinkSync(root,link);
  expect(new EngineReceiptSpool(link).retain('untrusted',{userId:'owner'})).toBe(false);
 }finally{rmSync(root,{recursive:true});}
});
