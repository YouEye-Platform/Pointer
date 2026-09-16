import { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { encrypt, decrypt } from "../services/encryption";
import { parseProviderCredential } from "../services/provider-credential-codec";
import { credentialStatus } from "../services/oauth-lifecycle";
import { validatePublicHttpsEndpoint } from "../services/custom-endpoint";
import { registry } from "../providers/registry";
import { syncProviderModels } from "../services/model-sync";
import { fetchProviderModels } from "../providers/model-discovery";
import { resolveProviderIconKey } from "../services/brand-icons";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);

const createSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  nickname: z.string().trim().min(1).max(100).nullable().optional(),
  apiKey: z.string().min(1).max(20_000),
  baseUrl: z.string().trim().max(2_000).optional(),
}).strict();

const updateSchema = z.object({
  nickname: z.string().trim().min(1).max(100).nullable().optional(),
  apiKey: z.string().min(1).max(20_000).optional(),
  baseUrl: z.string().trim().max(2_000).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict();

async function ownedAccount(id: string, userId: string) {
  const [account] = await db.select().from(schema.providerAccounts)
    .where(and(eq(schema.providerAccounts.id, id), eq(schema.providerAccounts.userId, userId)))
    .limit(1);
  return account ?? null;
}

app.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db.select({
    id: schema.providerAccounts.id,
    providerId: schema.providerAccounts.providerId,
    nickname: schema.providerAccounts.nickname,
    baseUrl: schema.providerAccounts.baseUrl,
    status: schema.providerAccounts.status,
    createdAt: schema.providerAccounts.createdAt,
    updatedAt: schema.providerAccounts.updatedAt,
    providerName: schema.providers.name,
    providerType: schema.providers.type,
    authType: schema.providers.authType,
    isBuiltin: schema.providers.isBuiltin,
    manifestPath: schema.providers.manifestPath,
    credentialConfigured: sql<boolean>`${schema.providerKeys.id} is not null`,
  }).from(schema.providerAccounts)
    .innerJoin(schema.providers, eq(schema.providers.id, schema.providerAccounts.providerId))
    .leftJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
    .where(eq(schema.providerAccounts.userId, user.id))
    .orderBy(asc(schema.providerAccounts.createdAt), asc(schema.providerAccounts.id));
  return c.json(rows.map(({ manifestPath, ...row }) => {
    const manifest = registry.getProvider(row.providerId)?.manifest;
    const endpointMode = manifest?.endpoint?.mode ?? "fixed";
    return {
      ...row,
      iconKey: resolveProviderIconKey({ id: row.providerId, manifestPath }),
      displayName: row.nickname || `${row.providerName} · ${row.id.slice(-6)}`,
      baseUrl: endpointMode === "required" ? row.baseUrl : null,
      endpoint: manifest?.endpoint ?? { mode: "fixed" },
    };
  }));
});

