import type { ContinuationScope } from "./engine-continuation";
import { safeEngineEventType, type EngineFailureReceipt } from "./engine-failure-receipt";
import {buildInfo} from "./build-info";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export type EngineUsage = { input: number; output: number; cached: number | null; reasoning: number | null;
  cacheRead: number | null; cacheCreation: number | null; complete: boolean; cancelled: boolean; failed: boolean; errorCode: string | null; receipt?: EngineFailureReceipt };

// Codes are retained without provider messages, prompts or arbitrary payloads.
const diagnosticCodes = new Set(['context_length_exceeded', 'max_tokens', 'invalid_request_error',
  'invalid_api_key', 'authentication_error', 'permission_denied', 'rate_limit_exceeded', 'rate_limit_error',
  'insufficient_quota', 'quota_exceeded', 'model_not_found', 'overloaded_error', 'server_error',
  'internal_server_error', 'timeout', 'request_timeout', 'content_filter', 'invalid_image',
  'unsupported_parameter', 'unsupported_value', 'invalid_value', 'tool_use_failed', 'upstream_reset']);

/** Observe public usage; only Responses identity fields are changed. */
export async function projectEngineResponse(response: Response, scope: ContinuationScope | null,
  finish: (usage: EngineUsage) => void,
  engineObservation?: () => EngineFailureReceipt["engine"]): Promise<Response> {
  const usage: EngineUsage = { input: 0, output: 0, cached: null, reasoning: null,
    cacheRead: null, cacheCreation: null, complete: false, cancelled: false, failed: !response.ok, errorCode: null };
  let finished = false;
  let chatFinished = false;
  let failureBoundary:EngineFailureReceipt['failureBoundary']=response.ok ? null : 'http_rejection';
  const start = performance.now();
  let events = 0, firstEventMs: number | null = null, lastEventMs: number | null = null, lastEventType: string | null = null;
  const done = () => { if (!finished) { finished = true;
    usage.receipt = {schema:"pointer.engine-failure.v1", observedAt:new Date().toISOString(), initialHttpStatus:response.status,
      componentCommit:buildInfo.commit && /^[a-f0-9]{40}$/.test(buildInfo.commit) ? buildInfo.commit : null,
      terminal:usage.failed ? "failed" : usage.complete ? "completed" : "missing", failureCode:usage.errorCode,failureBoundary,
      stage:events ? "after_response_start" : "before_response", lastEventType, events, firstEventMs, lastEventMs,
      totalMs:Math.round(performance.now()-start), localCancellation:usage.cancelled ? "client_stream_cancel" : null,
      engine:null, engineRequestId:/^(?:[A-F0-9]{7}|ocx-[a-f0-9]{32})$/.test(response.headers.get("x-opencodex-request-id") || "") ? response.headers.get("x-opencodex-request-id") : null,
      attempts:null, physicalAttempts:null, upstreamCloseCode:null, upstreamCloseReason:"unavailable",
      coverage:"engine HTTP/SSE boundary; upstream physical attempts and close details unavailable"};
    try { usage.receipt.engine = engineObservation?.() || null; } catch { /* Coverage remains explicit. */ }
    try { finish(usage); } catch { /* Diagnostics cannot change inference outcomes. */ }
  } };
  const observe = (value: unknown) => {
    if (!object(value)) return;
    for (const child of [value.response, value.message]) if (object(child)) observe(child);
    if (object(value.usage)) {
      const input = value.usage.input_tokens ?? value.usage.prompt_tokens;
      const output = value.usage.output_tokens ?? value.usage.completion_tokens;
      if (typeof input === "number" && Number.isFinite(input)) usage.input = Math.max(usage.input, input +
        (typeof value.usage.cache_read_input_tokens === "number" && Number.isFinite(value.usage.cache_read_input_tokens) && value.usage.cache_read_input_tokens >= 0 ? value.usage.cache_read_input_tokens : 0) +
        (typeof value.usage.cache_creation_input_tokens === "number" && Number.isFinite(value.usage.cache_creation_input_tokens) && value.usage.cache_creation_input_tokens >= 0 ? value.usage.cache_creation_input_tokens : 0));
      if (typeof output === "number" && Number.isFinite(output)) usage.output = Math.max(usage.output, output);
      const fields = { cached: object(value.usage.input_tokens_details) ? value.usage.input_tokens_details.cached_tokens : object(value.usage.prompt_tokens_details) ? value.usage.prompt_tokens_details.cached_tokens : undefined,
        reasoning: object(value.usage.output_tokens_details) ? value.usage.output_tokens_details.reasoning_tokens : object(value.usage.completion_tokens_details) ? value.usage.completion_tokens_details.reasoning_tokens : undefined,
        cacheRead: value.usage.cache_read_input_tokens, cacheCreation: value.usage.cache_creation_input_tokens };
      for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        const count = fields[key];
        if (typeof count === "number" && Number.isFinite(count) && count >= 0) usage[key] = Math.max(usage[key] ?? 0, count);
      }
    }
    if (value.type === "response.completed" || value.type === "message_stop") usage.complete = true;
    if (Array.isArray(value.choices) && value.choices.some(choice => object(choice) && typeof choice.finish_reason === "string")) chatFinished = true;
    if (value.type === "error" || value.type === "response.failed" || value.type === "response.incomplete"
      || value.status === "failed" || value.status === "incomplete" || object(value.error)) usage.failed = true;
    if (usage.failed) {
      failureBoundary ||= 'provider_terminal';
      const error = object(value.error) ? value.error : value;
      const detail = object(value.incomplete_details) ? value.incomplete_details : {};
      for (const code of [error.code, error.type, detail.reason])
        if (typeof code === 'string' && diagnosticCodes.has(code)) { usage.errorCode = code; break; }
    }
  };
  const headers = new Headers();
  for (const name of ["x-opencodex-request-id", "content-type", "retry-after", "x-request-id", "request-id", "anthropic-version",
    "x-pointer-token-count-source", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset"])
    if (response.headers.has(name)) headers.set(name, response.headers.get(name)!);
  headers.set("cache-control", "no-store");
  if (!response.body) { usage.complete = response.ok; done(); return new Response(null, { status: response.status, headers }); }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    try {
      const value: unknown = await response.json();
      observe(value);
      usage.complete = response.ok && !usage.failed;
      done();
      return Response.json(scope && object(value) ? scope.project(value) : value, { status: response.status, headers });
    } catch { usage.failed = true; failureBoundary='invalid_json';done(); throw new Error("Invalid engine response"); }
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 16 * 1024 * 1024) {failureBoundary='event_limit';throw new Error("Engine event exceeds the response limit");}
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        // A transport terminator cannot turn a truncated Responses/Messages
        // stream into a successful generation.
        if (data === "[DONE]" && chatFinished) usage.complete = true;
        let emitted = frame;
        if (data && data !== "[DONE]") {
          let value:unknown;
          try {value=JSON.parse(data);} catch {failureBoundary='malformed_event';throw Error('Invalid engine event');}
          events = Math.min(events + 1, Number.MAX_SAFE_INTEGER);
          lastEventMs = Math.round(performance.now() - start);
          firstEventMs ??= lastEventMs;
          lastEventType = object(value) ? safeEngineEventType(value.type) : null;
          observe(value);
          if (scope && object(value)) emitted = [
            ...lines.filter(line => !line.startsWith("data:")), `data: ${JSON.stringify(scope.project(value))}`,
          ].join("\n");
        }
        controller.enqueue(encoder.encode(emitted + "\n\n"));
      }
    },
    flush() { pending += decoder.decode(); if (pending.trim()) {failureBoundary='truncated_event';throw new Error("Incomplete engine event");} },
  });
  const reader = response.body.pipeThrough(transform).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { controller.close(); reader.releaseLock(); done(); }
        else controller.enqueue(result.value);
      } catch (error) { usage.failed = true; failureBoundary ||= 'stream_read'; controller.error(error); reader.releaseLock(); done(); }
    },
    async cancel(reason) {
      // Native clients close after the terminal event without waiting for EOF.
      // Keep the observed generation outcome, including any preceding error.
      usage.cancelled = !usage.complete && !usage.failed;
      if(usage.cancelled)failureBoundary='local_cancel';
      try { await reader.cancel(reason); } finally { reader.releaseLock(); done(); }
    },
  });
  return new Response(body, { status: response.status, headers });
}
