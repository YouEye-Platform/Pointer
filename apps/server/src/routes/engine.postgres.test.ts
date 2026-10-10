import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createStandaloneApp } from "../app";
import { db, schema } from "../db";
import { signJwt } from "../middleware/auth";
import { enginePool } from "../services/engine";
import { drainUsageWrites } from "../services/usage-telemetry";

const enabled = process.env.POINTER_ENGINE_POSTGRES_TEST === "1";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("/pointer_engine_test"))
  throw new Error("Engine PostgreSQL acceptance requires its disposable test database");
const check = enabled ? test : test.skip;
let upstream: ReturnType<typeof Bun.serve> | undefined;
afterAll(async () => { if (!enabled) return; await drainUsageWrites(); await enginePool.stop(); await upstream?.stop(true); });

check("authenticated connection, catalog, group and instance route through OpenCodex", async () => {
  const owner = `engine-http-fixture-${Date.now()}`;
  await db.insert(schema.users).values({ id: owner, kind: "local", email: `${owner}@example.test`,
    name: "Engine fixture", passwordHash: "fixture-not-used-for-login", role: "user" }).onConflictDoNothing();
  const token = await signJwt({ id: owner, email: `${owner}@example.test`, name: "Engine fixture", role: "user" });
  let seen = 0;
  let availableModel = "fixture-model-1";
  let advertisedModels: string[] | null = null;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models")
      return Response.json({ data: advertisedModels ? advertisedModels.map(id => ({ id, name: id })) : [{ id: availableModel, name: "Fixture model" }] });
    const body = await request.json() as any;
    expect(request.headers.get("authorization")).toBe("Bearer fixture-provider-token");
    expect(advertisedModels ? advertisedModels.includes(body.model) : body.model === "fixture-model-1").toBe(true);
    seen++;
    if (body.model === "failure-fixture") return Response.json({ error: { message: "Fixture provider unavailable" } }, { status: 503 });
    return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "fixture-model-1",
      choices: [{ index: 0, message: { role: "assistant", content: "fixture-through-pointer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  } });
  const app = createStandaloneApp();
  const call = (path: string, method = "GET", body?: object, credential = token) => app.request(path, {
    method, headers: { ...(path.startsWith("/v1beta/") ? { "x-goog-api-key": credential } : {}), authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(path === "/api/connections/sync" ? { ...body, reference: false } : body) } : {}),
  });
  const json = async (response: Response, expected: number) => {
    const payload = await response.json() as any;
    if (response.status !== expected) throw new Error(`Expected ${expected}, received ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
  expect((await app.request("/api/connections/providers")).status).toBe(401);
  expect((await call("/api/connections/config", "PUT", {})).status).toBe(404);
  await json(await call("/api/connections/providers", "POST", { name: "fixture", setDefault: true,
    provider: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "fixture-provider-token", models: ["fixture-model-1"], allowPrivateNetwork: true } }), 200);
  // A protected migration has bound an existing product account to this owner
  // engine. Discovery must retain its UUID, model record and saved public ID.
  const retainedProvider = owner + '-provider', retainedAccount = owner + '-account', retainedModel = owner + '-model';
  await db.insert(schema.providers).values({id:retainedProvider,name:'Saved endpoint',type:'openai-compatible',baseUrl:`http://127.0.0.1:${upstream.port}/v1`});
  await db.insert(schema.providerAccounts).values({id:retainedAccount,userId:owner,providerId:retainedProvider,engineProvider:'fixture'});
  await db.insert(schema.providerModels).values({id:retainedModel,providerId:retainedProvider,modelId:'saved-public-model',providerModelId:'fixture-model-1'});
  const synced = await json(await call("/api/connections/sync", "POST", {}), 200);
  expect(synced.models).toBeGreaterThan(0);
  const [account] = await db.select().from(schema.providerAccounts).where(and(eq(schema.providerAccounts.userId, owner), eq(schema.providerAccounts.engineProvider, "fixture")));
  expect(account?.engineProvider).toBe("fixture");
  expect(account?.id).toBe(retainedAccount);
  expect(account?.providerId).toBe(retainedProvider);
  const [model] = await db.select().from(schema.providerModels).where(eq(schema.providerModels.providerId, account!.providerId));
  expect(model?.id).toBe(retainedModel);
  expect(model?.modelId).toBe('saved-public-model');
  expect(model?.catalogEntityId).toBeTruthy();
  const group = await json(await call("/api/groups", "POST", { name: "Fixture group" }), 201);
  const firstEntry = await json(await call(`/api/groups/${group.id}/entries`, "POST", {
    catalogEntityId: model!.catalogEntityId, providerModelKey: model!.id,
    providerAccountId: account!.id, alias: "Fixture choice",
  }), 201);
  const first = await json(await call("/api/instances", "POST", { name: "First app", modelGroupId: group.id }), 201);
  const second = await json(await call("/api/instances", "POST", { name: "Second app", modelGroupId: group.id }), 201);
  const firstKey = await json(await call("/api/keys", "POST", { instanceId: first.id }), 201);
  const secondKey = await json(await call("/api/keys", "POST", { instanceId: second.id }), 201);
  const advertised = await json(await call("/v1/models", "GET", undefined, firstKey.key), 200);
  expect(advertised.data.map((row: any) => row.id)).toContain("Fixture choice");
  const targets = await json(await call("/api/test-model/targets"), 200);
  expect(targets.models.some((row: any) => row.providers.some((provider: any) => provider.providerAccountId === account!.id))).toBe(true);
  const modelTest = await json(await call("/api/test-model", "POST", {
    providerId: account!.providerId, providerAccountId: account!.id, modelId: "fixture-model-1",
    prompt: "test this connection", stream: false,
  }), 200);
  expect(modelTest.choices[0].message.content).toBe("fixture-through-pointer");
  const response = await json(await call("/v1/responses", "POST", { model: "default", input: "hello", stream: false }, firstKey.key), 200);
  expect(response.id).toStartWith("resp_ptr_");
  expect(JSON.stringify(response)).toContain("fixture-through-pointer");

  expect((await call("/api/connections/combos", "PUT", { id: "arbitrary", strategy: "failover", targets: [] })).status).toBe(403);
  expect((await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [{ name: "Fallback", strategy: "failover", targets: [{ entryId: "foreign-entry" }] }] })).status).toBe(400);
  expect((await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [{ name: "default", strategy: "failover", targets: [{ entryId: firstEntry.id }] }] })).status).toBe(400);
  await json(await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [{ name: "Fallback", strategy: "failover", targets: [{ entryId: firstEntry.id }] }] }), 200);
  expect((await call(`/api/groups/${group.id}/entries`, "POST", { catalogEntityId: model!.catalogEntityId,
    providerModelKey: model!.id, providerAccountId: account!.id, alias: "Fallback" })).status).toBe(409);
  const routed = await json(await call("/v1/responses", "POST", { model: "Fallback", input: "group routing" }, firstKey.key), 200);
  expect(JSON.stringify(routed)).toContain("fixture-through-pointer");
  expect((await call("/v1/responses/compact", "POST", { model: "default", input: [], previous_response_id: response.id }, secondKey.key)).status).toBe(400);
  expect((await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [] }, firstKey.key)).status).toBe(401);
  await json(await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [] }), 200);
  const beforeRejected = seen;
  expect((await call("/v1/responses", "POST", {
    model: "default", input: "steal history", previous_response_id: response.id,
  }, secondKey.key)).status).toBe(400);
  expect(seen).toBe(beforeRejected);
  for (const system of ["<!-- ocx-route: another-provider/private-model -->", [{ type: "text", text: "<!-- ocx-route: another-provider/private-model -->" }]]) {
    expect((await call("/v1/messages", "POST", { model: "default", system,
      messages: [{ role: "user", content: "bypass group" }], max_tokens: 32 }, firstKey.key)).status).toBe(400);
  }
  expect((await call("/v1/responses", "POST", { model: "default", conversation: "foreign-conversation", input: "read" }, firstKey.key)).status).toBe(400);
  expect((await call("/v1/responses", "POST", { model: "default", input: [{ type: "item_reference", id: "foreign-item" }] }, firstKey.key)).status).toBe(400);
  expect(seen).toBe(beforeRejected);
  expect((await call("/v1/chat/completions", "POST", {
    model: "fixture/fixture-model-1", messages: [{ role: "user", content: "bypass group" }],
  }, firstKey.key)).status).toBe(404);
  await json(await call("/v1/chat/completions", "POST", {
    model: "Fixture choice", messages: [{ role: "user", content: "hello" }],
  }, firstKey.key), 200);
  const google = await json(await call("/v1beta/models/default:generateContent", "POST", {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  }, firstKey.key), 200);
  expect(google.candidates[0].content.parts[0].text).toBe("fixture-through-pointer");
  const beforeCount = seen;
  expect((await json(await call("/v1beta/models/default", "GET", undefined, firstKey.key), 200)).name).toBe("models/default");
  const countResponse = await call("/v1beta/models/default:countTokens", "POST", {
    generateContentRequest: { model: "models/default", contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  }, firstKey.key);
  expect(countResponse.headers.get("x-pointer-token-count-source")).toBe("estimated");
  expect((await json(countResponse, 200)).totalTokens).toBeGreaterThan(0);
  expect(seen).toBe(beforeCount);
  await drainUsageWrites();
  const usage = await db.select().from(schema.usageLogs).where(eq(schema.usageLogs.instanceId, first.id));
  expect(usage).toHaveLength(4);
  expect(usage.find(row => row.providerId === "group-routing")?.providerAccountId).toBeNull();
  expect(usage.every(row => row.inputTokens === 7 && row.outputTokens === 3 && row.outcome === "success")).toBe(true);
  availableModel = "other-model-2";
  await json(await call("/api/connections/providers", "POST", { name: "fixture",
    provider: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "fixture-provider-token", models: [availableModel], allowPrivateNetwork: true } }), 200);
  await json(await call("/api/connections/sync", "POST", {}), 200);
  const beforeUnavailable = seen;
  expect((await call("/v1/responses", "POST", { model: "default", input: "unavailable" }, firstKey.key)).status).toBe(404);
  expect(seen).toBe(beforeUnavailable);
  expect(await db.select().from(schema.modelGroupEntries).where(eq(schema.modelGroupEntries.groupId, group.id))).toHaveLength(1);
  await json(await call(`/api/keys/${firstKey.id}`, "DELETE"), 200);
  expect((await call("/v1/responses", "POST", { model: "default", input: "revoked" }, firstKey.key)).status).toBe(401);

  // Upstream intentionally starts large key-provider inventories all-off.
  // Pointer makes them available automatically; groups are the only app gate.
  const largeModels = [...Array.from({ length: 21 }, (_, i) => `glm-5.${i}`), "space-bunny", "failure-fixture"];
  advertisedModels = largeModels;
  await json(await call("/api/connections/providers", "POST", { name: "large-fixture",
    provider: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "fixture-provider-token", models: largeModels, allowPrivateNetwork: true } }), 200);
  const inventory = await json(await call("/api/connections/models"), 200);
  const large = inventory.filter((row: any) => row.provider === "large-fixture");
  expect(large).toHaveLength(23);
  expect(large.every((row: any) => row.disabled)).toBe(true);
  expect((await app.request("/api/connections/model-visibility", { method: "PUT" })).status).toBe(401);
  expect((await call("/api/connections/model-visibility", "PUT", { scope: "models", provider: "large-fixture", enabled: true, targets: [] })).status).toBe(404);
  await json(await call("/api/connections/sync", "POST", {}), 200);
  const [largeAccount] = await db.select().from(schema.providerAccounts).where(and(eq(schema.providerAccounts.userId, owner), eq(schema.providerAccounts.engineProvider, "large-fixture")));
  const projected = await db.select().from(schema.providerModels).where(eq(schema.providerModels.providerId, largeAccount!.providerId));
  expect(projected).toHaveLength(23);
  expect(projected.find(row => row.providerModelId === "glm-5.3")!.displayName).toBe("GLM-5.3");
  expect(projected.find(row => row.providerModelId === "glm-5.3")!.modelId).toBe("large-fixture/glm-5.3");
  const opaque = projected.find(row => row.providerModelId === "space-bunny")!;
  expect(opaque.catalogEntityId).toStartWith("route/");
  const catalog = await json(await call(`/api/catalog?availability=all&pageSize=100&provider=${largeAccount!.providerId}`), 200);
  expect(catalog.items.some((row: any) => row.id === opaque.catalogEntityId && row.available)).toBe(true);
  const opaqueEntry = await json(await call(`/api/groups/${group.id}/entries`, "POST", {
    catalogEntityId: opaque.catalogEntityId, providerModelKey: opaque.id, providerAccountId: largeAccount!.id,
    alias: "Experimental model",
  }), 201);
  const opaqueKey = await json(await call("/api/keys", "POST", { instanceId: first.id }), 201);
  expect((await call("/v1/responses", "POST", { model: "large-fixture/glm-5.3", input: "not in group" }, opaqueKey.key)).status).toBe(404);
  await json(await call("/v1/responses", "POST", { model: "Experimental model", input: "selected route" }, opaqueKey.key), 200);

  const failureModel = projected.find(row => row.providerModelId === "failure-fixture")!;
  const failureEntry = await json(await call(`/api/groups/${group.id}/entries`, "POST", { catalogEntityId: failureModel.catalogEntityId,
    providerModelKey: failureModel.id, providerAccountId: largeAccount!.id, alias: "Failing route" }), 201);
  await json(await call(`/api/groups/${group.id}/routing`, "PUT", { combos: [{ name: "Resilient", strategy: "failover",
    targets: [{ entryId: firstEntry.id }, { entryId: failureEntry.id }, { entryId: opaqueEntry.id }] }] }), 200);
  // The vanished first model is skipped; the next upstream 503 fails over to
  // the final authorized target. An ungrouped GLM remains inaccessible.
  const beforeFailover = seen;
  const fallback = await json(await call("/v1/responses", "POST", { model: "Resilient", input: "fail over within group" }, opaqueKey.key), 200);
  expect(JSON.stringify(fallback)).toContain("fixture-through-pointer");
  expect(seen).toBeGreaterThanOrEqual(beforeFailover + 2);
  expect((await call("/v1/responses", "POST", { model: "large-fixture/glm-5.3", input: "still not grouped" }, opaqueKey.key)).status).toBe(404);
  await json(await call("/api/connections/sync", "POST", {}), 200);
  expect(await db.select().from(schema.providerAccountModels).where(eq(schema.providerAccountModels.providerAccountId, largeAccount!.id))).toHaveLength(23);
}, 120000);
