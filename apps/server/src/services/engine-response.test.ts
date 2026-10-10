import { expect, test } from "bun:test";
import { projectEngineResponse, type EngineUsage } from "./engine-response";
import { ContinuationScope } from "./engine-continuation";

const stream = (events: unknown[]) => new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
});
test('HTTP 200 error events retain a safe rejecting code and never become success', async () => {
  for (const code of ['context_length_exceeded', 'private-provider-payload']) {
    let usage: EngineUsage | undefined;
    const response = await projectEngineResponse(stream([{ type:'error', error:{ code, message:'private fixture message' } }, '[DONE]']), null, value=>{usage=value});
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(code);
    expect(usage?.failed).toBe(true);
    expect(usage?.complete).toBe(false);
    expect(usage?.errorCode).toBe(code==='context_length_exceeded' ? code : null);
    expect(JSON.stringify(usage)).not.toContain('private fixture message');
  }
});
test("a transport terminator does not certify an incomplete Responses generation", async () => {
  let usage: EngineUsage | undefined;
  const response = await projectEngineResponse(stream([{ type: "response.created", response: { id: "resp_fixture" } }, "[DONE]"]),
    new ContinuationScope("fixture-secret", "owner", "instance"), value => { usage = value; });
  await response.text();
  expect(usage?.complete).toBe(false);
});
test("chat completion needs a finish reason before the transport terminator", async () => {
  for (const complete of [false, true]) {
    let usage: EngineUsage | undefined;
    const response = await projectEngineResponse(stream([{ choices: [{ delta: { content: "hello" }, finish_reason: complete ? "stop" : null }] }, "[DONE]"]),
      null, value => { usage = value; });
    await response.text();
    expect(usage?.complete).toBe(complete);
  }
});

test("cache and reasoning accounting preserves missing vs reported zero and inclusive prompt size", async () => {
  for (const [wire, expected] of [
    [{ input_tokens: 10, output_tokens: 3 }, { input: 10, cached: null, reasoning: null }],
    [{ input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }, { input: 10, cached: 0, reasoning: 2 }],
    [{ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }, { input: 22, cacheRead: 5, cacheCreation: 7 }],
  ] as const) {
    let usage: EngineUsage | undefined;
    const response = await projectEngineResponse(Response.json({ usage: wire }), null, value => { usage = value; });
    await response.text(); expect(usage).toMatchObject(expected);
  }
});


test("held-open streams retain their terminal outcome when the native client closes", async () => {
  for (const [events, expected] of [
    [[{ type: "response.completed", response: { usage: { input_tokens: 42, output_tokens: 3 } } }], { complete: true, cancelled: false, failed: false, input: 42 }],
    [[{ type: "message_stop" }], { complete: true, cancelled: false, failed: false }],
    [[{ type: "response.output_text.delta", delta: "unfinished" }], { complete: false, cancelled: true, failed: false }],
    [[{ type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }, { type: "response.completed" }], { complete: true, cancelled: false, failed: true }],
  ] as const) {
    let result: EngineUsage | undefined;
    let finishCount = 0;
    let upstreamCancelled = false;
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
      cancel() { upstreamCancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const response = await projectEngineResponse(upstream, null, usage => { result = { ...usage }; finishCount++; });
    const reader = response.body!.getReader();
    for (const _ of events) expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(result).toMatchObject(expected);
    expect(finishCount).toBe(1);
    expect(upstreamCancelled).toBe(true);
  }
});

test('initial 200 followed by reset preserves stage, known event types and explicit upstream gaps',async()=>{
 let observed:EngineUsage|undefined;
 const response=await projectEngineResponse(stream([
  {type:'response.created',response:{id:'private-provider-id'}},
  {type:'response.output_text.delta',delta:'private-output'},
  {type:'error',error:{code:'upstream_reset',message:'private close reason token'}},
 ]),null,u=>{observed=u});
 await response.text();
 expect(observed?.receipt).toMatchObject({initialHttpStatus:200,terminal:'failed',failureCode:'upstream_reset',stage:'after_response_start',events:3,physicalAttempts:null,upstreamCloseCode:null,upstreamCloseReason:'unavailable'});
 expect(JSON.stringify(observed)).not.toContain('private');
});
test('unknown event names and malformed/truncated streams retain no arbitrary diagnostic text',async()=>{
 let observed:EngineUsage|undefined;
 const response=await projectEngineResponse(stream([{type:'secret-provider-type',message:'private'},'not-json']),null,u=>{observed=u});
 await expect(response.text()).rejects.toThrow();
 expect(observed?.failed).toBe(true);expect(observed?.receipt?.lastEventType).toBeNull();
 expect(observed?.receipt?.failureBoundary).toBe('malformed_event');
 expect(JSON.stringify(observed)).not.toContain('secret');expect(JSON.stringify(observed)).not.toContain('private');
});
test('capture callbacks cannot change model outcomes or inject a generation replay',async()=>{
 let calls=0;
 const response=await projectEngineResponse(stream([{type:'response.completed'}]),null,()=>{calls++;throw Error('capture unavailable')},()=>{throw Error('observation unavailable')});
 expect(await response.text()).toContain('response.completed');expect(calls).toBe(1);
});
