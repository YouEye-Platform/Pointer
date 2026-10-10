import {createHash,randomUUID} from "node:crypto";
import {mkdirSync,lstatSync,readdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,fsyncSync,closeSync,existsSync} from "node:fs";
import {join} from "node:path";
import {safeEngineReceipt} from "./engine-failure-receipt";

export function safeUsageDiagnostic(value:Record<string,unknown>) {
  const safe:Record<string,unknown>={};
  for(const key of ['apiKeyId','userId','instanceId','modelId','requestId','catalogEntityId','providerId','providerAccountId']) {
    const v=value[key];if(v===null || typeof v==='string' && /^[A-Za-z0-9_./: -]{1,200}$/.test(v))safe[key]=v;
  }
  const enums:Record<string,string[]>={costStatus:['known','unknown'],priceSource:['provider_models'],outcome:['success','upstream_error','client_abort','incomplete_stream'],source:['proxy','test'],
    upstreamErrorCode:['upstream_reset','context_length_exceeded','max_tokens','invalid_request_error','invalid_api_key','authentication_error','permission_denied','rate_limit_exceeded','rate_limit_error','insufficient_quota','quota_exceeded','model_not_found','overloaded_error','server_error','internal_server_error','timeout','request_timeout','content_filter','invalid_image','unsupported_parameter','unsupported_value','invalid_value','tool_use_failed']};
  for(const [key,allowed] of Object.entries(enums))if(value[key]===null || allowed.includes(value[key] as string))safe[key]=value[key];
  for(const key of ['inputTokens','outputTokens','cachedTokens','reasoningTokens','cacheCreationTokens','cacheReadTokens','latencyMs','ttfbMs','generationMs','queueTimeMs','promptTimeMs','completionTimeMs','processingMs','statusCode']) {
    const v=value[key];if(v===null || typeof v==='number' && Number.isSafeInteger(v) && v>=0)safe[key]=v;
  }
  for(const key of ['costUsd','inputPriceSnapshot','outputPriceSnapshot','tokensPerSecond']) {
    const v=value[key];if(v===null || typeof v==='string' && /^[0-9.e+-]{1,64}$/.test(v) && Number.isFinite(Number(v)) && Number(v)>=0)safe[key]=v;
  }
  safe.failureReceipt=safeEngineReceipt(value.failureReceipt);
  const date=value.createdAt instanceof Date ? value.createdAt.toISOString() : value.createdAt;
  if(typeof date==='string' && date.length<=35 && Number.isFinite(Date.parse(date)))safe.createdAt=new Date(date).toISOString();
  return safe;
}

/** Only compact already-projected usage metadata enters this private spool.
 * It never stores model/tool content or dispatches inference. */
export class EngineReceiptSpool {
  private gap: "unavailable" | "overflow" | null = null;
  constructor(private root:string, private maximum=10000) {}
  private checkRoot() {
    const entry=lstatSync(this.root);
    if(!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077)
      || (process.getuid && entry.uid!==process.getuid()))throw Error('Unsafe diagnostic spool');
  }
  private read(path:string) {
    const file=lstatSync(path);
    if(!file.isFile() || file.isSymbolicLink() || file.size>65536)throw Error('Invalid diagnostic file');
    return readFileSync(path,'utf8');
  }
  private noteGap(gap:"unavailable"|"overflow") {
    this.gap=gap;
    try {this.checkRoot(); const path=join(this.root,"coverage-gap");if(existsSync(path))this.read(path);writeFileSync(path,gap,{mode:0o600,flush:true});} catch { /* Unwritable storage cannot claim retention. */ }
  }
  retain(id:string, value:Record<string,unknown>): boolean {
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(id)){this.noteGap('unavailable');return false;}
    const name=createHash("sha256").update(id).digest("hex")+".json";
    const bytes=JSON.stringify({id,value:safeUsageDiagnostic(value)});
    if(Buffer.byteLength(bytes)>65536){this.noteGap("overflow");return false;}
    try {
      mkdirSync(this.root,{recursive:true,mode:0o700});
      this.checkRoot();
      const path=join(this.root,name);
      if(!existsSync(path) && readdirSync(this.root).filter(n=>n.endsWith('.json')).length>=this.maximum){this.noteGap("overflow");return false;}
      if(existsSync(path)) {
        const old=JSON.parse(this.read(path));
        if(old.id!==id || old.value.userId!==value.userId || old.value.instanceId!==value.instanceId || old.value.requestId!==value.requestId)throw Error();
      }
      {
        const temporary=path+"."+randomUUID()+".tmp";
        try {writeFileSync(temporary,bytes,{flag:"wx",mode:0o600,flush:true});renameSync(temporary,path);}
        finally {if(existsSync(temporary))unlinkSync(temporary);}
      }
      const fd=openSync(this.root,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
      return true;
    } catch {this.noteGap("unavailable");return false;}
  }
  acknowledge(id:string) {
    if(!existsSync(this.root))return;this.checkRoot();
    const path=join(this.root,createHash("sha256").update(id).digest("hex")+".json");
    if(existsSync(path))unlinkSync(path);
  }
  async replay(insert:(id:string,value:Record<string,unknown>)=>Promise<boolean|void>) {
    if(!existsSync(this.root))return;
    this.checkRoot();
    for(const name of readdirSync(this.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,100)) {
      const path=join(this.root,name), bytes=this.read(path);
      if(Buffer.byteLength(bytes)>65536){this.gap="overflow";continue;}
      const {id,value}=JSON.parse(bytes);
      if(typeof id!=='string' || createHash('sha256').update(id).digest('hex')+'.json'!==name)throw Error('Invalid diagnostic identity');
      if(await insert(id,safeUsageDiagnostic(value))===false)continue;
      if(this.read(path)===bytes)unlinkSync(path);
    }
  }
  coverage(owner:string) {
    let pending=0;
    try {
      if(existsSync(this.root))this.checkRoot();
      if(existsSync(join(this.root,'coverage-gap'))) {
        const gap=this.read(join(this.root,'coverage-gap'));if(gap==='unavailable'||gap==='overflow')this.gap=gap;
      }
      if(existsSync(this.root)) for(const name of readdirSync(this.root).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,100)) {
        const value=JSON.parse(this.read(join(this.root,name)));
        if(value.value.userId===owner)pending++;
      }
    } catch {this.gap="unavailable";}
    return {schema:"pointer.diagnostic-coverage.v1",pendingInFirst100:pending, captureGap:this.gap,scanLimit:100};
  }
}
