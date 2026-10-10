import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, eq } from "drizzle-orm";
import { EngineCapacityError } from "@pointer/engine";
import { apiKeyMiddleware, type ApiKeyContext } from "../middleware/api-key";
import { db, schema } from "../db";
import { resolveModel } from "../services/model-resolution";
import { enginePool, initialEngineConfig } from "../services/engine";
import { ContinuationScope } from "../services/engine-continuation";
import { projectEngineResponse } from "../services/engine-response";
import { engineRequestBoundaryError, normalizeEngineInput } from "../services/engine-request";
import { recordUsage } from "../services/usage-telemetry";
import {projectEngineAttempts, type EngineFailureReceipt} from "../services/engine-failure-receipt";
import { allowLongLivedStream, type PointerRuntimeBindings } from "../http-runtime";

export type InferenceEnv = {
  Variables: ApiKeyContext & { gatewayRequestId: string };
  Bindings: PointerRuntimeBindings;
};
const app = new Hono<InferenceEnv>();
app.use("*", apiKeyMiddleware);
app.use("*", bodyLimit({ maxSize: 32 * 1024 * 1024 }));

export async function forwardInference(c: Context<InferenceEnv>, path: string, adaptedBody?: Record<string, unknown>) {
    const apiKey = c.get("apiKey");
    const requestId = c.get("gatewayRequestId") ?? crypto.randomUUID();
    const fail = (status: 400 | 403 | 404 | 502 | 503, code: string, message: string) =>
      c.json({ ...(path.startsWith("/messages") ? { type: "error" } : {}), error: { type: "invalid_request_error", code, message } }, status);
    let body: Record<string, unknown>;
    try {
      const value = adaptedBody ?? await c.req.json();
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.model !== "string") throw new Error();
      body = value;
    } catch { return fail(400, "invalid_request", "A JSON object with a model is required"); }
    const boundaryError = engineRequestBoundaryError(path, body);
    if (boundaryError) return fail(400, "unsupported_request_scope", boundaryError);
    const route = await resolveModel(body.model as string, apiKey);
    if (!route?.providerAccountId || !route.engineSelector)
      return fail(404, "model_not_found", "This instance has no connected route for that model");
    const authorized: Array<{ account: typeof schema.providerAccounts.$inferSelect; model: string; weight: number }> = [];
    for (const target of route.combo?.targets ?? [{ route, weight: 1 }]) {
      const [account] = await db.select().from(schema.providerAccounts).where(and(
        eq(schema.providerAccounts.id, target.route.providerAccountId!), eq(schema.providerAccounts.userId, apiKey.userId),
        eq(schema.providerAccounts.providerId, target.route.providerId), eq(schema.providerAccounts.status, "active"),
      )).limit(1);
      if (!account?.engineProvider) {
        if (route.combo) continue;
        return fail(403, "connection_unavailable", "The selected connection is unavailable");
      }
      const [available] = await db.select({ id: schema.providerAccountModels.id })
        .from(schema.providerAccountModels)
        .innerJoin(schema.providerModels, eq(schema.providerModels.id, schema.providerAccountModels.providerModelId))
        .where(and(eq(schema.providerAccountModels.providerAccountId, account.id),
          eq(schema.providerModels.providerId, target.route.providerId),
          eq(schema.providerModels.providerModelId, target.route.providerModelId))).limit(1);
      if (available) authorized.push({ account, model: target.route.providerModelId, weight: target.weight });
    }
    if (!authorized.length) return fail(404, "model_unavailable", "No authorized connected route can serve this model");
    const account = authorized[0]!.account;
    // Unavailable targets may be skipped, but no account/model outside the live
    // group is added. The engine owns selection and failover among this subset.
    const comboTargets = authorized.map(target => ({ provider: target.account.engineProvider!, model: target.model, weight: target.weight }));
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret) return fail(503, "configuration_unavailable", "Inference configuration is unavailable");
    const scope = new ContinuationScope(secret, account.userId, apiKey.instanceId);
    if (path.startsWith("/responses") && body.previous_response_id != null) {
      try { body.previous_response_id = scope.decode(body.previous_response_id); }
      catch { return fail(400, "invalid_previous_response_id", "Continuation is unavailable for this instance"); }
    }
    // Provider-visible cache identity cannot collide across application instances.
    for (const field of ["prompt_cache_key", "user"]) if (typeof body[field] === "string")
      body[field] = scope.cacheKey(body[field]);
    normalizeEngineInput(path, body);
    body.model = route.engineSelector;
    allowLongLivedStream(c.env, c.req.raw, body.stream);
    const started = performance.now();
    const usageContext = { requestId, apiKeyId: apiKey.id, userId: apiKey.userId,
      instanceId: apiKey.instanceId, modelId: route.modelId, catalogEntityId: route.catalogEntityId,
      providerId: route.combo ? "group-routing" : route.providerId, providerAccountId: route.combo ? null : account.id, source: apiKey.usageSource ?? "proxy" as const };
    let recorded = false;
    let engineObservation: Parameters<typeof projectEngineResponse>[3];
    let readEngineAttempts: ((receipt:EngineFailureReceipt)=>Promise<EngineFailureReceipt>) | undefined;
    try {
      const response = await enginePool.run(account.userId, initialEngineConfig, async engine => {
        engineObservation = () => engine.observation();
        readEngineAttempts = async receipt => {
          if (!receipt.engineRequestId) return receipt;
          try {
            const log = await engine.management("/api/logs?limit=64", {signal:AbortSignal.timeout(1500)});
            if (!log.ok || !log.body) { await log.body?.cancel(); return receipt; }
            const reader=log.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
            try { while(true) { const next=await reader.read(); if(next.done)break;
              size+=next.value.length; if(size>256*1024){await reader.cancel();return receipt;}chunks.push(next.value); }
            } finally {reader.releaseLock();}
            const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
            receipt.attempts=projectEngineAttempts(JSON.parse(new TextDecoder().decode(bytes)),receipt.engineRequestId);
            if(receipt.attempts) receipt.coverage="engine HTTP/SSE and supported log attempts; per-send details and upstream close unavailable";
          } catch { /* Idle retirement, absent rows and log failures remain gaps. */ }
          return receipt;
        };
        if (route.combo) {
          const targets = comboTargets;
          const desired = { id: route.combo.id, strategy: route.combo.strategy, targets };
          const listed = await engine.management("/api/combos");
          if (!listed.ok) throw new Error("Group routing could not load");
          const saved = (await listed.json() as { combos: Array<typeof desired> }).combos.find(combo => combo.id === desired.id);
          if (!saved || saved.strategy !== desired.strategy || JSON.stringify(saved.targets?.map(({ provider, model, weight }) => ({ provider, model, weight: weight ?? 1 }))) !== JSON.stringify(targets)) {
            const result = await engine.management("/api/combos", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: desired.id, combo: { strategy: desired.strategy, targets: desired.targets } }) });
            await result.body?.cancel(); if (!result.ok) throw new Error("Group routing could not synchronize");
          }
        }
        return engine.inference("/v1" + path, {
          method: "POST", headers: scope.requestHeaders(c.req.raw.headers, requestId), body: JSON.stringify(body), signal: c.req.raw.signal,
        });
      });
      const ttfb = Math.round(performance.now() - started);
      return await projectEngineResponse(response, path.startsWith("/responses") ? scope : null, usage => {
        recorded = true;
        if (path === "/messages/count_tokens") return;
        const status = usage.cancelled ? 499 : response.status >= 400 ? response.status
          : usage.failed || !usage.complete ? 502 : response.status;
        recordUsage(usageContext, usage.input, usage.output, status, Math.round(performance.now() - started), ttfb,
          apiKey.usageSource, { cachedTokens: usage.cached ?? undefined, reasoningTokens: usage.reasoning ?? undefined,
            cacheReadTokens: usage.cacheRead ?? undefined, cacheCreationTokens: usage.cacheCreation ?? undefined,
            upstreamErrorCode: usage.errorCode,
            failureReceipt: usage.receipt,
            failureReceiptPending: usage.receipt && readEngineAttempts ? readEngineAttempts(usage.receipt) : undefined,
            outcome: usage.cancelled ? "client_abort" : usage.failed ? "upstream_error" : !usage.complete ? "incomplete_stream" : "success" });
      }, engineObservation);
    } catch (error) {
      const status = error instanceof EngineCapacityError ? 503 : 502;
      let engine:EngineFailureReceipt["engine"]=null;
      try {engine=engineObservation?.() || null;} catch { /* No lifecycle claim without observation. */ }
      const failureReceipt:EngineFailureReceipt={schema:"pointer.engine-failure.v1",observedAt:new Date().toISOString(),
        initialHttpStatus:null,terminal:"missing",failureCode:null,stage:"before_response",lastEventType:null,events:0,
        firstEventMs:null,lastEventMs:null,totalMs:Math.round(performance.now()-started),
        localCancellation:c.req.raw.signal.aborted ? "client_request_abort" : null,engine,engineRequestId:null,
        attempts:null,physicalAttempts:null,upstreamCloseCode:null,upstreamCloseReason:"unavailable",
        coverage:"no HTTP response head observed; provider cause and physical attempts unavailable"};
      if (!recorded && path !== "/messages/count_tokens") recordUsage(usageContext, 0, 0, status, Math.round(performance.now() - started), null,
        apiKey.usageSource, { outcome: "upstream_error",failureReceipt });
      return fail(status, "inference_unavailable", error instanceof EngineCapacityError
        ? "Inference capacity is busy; retry shortly" : "The inference connection failed");
    }
}

for (const path of ["/responses", "/responses/compact", "/chat/completions", "/messages", "/messages/count_tokens"])
  app.post(path, c => forwardInference(c, path));

export default app;