app.get("/:id", async (c) => {
  const user = c.get("user");
  const account = await ownedAccount(c.req.param("id"), user.id);
  if (!account) return c.json({ error: "Account not found", code: "account_not_found" }, 404);
  const [provider, models, credential] = await Promise.all([
    db.select({
      name: schema.providers.name,
      type: schema.providers.type,
      status: schema.providers.status,
      authType: schema.providers.authType,
      isBuiltin: schema.providers.isBuiltin,
      manifestPath: schema.providers.manifestPath,
    }).from(schema.providers).where(eq(schema.providers.id, account.providerId)).limit(1).then((rows) => rows[0]),
    db.select({
      providerModelKey: schema.providerModels.id,
      modelId: schema.providerModels.modelId,
      rawModelId: schema.providerModels.providerModelId,
      name: schema.providerModels.displayName,
      catalogEntityId: schema.providerModels.catalogEntityId,
      slug: schema.modelEntities.stableSlug,
      contextWindow: schema.providerModels.contextWindow,
      maxOutput: schema.providerModels.maxOutput,
      inputPrice: schema.providerModels.inputPrice,
      outputPrice: schema.providerModels.outputPrice,
      supportsTools: schema.providerModels.supportsTools,
      supportsVision: schema.providerModels.supportsVision,
      supportsStreaming: schema.providerModels.supportsStreaming,
    }).from(schema.providerAccountModels)
      .innerJoin(schema.providerModels, eq(schema.providerModels.id, schema.providerAccountModels.providerModelId))
      .leftJoin(schema.modelEntities, eq(schema.modelEntities.id, schema.providerModels.catalogEntityId))
      .where(eq(schema.providerAccountModels.providerAccountId, account.id))
      .orderBy(asc(schema.providerModels.displayName), asc(schema.providerModels.providerModelId)),
    db.select({ id: schema.providerKeys.id, encrypted: schema.providerKeys.apiKeyEncrypted }).from(schema.providerKeys)
      .where(eq(schema.providerKeys.providerAccountId, account.id)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!provider) return c.json({ error: "Provider not found", code: "provider_not_found" }, 404);
  const manifest = registry.getProvider(account.providerId)?.manifest;
  const endpoint = manifest?.endpoint ?? { mode: "fixed" as const };
  return c.json({
    ...account,
    nickname: account.nickname ?? null,
    displayName: account.nickname || `${provider.name} · ${account.id.slice(-6)}`,
    baseUrl: endpoint.mode === "required" ? account.baseUrl : null,
    endpoint,
    provider: {
      id: account.providerId,
      ...provider,
      iconKey: resolveProviderIconKey({ id: account.providerId, manifestPath: provider.manifestPath }),
    },
    credentialConfigured: Boolean(credential),
    credentialHealth: credential ? (() => {
      const parsed = parseProviderCredential(decrypt(credential.encrypted));
      return parsed.kind === "oauth2" ? credentialStatus(parsed.value)
        : { status: parsed.kind === "api-key" ? "connected" : "reconnect_required", refreshable: false };
    })() : { status: "not_connected", refreshable: false },
    models,
  });
});

app.post("/", async (c) => {
  const user = c.get("user");
  const body = createSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const provider = registry.getProvider(body.data.providerId);
  if (!provider) return c.json({ error: "Provider not found", code: "provider_not_found" }, 404);
  let baseUrl: string | null = null;
  const endpointMode = provider.manifest.endpoint?.mode ?? "fixed";
  if (endpointMode === "required" && !body.data.baseUrl) {
    return c.json({ error: "Endpoint is required for this custom provider", code: "endpoint_required" }, 400);
  }
  if (endpointMode === "fixed" && body.data.baseUrl) {
    return c.json({ error: "This provider uses its official endpoint", code: "endpoint_not_allowed" }, 400);
  }
  try {
    baseUrl = endpointMode === "required" && body.data.baseUrl
      ? await validatePublicHttpsEndpoint(body.data.baseUrl)
      : null;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid endpoint", code: "endpoint_not_public" }, 400);
  }
  const id = `acc_${nanoid(16)}`;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.providerAccounts).values({
        id, userId: user.id, providerId: body.data.providerId,
        nickname: body.data.nickname ?? null, baseUrl,
      });
      await tx.insert(schema.providerKeys).values({
        id: nanoid(), userId: user.id, providerId: body.data.providerId,
        providerAccountId: id, apiKeyEncrypted: encrypt(body.data.apiKey),
        label: body.data.nickname ?? null,
      });
    });
  } catch (error) {
    const value = `${(error as any)?.code ?? ""} ${String(error)}`;
    if (value.includes("23505")) return c.json({ error: "Account nickname already exists", code: "nickname_conflict" }, 409);
    throw error;
  }
  syncProviderModels(body.data.providerId, user.id, id).catch(() => {});
  return c.json({ id, providerId: body.data.providerId, nickname: body.data.nickname ?? null, baseUrl }, 201);
});

