export type EngineFailureReceipt = {
  schema: "pointer.engine-failure.v1";
  observedAt: string;
  componentCommit?: string | null;
  initialHttpStatus: number | null;
  terminal: "completed" | "failed" | "missing";
  failureCode: string | null;
  failureBoundary?: "http_rejection" | "provider_terminal" | "stream_read" | "malformed_event" | "truncated_event" | "invalid_json" | "event_limit" | "local_cancel" | null;
  stage: "before_response" | "after_response_start";
  lastEventType: string | null;
  events: number | null;
  firstEventMs: number | null;
  lastEventMs: number | null;
  totalMs: number | null;
  localCancellation: "client_stream_cancel" | "client_request_abort" | null;
  engine: { generation: string; startedAt: string; engineVersion: string; exitCode: number | null; signal: string | null } | null;
  engineRequestId: string | null;
  attempts: Array<{ordinal:number;sendCount:number;status:number;durationMs:number;streamAborted:boolean;errorCode:string|null}> | null;
  physicalAttempts: null;
  upstreamCloseCode: null;
  upstreamCloseReason: "unavailable";
  coverage: string;
};
export function safeEngineReceipt(value:any):EngineFailureReceipt|null {
  if(value?.schema!=="pointer.engine-failure.v1")return null;
  const integer=(v:unknown,max=Number.MAX_SAFE_INTEGER)=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 && v<=max ? v : null;
  const utc=(v:unknown)=>typeof v==='string' && v.length<=35 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
  const observedAt=utc(value.observedAt);if(!observedAt)return null;
  const initialHttpStatus=integer(value.initialHttpStatus,599);
  const code=(v:unknown)=>typeof v==='string' && ['upstream_reset','context_length_exceeded','max_tokens','invalid_request_error','invalid_api_key','authentication_error','permission_denied','rate_limit_exceeded','rate_limit_error','insufficient_quota','quota_exceeded','model_not_found','overloaded_error','server_error','internal_server_error','timeout','request_timeout','content_filter','invalid_image','unsupported_parameter','unsupported_value','invalid_value','tool_use_failed'].includes(v) ? v : null;
  const engine=value.engine;
  const generation=typeof engine?.generation==='string' && /^[a-f0-9]{32}$/.test(engine.generation) ? engine.generation : null;
  const startedAt=utc(engine?.startedAt);
  return {schema:"pointer.engine-failure.v1",observedAt,
    componentCommit:typeof value.componentCommit==='string' && /^[a-f0-9]{40}$/.test(value.componentCommit) ? value.componentCommit : null,
    initialHttpStatus:initialHttpStatus !== null && initialHttpStatus >= 100 ? initialHttpStatus : null,
    terminal:value.terminal==='completed' ? 'completed' : value.terminal==='failed' ? 'failed' : 'missing',
    failureCode:code(value.failureCode),stage:value.stage==='after_response_start' ? 'after_response_start' : 'before_response',
    failureBoundary:['http_rejection','provider_terminal','stream_read','malformed_event','truncated_event','invalid_json','event_limit','local_cancel'].includes(value.failureBoundary) ? value.failureBoundary : null,
    lastEventType:safeEngineEventType(value.lastEventType),events:integer(value.events),
    firstEventMs:integer(value.firstEventMs),lastEventMs:integer(value.lastEventMs),totalMs:integer(value.totalMs),
    localCancellation:['client_stream_cancel','client_request_abort'].includes(value.localCancellation) ? value.localCancellation : null,
    engine:generation && startedAt ? {generation,startedAt,engineVersion:"2.79.0",exitCode:integer(engine.exitCode,255),
      signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT','SIGHUP'].includes(engine.signal) ? engine.signal : null} : null,
    engineRequestId:typeof value.engineRequestId==='string' && /^(?:[A-F0-9]{7}|ocx-[a-f0-9]{32})$/.test(value.engineRequestId) ? value.engineRequestId : null,
    attempts:value.attempts===null ? null : projectEngineAttempts({logs:[{requestId:'receipt',attempts:value.attempts}]},'receipt'),
    physicalAttempts:null,upstreamCloseCode:null,upstreamCloseReason:"unavailable",
    coverage:"engine observation; per-send and upstream close details unavailable"};
}
const events = new Set(["response.created", "response.in_progress", "response.completed", "response.failed", "response.incomplete",
  "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "message_start", "message_delta", "message_stop",
  "content_block_start", "content_block_delta", "content_block_stop", "error", "ping"]);
export function safeEngineEventType(value: unknown): string | null {
  return typeof value === "string" && events.has(value) ? value : null;
}
/** Supported upstream log DTO projection, never retain provider-controlled text.
 * A log attempt can contain several sends; it is not a per-send receipt. */
export function projectEngineAttempts(value: any, requestId: string): EngineFailureReceipt["attempts"] {
  const rows = Array.isArray(value?.logs) ? value.logs.filter((r:any)=>r?.requestId===requestId) : [];
  if (rows.length !== 1 || !Array.isArray(rows[0].attempts) || rows[0].attempts.length > 32) return null;
  const count=(v:unknown,max:number)=>Number.isSafeInteger(v) && (v as number)>=0 && (v as number)<=max;
  const codes=new Set(['upstream_reset','rate_limit_error','rate_limit_exceeded','overloaded_error','insufficient_quota','authentication_error','invalid_api_key','server_error','internal_server_error','request_timeout','timeout']);
  const attempts=[];
  const ordinals=new Set<number>();
  for (const a of rows[0].attempts) {
    if (!a || !count(a.ordinal,1000) || !count(a.sendCount,1000) || !count(a.status,599) || !count(a.durationMs,86400000) || ordinals.has(a.ordinal)) return null;
    ordinals.add(a.ordinal);
    attempts.push({ordinal:a.ordinal,sendCount:a.sendCount,status:a.status,durationMs:a.durationMs,
      streamAborted:a.streamAborted===true,errorCode:codes.has(a.errorCode)?a.errorCode:null});
  }
  return attempts;
}
