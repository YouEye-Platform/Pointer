import { Hono } from "hono";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db";
import { hashApiKey } from "../middleware/api-key";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { invalidateModelResolutionCache } from "../services/model-resolution";
import { registerTestKey, unregisterTestKey } from "../services/internal-test-keys";
import { drainUsageWrites } from "../services/usage-telemetry";
import { buildTestModelTargets } from "../services/test-model-targets";
import { compareRecommended } from "../services/catalog-ranking";
import { loadCatalog } from "./catalog";
import proxyRoutes from "./proxy";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);

const requestSchema = z.object({
  providerId: z.string().min(1),
  providerAccountId: z.string().min(1),
  modelId: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  stream: z.boolean().default(true),
  maxTokens: z.number().int().min(1).max(4096).default(256),
});

app.get("/targets", async (c) => {
  const user = c.get("user");
  const rows = await db.select({
    providerId: schema.providers.id,
    providerName: schema.providers.name,
    providerStatus: schema.providers.status,
    providerManifestPath: schema.providers.manifestPath,
    providerAccountId: schema.providerAccounts.id,
    providerAccountNickname: schema.providerAccounts.nickname,
    modelId: schema.providerModels.modelId,
    providerModelId: schema.providerModels.providerModelId,
    catalogEntityId: schema.providerModels.catalogEntityId,
    canonicalModelId: schema.providerModels.canonicalModelId,
    canonicalName: schema.modelCatalog.name,
  }).from(schema.providerAccountModels)
    .innerJoin(schema.providerAccounts, eq(schema.providerAccountModels.providerAccountId, schema.providerAccounts.id))
    .innerJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
    .innerJoin(schema.providerModels, eq(schema.providerAccountModels.providerModelId, schema.providerModels.id))
    .innerJoin(schema.providers, eq(schema.providerModels.providerId, schema.providers.id))
    .leftJoin(schema.modelCatalog, eq(schema.providerModels.canonicalModelId, schema.modelCatalog.modelId))
    .where(and(
      eq(schema.providerAccounts.userId, user.id),
      eq(schema.providerAccounts.status, "active"),
      eq(schema.providers.status, "active"),
      isNotNull(schema.providerModels.catalogEntityId)
    ));

  const catalog = await loadCatalog(user.id);
  const orderedCatalog = catalog?.items.slice().sort(compareRecommended) ?? [];
  const targetResult = buildTestModelTargets(rows, orderedCatalog.map((item) => item.id));
  const catalogById = new Map(orderedCatalog.map((item) => [item.id, item]));
  return c.json({
    ...targetResult,
    models: targetResult.models.map((model) => {
      const catalogItem = catalogById.get(model.id);
      return {
        ...model,
        creator: catalogItem?.creator ?? null,
        modelIconKey: catalogItem?.modelIconKey ?? catalogItem?.creatorIconKey ?? null,
        aliases: catalogItem?.aliases.map((alias) => alias.alias) ?? [],
      };
    }),
  });
});

app.post("/", async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const user = c.get("user");
  const { providerId, providerAccountId, modelId, prompt, stream, maxTokens } = parsed.data;

  const [rawProviderModel] = await db.select().from(schema.providerModels).where(and(
      eq(schema.providerModels.providerId, providerId),
      eq(schema.providerModels.providerModelId, modelId),
      isNotNull(schema.providerModels.catalogEntityId),
    )).limit(1);
  const [legacyProviderModel] = rawProviderModel ? [] : await db.select().from(schema.providerModels).where(and(
    eq(schema.providerModels.providerId, providerId),
    isNotNull(schema.providerModels.catalogEntityId),
    or(
      eq(schema.providerModels.modelId, modelId),
      eq(schema.providerModels.canonicalModelId, modelId),
    ),
  )).limit(1);
  const providerModel = rawProviderModel ?? legacyProviderModel;
  if (!providerModel) return c.json({ error: "Model is not available from that provider" }, 404);
  const [providerKey] = await db.select({ id: schema.providerKeys.id }).from(schema.providerKeys)
    .innerJoin(schema.providerAccounts, eq(schema.providerAccounts.id, schema.providerKeys.providerAccountId))
    .innerJoin(schema.providerAccountModels, and(
      eq(schema.providerAccountModels.providerAccountId, schema.providerAccounts.id),
      eq(schema.providerAccountModels.providerModelId, providerModel.id),
    ))
    .where(and(
      eq(schema.providerKeys.userId, user.id),
      eq(schema.providerKeys.providerId, providerId),
      eq(schema.providerKeys.providerAccountId, providerAccountId),
      eq(schema.providerAccounts.status, "active"),
    )).limit(1);
  if (!providerKey) return c.json({ error: "Provider credential is not configured" }, 400);

  const suffix = nanoid(12);
  const instanceId = `test_${suffix}`;
  const apiKeyId = `test_key_${suffix}`;
  const apiKey = `ptr_test_${nanoid(32)}`;
  await db.transaction(async (tx) => {
    await tx.insert(schema.instances).values({ id: instanceId, userId: user.id, name: "Temporary model test" });
    await tx.insert(schema.instanceModels).values({
      id: `test_model_${suffix}`,
      instanceId,
      modelId: providerModel.modelId,
      providerId,
      providerAccountId,
      enabled: true,
      isDefault: true,
      priority: 0,
      source: "custom",
      alias: providerModel.modelId,
    });
    await tx.insert(schema.apiKeys).values({
      id: apiKeyId,
      userId: user.id,
      instanceId,
      keyHash: await hashApiKey(apiKey),
      keyPreview: "ptr_test_...",
      name: "Temporary model test",
      allowedModels: ["*"],
    });
  });
  invalidateModelResolutionCache(instanceId);
  registerTestKey(apiKeyId);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => cleanupPromise ??= (async () => {
    await drainUsageWrites();
    unregisterTestKey(apiKeyId);
    invalidateModelResolutionCache(instanceId);
    await db.delete(schema.instances).where(eq(schema.instances.id, instanceId));
  })();

  let response: Response;
  try {
    response = await proxyRoutes.fetch(new Request("http://pointer.test/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: providerModel.modelId,
        messages: [{ role: "user", content: prompt }],
        stream,
        max_tokens: maxTokens,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
    }));
  } catch (error) {
    await cleanup();
    throw error;
  }

  if (!response.body || !stream || !response.ok) {
    const body = await response.arrayBuffer();
    await cleanup();
    if (!response.ok) {
      let message = "Provider test failed";
      try {
        const parsedBody = JSON.parse(new TextDecoder().decode(body));
        const candidate = parsedBody?.error?.message;
        if (typeof candidate === "string" && !candidate.startsWith("Provider error:")) message = candidate;
      } catch { /* Return the stable error without upstream content. */ }
      return c.json({ error: message, upstreamStatus: response.status }, 502);
    }
    return new Response(body, { status: response.status, headers: response.headers });
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (!chunk.done) return controller.enqueue(chunk.value);
        controller.close();
        await cleanup();
      } catch (error) {
        await cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await cleanup();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
});

export default app;
