import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineProcess } from "../src/process";
import { EngineCapacityError, EnginePool } from "../src/pool";
import { ContinuationScope } from "../../../apps/server/src/services/engine-continuation";
import { projectEngineResponse } from "../../../apps/server/src/services/engine-response";
import { googleEngineRequest, googleEngineResponse } from "../../../apps/server/src/services/engine-google";
import {projectEngineAttempts} from '../../../apps/server/src/services/engine-failure-receipt';

const roots: string[] = [];
const engines: EngineProcess[] = [];
const pools: EnginePool[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const requests: { owner: string; body: any; authorization: string | null }[] = [];
let cancelled = false;

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop();
  for (const engine of engines.splice(0)) await engine.stop();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  requests.length = 0;
  cancelled = false;
});

function upstream(owner: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "fixture-model", object: "model", owned_by: owner }] });
      }
      const body = await req.json() as any;
      requests.push({ owner, body, authorization: req.headers.get("authorization") });
      if (body.messages?.some((row: any) => row.content === "force-provider-error"))
        return Response.json({ error: { message: "Synthetic provider refusal", type: "invalid_request_error" } }, { status: 400 });
      const toolResult = body.messages?.findLast((row: any) => row.role === "tool");
      const toolCall = body.tools?.length && !toolResult;
      const message = toolCall
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: '{"city":"fixture-city"}' } }] }
        : { role: "assistant", content: toolResult ? `result:${toolResult.content}` : `answer-${owner}` };
      if (body.stream) {
        const encoder = new TextEncoder();
        const hold = body.messages?.some((row: any) => row.content === "hold-stream");
        return new Response(new ReadableStream({
          async start(controller) {
            if (hold) {
              req.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`));
              return;
            }
            for (const event of [
              { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: toolCall ? { ...message, tool_calls: message.tool_calls!.map(call => ({ ...call, index: 0 })) } : message, finish_reason: null }] },
              { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
            ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "fixture-model", choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

async function engine(owner: string) {
  const root = await mkdtemp(join(tmpdir(), "pointer-engine-test-"));
  roots.push(root);
  const initialConfig = {
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: upstream(owner), apiKey: `fixture-${owner}`, models: ["fixture-model"], allowPrivateNetwork: true } },
  };
  const process = await EngineProcess.start(root, initialConfig);
  engines.push(process);
  return {
    root, process, initialConfig,
    async request(path: string, body: object) {
      return process.inference(path, { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer ptr_fixture_must_not_leak", "x-api-key": "ptr_fixture_must_not_leak" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    },
  };
}

describe("pinned OpenCodex HTTP engine", () => {
  test('supported request IDs and log attempts correlate to the actual owner process generation',async()=>{
    const service=await engine('diagnostic-correlation');
    const before=service.process.observation();
    // 2.79.0 exposes this correlation header on Responses, the Codex route.
    // Chat is deliberately not guessed from nearby management log rows.
    const chat=await service.request('/v1/chat/completions',{model:'fixture/fixture-model',messages:[{role:'user',content:'hello'}]});
    expect(chat.headers.get('x-opencodex-request-id')).toBeNull();await chat.text();
    const response=await service.request('/v1/responses',{model:'fixture/fixture-model',input:'hello',stream:true});
    const requestId=response.headers.get('x-opencodex-request-id')!;
    expect(requestId).toMatch(/^(?:[A-F0-9]{7}|ocx-[a-f0-9]{32})$/);await response.text();
    const logs=await (await service.process.management('/api/logs?limit=64')).json();
    const attempts=projectEngineAttempts(logs,requestId);
    expect(attempts).not.toBeNull();expect(attempts!.length).toBeGreaterThan(0);
    expect(attempts![0].sendCount).toBeGreaterThan(0);
    expect(service.process.observation().generation).toBe(before.generation);
    expect(before.exitCode).toBeNull();expect(before.signal).toBeNull();
    await service.process.stop();
    const exited=service.process.observation();expect(exited.exitCode!==null || exited.signal!==null).toBe(true);
    const restarted=await EngineProcess.start(service.root,service.initialConfig);engines.push(restarted);
    expect(restarted.observation().generation).not.toBe(before.generation);
  },15000);
  test('custom-tool compatibility preserves provider credentials and unrelated settings across restart', async () => {
    const service = await engine('compatibility');
    const path = '/api/providers/fixture/compatibility';
    expect(await (await service.process.management(path)).json()).toEqual({ supportsResponsesCustomTools: null });
    const invalid = await service.process.management(path, { method: 'PUT', body: JSON.stringify({ supportsResponsesCustomTools: false, apiKey: 'replacement' }) });
    expect(invalid.status).toBe(400);
    const saved = await service.process.management(path, { method: 'PUT', body: JSON.stringify({ supportsResponsesCustomTools: false }) });
    expect(saved.status).toBe(200); await saved.arrayBuffer();
    await service.process.stop();
    const restarted = await EngineProcess.start(service.root, service.initialConfig); engines.push(restarted);
    expect(await (await restarted.management(path)).json()).toEqual({ supportsResponsesCustomTools: false });
    const response = await restarted.inference('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture/fixture-model', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(200); await response.arrayBuffer();
    expect(requests.at(-1)?.authorization).toBe('Bearer fixture-compatibility');
    const providers = await (await restarted.providers()).json() as any[];
    expect(providers.find(row => row.name === 'fixture')).toMatchObject({ adapter: 'openai-chat', models: ['fixture-model'], allowPrivateNetwork: true });
    const cleared = await restarted.management(path, { method: 'PUT', body: JSON.stringify({ supportsResponsesCustomTools: null }) });
    expect(cleared.status).toBe(200); await cleared.arrayBuffer();
    expect(await (await restarted.management(path)).json()).toEqual({ supportsResponsesCustomTools: null });
  }, 60000);
  test('provider model controls use upstream validation and survive a restart', async()=>{
    const service=await engine('model-controls');
    const change=async(path:string,body:object)=>{
      const response=await service.process.management(path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();expect(response.status).toBe(200);return value;
    };
    await change('/api/model-settings',{provider:'fixture',modelId:'fixture-model',contextWindow:65536,inputModalities:['text','image'],reasoningEfforts:['low','high'],defaultReasoningEffort:'low'});
    await change('/api/providers/fixture/model-display-names',{modelId:'fixture-model',displayName:'Saved model name'});
    await change('/api/providers/fixture/model-costs',{modelId:'fixture-model',cost:{input:1,output:2,cacheRead:0.1,cacheWrite:1.25}});
    const added=await service.process.management('/api/custom-models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'fixture',modelId:'endpoint-extra',displayName:'Endpoint model'})});
    expect(added.status).toBe(201);const custom=await added.json() as {id:string};
    const rejected=await service.process.management('/api/model-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'fixture',modelId:'fixture-model',contextWindow:-1})});
    expect(rejected.status).toBe(400);await rejected.body?.cancel();
    await service.process.stop();
    const restarted=await EngineProcess.start(service.root,service.initialConfig);engines.push(restarted);
    const models=await (await restarted.management('/api/models')).json() as Array<{id:string;displayName?:string;contextWindow?:number}>;
    expect(models.find(row=>row.id==='fixture-model')).toMatchObject({displayName:'Saved model name',contextWindow:65536});
    expect(models.some(row=>row.id==='endpoint-extra')).toBe(true);
    expect(await (await restarted.management('/api/providers/fixture/model-costs')).json()).toMatchObject({modelCosts:{'fixture-model':{input:1,output:2}}});
    const removed=await restarted.management('/api/custom-models/'+custom.id,{method:'DELETE'});expect(removed.status).toBe(200);await removed.body?.cancel();
  },60000);
  test("an empty owner can manage connections without receiving engine administration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pointer-engine-connect-test-"));
    roots.push(root);
    const process = await EngineProcess.start(root, { providers: {}, defaultProvider: "openai" });
    engines.push(process);
    const created = await process.management("/api/providers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fixture", setDefault: true, provider: {
        adapter: "openai-chat", baseUrl: upstream("connected"), apiKey: "fixture-connected",
        models: ["fixture-model"], allowPrivateNetwork: true,
      } }),
    });
    expect(created.status).toBe(200);
    await created.arrayBuffer();
    const listed = await process.providers();
    const text = await listed.text();
    expect(listed.status).toBe(200);
    expect(text).toContain('"fixture"');
    expect(text).not.toContain("fixture-connected");
    const response = await process.inference("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/fixture-model", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("answer-connected");
    for (const [path, method] of [
      ["/api/config", "PUT"], ["/api/keys/reveal", "POST"],
      ["/api/providers", "PUT"], ["/api/providers/../config", "GET"],
      ["/api/providers%2f..%2fconfig", "GET"], ["/api/providers/keychain", "POST"],
      ["/api/oauth/accounts/import", "POST"],
    ]) await expect(process.management(path!, { method })).rejects.toThrow("Unsupported engine management operation");
  }, 60000);

  test("separate owner processes retain separate credentials and state", async () => {
    const first = await engine("first");
    const second = await engine("second");
    for (const [owner, service] of [["first", first], ["second", second]] as const) {
      const response = await service.request("/v1/chat/completions", { model: "fixture/fixture-model", messages: [{ role: "user", content: "hello" }], stream: false });
      const payload = await response.json() as any;
      expect(response.status).toBe(200);
      expect(payload.choices[0].message.content).toBe(`answer-${owner}`);
      expect(requests.find(row => row.owner === owner)?.authorization).toBe(`Bearer fixture-${owner}`);
      const config = await readFile(join(service.root, "opencodex", "config.json"), "utf8");
      expect(config).toContain(`fixture-${owner}`);
      expect(config).not.toContain(`fixture-${owner === "first" ? "second" : "first"}`);
    }
  }, 60000);

  test("Responses and Messages stream through the same upstream engine", async () => {
    const service = await engine("stream");
    const responses = await service.request("/v1/responses", { model: "fixture/fixture-model", input: "hello", stream: true });
    expect(responses.status).toBe(200);
    const responseStream = await responses.text();
    expect(responseStream).toContain("response.output_text.delta");
    expect(responseStream).toContain("answer-stream");
    expect(responseStream).toContain("response.completed");
    const messages = await service.request("/v1/messages", { model: "fixture/fixture-model", max_tokens: 256, messages: [{ role: "user", content: "hello" }], stream: true });
    expect(messages.status).toBe(200);
    const messageStream = await messages.text();
    expect(messageStream).toContain("content_block_delta");
    expect(messageStream).toContain("answer-stream");
    expect(messageStream).toContain("message_stop");
  }, 60000);

  test("restart preserves upstream configuration; unsafe route and bind changes fail closed", async () => {
    const service = await engine("restart");
    const providers = await service.process.providers();
    expect(providers.status).toBe(200);
    expect(await providers.text()).not.toContain("fixture-restart");
    await expect(service.process.inference("/api/config")).rejects.toThrow("Unsupported engine inference route");
    await expect(service.process.inference("/v1/models/../../api/config")).rejects.toThrow("Unsupported engine inference route");
    await service.process.stop();
    const restarted = await EngineProcess.start(service.root, { providers: {}, defaultProvider: "unwanted" });
    engines.push(restarted);
    const response = await restarted.inference("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/fixture-model", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).choices[0].message.content).toBe("answer-restart");
    await restarted.stop();
    const configPath = join(service.root, "opencodex", "config.json");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    saved.hostname = "0.0.0.0";
    await writeFile(configPath, JSON.stringify(saved));
    await expect(EngineProcess.start(service.root, service.initialConfig)).rejects.toThrow("managed process boundary");
  }, 60000);

  test("tool call/result continuation preserves correlation and payload", async () => {
    const service = await engine("tools");
    const first = await service.request("/v1/responses", {
      model: "fixture/fixture-model", input: "Look up the fixture city", stream: false, store: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    });
    expect(first.status).toBe(200);
    const payload = await first.json() as any;
    const call = payload.output.find((row: any) => row.type === "function_call");
    expect(call.name).toBe("lookup");
    expect(JSON.parse(call.arguments)).toEqual({ city: "fixture-city" });
    const continued = await service.request("/v1/responses", {
      model: "fixture/fixture-model", previous_response_id: payload.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: "nonce-482-731" }], stream: false,
    });
    expect(continued.status).toBe(200);
    expect(JSON.stringify(await continued.json())).toContain("result:nonce-482-731");
    expect(requests.at(-1)?.body.messages).toContainEqual({ role: "tool", tool_call_id: call.call_id, content: "nonce-482-731" });
  }, 60000);

  test("public continuations are bound to their instance and streaming usage survives projection", async () => {
    const service = await engine("scoped");
    const firstScope = new ContinuationScope("fixture-only-secret", "owner", "first-app");
    const secondScope = new ContinuationScope("fixture-only-secret", "owner", "second-app");
    const otherOwner = new ContinuationScope("fixture-only-secret", "other-owner", "first-app");
    const usage: unknown[] = [];
    const first = await projectEngineResponse(await service.request("/v1/responses", {
      model: "fixture/fixture-model", input: "hello", stream: false, store: true,
    }), firstScope, value => usage.push(value));
    const payload = await first.json() as any;
    expect(payload.id).toStartWith("resp_ptr_");
    expect(() => secondScope.decode(payload.id)).toThrow("Invalid continuation");
    expect(() => otherOwner.decode(payload.id)).toThrow("Invalid continuation");
    expect(() => firstScope.decode(firstScope.decode(payload.id))).toThrow("Invalid continuation");
    const continued = await service.request("/v1/responses", {
      model: "fixture/fixture-model", previous_response_id: firstScope.decode(payload.id), input: "next", stream: true,
    });
    const projected = await projectEngineResponse(continued, firstScope, value => usage.push(value));
    const stream = await projected.text();
    expect(stream).toContain("response.completed");
    expect(stream).toContain("resp_ptr_");
    expect(stream).toContain("answer-scoped");
    expect(usage).toHaveLength(2);
    expect(usage.at(-1)).toMatchObject({ input: 3, output: 2, complete: true, failed: false, cancelled: false });
  }, 60000);

  test("Gemini ingress uses engine Responses with streamed tools and a matching tool result", async () => {
    const service = await engine("gemini");
    const contents = [{ role: "user", parts: [{ text: "Look up fixture-city" }] }];
    const declarations = [{ functionDeclarations: [{ name: "lookup", parameters: {
      type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"],
    } }] }];
    const request = googleEngineRequest({ contents, tools: declarations }, "fixture/fixture-model", true);
    const response = await googleEngineResponse(await service.request("/v1/responses", request), "Public model", "fixture-gemini");
    const stream = await response.text();
    expect(stream).toContain('"functionCall"');
    expect(stream).toContain('"name":"lookup"');
    expect(stream).toContain('"city":"fixture-city"');
    expect(stream).toContain('"finishReason"');
    const events = stream.split("\n\n").filter(row => row.startsWith("data: ")).map(row => JSON.parse(row.slice(6)));
    const call = events.flatMap(event => event.candidates?.flatMap((candidate: any) => candidate.content?.parts ?? []) ?? []).find((part: any) => part.functionCall)?.functionCall;
    expect(call?.id).toBe("call_fixture");
    const continued = googleEngineRequest({ contents: [...contents,
      { role: "model", parts: [{ functionCall: call }] },
      { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { result: "gemini-nonce-17" } } }] },
    ], tools: declarations }, "fixture/fixture-model", false);
    const result = await googleEngineResponse(await service.request("/v1/responses", continued), "Public model", "fixture-gemini-next");
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).toContain("gemini-nonce-17");
    expect(requests.at(-1)?.body.messages.some((row: any) => row.role === "tool" && row.tool_call_id === call.id)).toBe(true);
  }, 60000);

  test("provider errors stay failures and cancelled streams release the upstream", async () => {
    const service = await engine("failure");
    const refused = await service.request("/v1/responses", { model: "fixture/fixture-model", input: "force-provider-error", stream: false });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await refused.json())).not.toContain('"status":"completed"');
    const controller = new AbortController();
    const response = await service.process.inference("/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/fixture-model", input: "hold-stream", stream: true }), signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let attempt = 0; attempt < 40 && !cancelled; attempt++) await Bun.sleep(50);
    expect(cancelled).toBe(true);
  }, 60000);

  test("bounded pool holds capacity until a stream ends and preserves evicted owner state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pointer-engine-pool-test-"));
    roots.push(root);
    const pool = new EnginePool(root, 1);
    pools.push(pool);
    const config = (owner: string) => ({ defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: upstream(owner), apiKey: `fixture-${owner}`, models: ["fixture-model"], allowPrivateNetwork: true },
    } });
    const firstConfig = config("pool-first");
    const secondConfig = config("pool-second");
    const request = (engine: EngineProcess, input: string) => engine.inference("/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/fixture-model", input, stream: true }),
    });
    const held = await pool.run("owner-first", firstConfig, engine => request(engine, "hold-stream"));
    expect(held.status).toBe(200);
    await expect(pool.run("owner-second", secondConfig, engine => request(engine, "hello"))).rejects.toBeInstanceOf(EngineCapacityError);
    await held.body!.cancel();
    pool.hold("owner-first", "login:fixture", 60000);
    await expect(pool.run("owner-second", secondConfig, engine => request(engine, "hello"))).rejects.toBeInstanceOf(EngineCapacityError);
    pool.releaseHold("owner-first", "login:fixture");
    const second = await pool.run("owner-second", secondConfig, engine => request(engine, "hello"));
    expect(await second.text()).toContain("answer-pool-second");
    const firstAgain = await pool.run("owner-first", { providers: {}, defaultProvider: "unwanted" }, engine => request(engine, "hello"));
    expect(await firstAgain.text()).toContain("answer-pool-first");
  }, 60000);
});