app.put("/:id", async (c) => {
  const user = c.get("user");
  const body = updateSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const account = await ownedAccount(c.req.param("id"), user.id);
  if (!account) return c.json({ error: "Account not found", code: "account_not_found" }, 404);
  const updates: Partial<typeof schema.providerAccounts.$inferInsert> = { updatedAt: new Date() };
  if (body.data.nickname !== undefined) updates.nickname = body.data.nickname;
  if (body.data.status !== undefined) updates.status = body.data.status;
  if (body.data.baseUrl !== undefined) {
    const provider = registry.getProvider(account.providerId);
    const endpointMode = provider?.manifest.endpoint?.mode ?? "fixed";
    if (endpointMode === "required" && !body.data.baseUrl) {
      return c.json({ error: "Endpoint is required for this custom provider", code: "endpoint_required" }, 400);
    }
    if (endpointMode === "fixed" && body.data.baseUrl) {
      return c.json({ error: "This provider uses its official endpoint", code: "endpoint_not_allowed" }, 400);
    }
    try {
      updates.baseUrl = endpointMode === "required" && body.data.baseUrl
        ? await validatePublicHttpsEndpoint(body.data.baseUrl)
        : null;
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid endpoint", code: "endpoint_not_public" }, 400);
    }
  }
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.providerAccounts).set(updates).where(eq(schema.providerAccounts.id, account.id));
      if (body.data.nickname !== undefined) {
        await tx.update(schema.providerKeys).set({ label: body.data.nickname })
          .where(eq(schema.providerKeys.providerAccountId, account.id));
      }
      if (body.data.apiKey !== undefined) {
        const changed = await tx.update(schema.providerKeys).set({ apiKeyEncrypted: encrypt(body.data.apiKey) })
          .where(eq(schema.providerKeys.providerAccountId, account.id))
          .returning({ id: schema.providerKeys.id });
        if (changed.length === 0) {
          await tx.insert(schema.providerKeys).values({
            id: nanoid(), userId: user.id, providerId: account.providerId,
            providerAccountId: account.id, apiKeyEncrypted: encrypt(body.data.apiKey),
            label: body.data.nickname ?? account.nickname,
          });
        }
      }
    });
  } catch (error) {
    const value = `${(error as any)?.code ?? ""} ${String(error)}`;
    if (value.includes("23505")) return c.json({ error: "Account nickname already exists", code: "nickname_conflict" }, 409);
    throw error;
  }
  return c.json({ updated: true });
});

app.delete("/:id", async (c) => {
  const user = c.get("user");
  const account = await ownedAccount(c.req.param("id"), user.id);
  if (!account) return c.json({ error: "Account not found", code: "account_not_found" }, 404);
  const [reference] = await db.select({ id: schema.modelGroupEntries.id })
    .from(schema.modelGroupEntries)
    .innerJoin(schema.modelGroups, eq(schema.modelGroups.id, schema.modelGroupEntries.groupId))
    .where(and(
      eq(schema.modelGroupEntries.providerAccountId, account.id),
      eq(schema.modelGroups.userId, user.id),
    )).limit(1);
  if (reference) return c.json({ error: "Account is used by a model group", code: "account_in_use" }, 409);
  await db.delete(schema.providerAccounts)
    .where(and(eq(schema.providerAccounts.id, account.id), eq(schema.providerAccounts.userId, user.id)));
  return c.json({ deleted: true });
});

app.post("/:id/test", async (c) => {
  const user = c.get("user");
  const account = await ownedAccount(c.req.param("id"), user.id);
  if (!account) return c.json({ error: "Account not found", code: "account_not_found" }, 404);
  const [resolved, apiKey] = await Promise.all([
    registry.getProviderForAccount(account.providerId, account.id, user.id),
    registry.getProviderApiKey(account.providerId, user.id, account.id),
  ]);
  if (!resolved || !apiKey) return c.json({ success: false, error: "Credential unavailable" }, 400);
  try {
    const models = resolved.handler?.fetchModels
      ? await resolved.handler.fetchModels(resolved.manifest, apiKey)
      : await fetchProviderModels(resolved.manifest, apiKey);
    return c.json({ success: models.length > 0, modelCount: models.length }, models.length > 0 ? 200 : 422);
  } catch {
    return c.json({ success: false, error: "Provider connection failed" }, 400);
  }
});

app.post("/:id/sync", async (c) => {
  const user = c.get("user");
  const account = await ownedAccount(c.req.param("id"), user.id);
  if (!account) return c.json({ error: "Account not found", code: "account_not_found" }, 404);
  return c.json({ synced: await syncProviderModels(account.providerId, user.id, account.id) });
});

export default app;
