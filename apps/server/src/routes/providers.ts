import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import { eq, and, desc, isNotNull, lte, sql } from "drizzle-orm";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { decrypt, encrypt } from "../services/encryption";
import { registry } from "../providers/registry";
import { syncProviderModels } from "../services/model-sync";
import { refreshProviderAccount, refreshProviderBalance } from "../services/provider-operations";
import { replaceProviderOAuthCredential } from "../services/provider-credentials";
import { resolveProviderIconKey } from "../services/brand-icons";
import { deleteProviderAndReconcileCatalog } from "../services/catalog-reconciliation";
import { parseDocument } from "yaml";
import { fetchProviderModels } from "../providers/model-discovery";
import { validatePublicHttpsEndpoint } from "../services/custom-endpoint";
import { z } from "zod";

const app = new Hono<{ Variables: { user: AuthUser } }>();

app.use("*", authMiddleware);

const fromManifestSchema = z.object({
  manifestId: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).max(20_000).optional(),
  label: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().trim().max(2_000).optional(),
}).strict();

type OwnedAccountResolution =
  | { account: typeof schema.providerAccounts.$inferSelect }
  | { error: string; code: string; status: 404 | 409 };

async function resolveOwnedAccount(userId: string, providerId: string, requestedId?: string, includeDisabled = false): Promise<OwnedAccountResolution> {
  const accounts = await db.select().from(schema.providerAccounts).where(and(
    eq(schema.providerAccounts.userId, userId),
    eq(schema.providerAccounts.providerId, providerId),
    ...(includeDisabled ? [] : [eq(schema.providerAccounts.status, "active")]),
    ...(requestedId ? [eq(schema.providerAccounts.id, requestedId)] : [])
  )).limit(requestedId ? 1 : 2);
  if (requestedId && accounts.length === 0) return { error: "Account not found", code: "account_not_found", status: 404 as const };
  if (!requestedId && accounts.length === 0) return { error: "Connect this provider before starting sign-in", code: "account_not_found", status: 404 as const };
  if (!requestedId && accounts.length > 1) return { error: "Choose the provider account to connect", code: "account_required", status: 409 as const };
  return { account: accounts[0] };
}

// ── Manifest endpoints (must come before /:id routes) ────────

// GET /api/providers/manifests — list available manifest templates
app.get("/manifests", async (c) => {
  const manifests = registry.getAvailableManifests();
  return c.json(
    manifests.map((m) => ({
      id: m.id,
      name: m.name,
      iconKey: resolveProviderIconKey({ id: m.id, manifestPath: `providers.d/${m.id}.yaml` }),
      type: m.type,
      baseUrl: m.baseUrl,
      endpoint: m.endpoint ?? { mode: "fixed" },
      auth: m.auth ? {
        type: m.auth.type,
        keyPrefix: m.auth.keyPrefix,
        connectLabel: m.auth.connectLabel,
        deviceFlowSupported: Boolean(
          m.auth.type === "oauth-device-flow"
          && registry.getProvider(m.id)?.handler?.startDeviceAuthorization
          && registry.getProvider(m.id)?.handler?.pollDeviceAuthorization
        ),
      } : undefined,
      hasDiscovery: !!m.models?.discovery?.enabled,
      staticModelCount: m.models?.static?.length || 0,
    }))
  );
});

// POST /api/providers/from-manifest — add an account from a provider manifest
app.post("/from-manifest", async (c) => {
  const user = c.get("user");
  const body = fromManifestSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const { manifestId, apiKey, label, baseUrl: requestedBaseUrl } = body.data;

  const manifests = registry.getAvailableManifests();
  const manifest = manifests.find((m) => m.id === manifestId);
  if (!manifest) return c.json({ error: `Manifest '${manifestId}' not found` }, 404);

  // OAuth providers don't need a key upfront
  const isOAuth = manifest.auth?.type === "oauth-device-flow" || manifest.auth?.type === "oauth-pkce";
  if (!isOAuth && !apiKey) {
    return c.json({ error: "apiKey is required" }, 400);
  }

  const manifestPath = `providers.d/${manifestId}.yaml`;
  const id = manifestId;
  const existing = await db
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.id, id))
    .limit(1);

  const accountId = `acc_${nanoid(16)}`;
  const nickname = typeof label === "string" && label.trim() ? label.trim() : null;
  let accountBaseUrl: string | null = null;
  const endpointMode = manifest.endpoint?.mode ?? "fixed";
  if (endpointMode === "required" && !requestedBaseUrl) {
    return c.json({ error: "Endpoint is required for this custom provider", code: "endpoint_required" }, 400);
  }
  if (endpointMode === "fixed" && requestedBaseUrl) {
    return c.json({ error: "This provider uses its official endpoint", code: "endpoint_not_allowed" }, 400);
  }
  if (endpointMode === "required" && requestedBaseUrl) {
    try {
      accountBaseUrl = await validatePublicHttpsEndpoint(requestedBaseUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid endpoint", code: "endpoint_not_public" }, 400);
    }
  }
  try {
    await db.transaction(async (tx) => {
      if (existing.length === 0) {
        await tx.insert(schema.providers).values({
          id,
          name: manifest.name,
          type: manifest.type,
          baseUrl: manifest.baseUrl,
          authType: manifest.auth?.type || "bearer",
          authHeader: manifest.auth?.header,
          modelsEndpoint: manifest.endpoints?.models,
          isBuiltin: true,
          manifestPath,
          extraHeaders: manifest.headers as any,
          handlerId: manifest.handler,
          handlerConfig: manifest.handlerConfig as any,
          balanceEndpoint: manifest.balance?.url,
          balanceParser: manifest.balance?.parser as any,
          balancePollInterval: manifest.balance?.pollInterval,
        }).onConflictDoNothing();
      }
      await tx.insert(schema.providerAccounts).values({
        id: accountId,
        userId: user.id,
        providerId: id,
        nickname,
        baseUrl: accountBaseUrl,
      });
      if (apiKey) {
        await tx.insert(schema.providerKeys).values({
          id: nanoid(),
          userId: user.id,
          providerId: id,
          providerAccountId: accountId,
          apiKeyEncrypted: encrypt(apiKey),
          label: nickname,
        });
      }
    });
  } catch (error) {
    const value = `${(error as any)?.code ?? ""} ${String(error)}`;
    if (value.includes("23505")) return c.json({ error: "Account nickname already exists", code: "nickname_conflict" }, 409);
    throw error;
  }

  // Reinitialize registry to pick up new provider
  await registry.initialize();

  // Trigger model sync for the new provider in background
  if (apiKey) {
    syncProviderModels(id, user.id, accountId).catch((err) =>
      console.error(`[sync] Initial model sync for ${id} failed:`, err)
    );
  }

  return c.json({ id, accountId, nickname, baseUrl: accountBaseUrl }, 201);
});

// POST /api/providers/import — import a custom provider from YAML
app.post("/import", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin" || (user.mode === "managed" && !user.permissions.includes("settings.manage"))) {
    return c.json({ error: "Standalone administrator access required" }, 403);
  }
  const { yaml: yamlStr } = await c.req.json();
  if (!yamlStr) return c.json({ error: "yaml field is required" }, 400);

  let parsed: any;
  try {
    const doc = parseDocument(yamlStr);
    parsed = doc.toJSON();
  } catch (err: any) {
    return c.json({ error: `Invalid YAML: ${err.message}` }, 400);
  }

  if (!parsed.id || !parsed.name || !parsed.baseUrl) {
    return c.json({ error: "Manifest must have id, name, and baseUrl fields" }, 400);
  }

  // Generate unique ID if conflict
  let id = parsed.id;
  const existing = await db
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.id, id))
    .limit(1);

  if (existing.length > 0) {
    id = `${parsed.id}-${nanoid(6)}`;
  }

  await db.insert(schema.providers).values({
    id,
    name: parsed.name,
    type: parsed.type || "openai-compatible",
    baseUrl: parsed.baseUrl,
    authType: parsed.auth?.type || "bearer",
    authHeader: parsed.auth?.header,
    modelsEndpoint: parsed.endpoints?.models,
    isBuiltin: false,
    extraHeaders: parsed.headers as any,
    balanceEndpoint: parsed.balance?.url,
    balanceParser: parsed.balance?.parser as any,
    balancePollInterval: parsed.balance?.pollInterval,
  });

  await registry.initialize();
  return c.json({ id }, 201);
});

// ── Generic OAuth device authorization ───────────────────────

// POST /api/providers/:id/oauth/device/start
app.post("/:id/oauth/device/start", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const body: { providerAccountId?: string } = await c.req.json<{ providerAccountId?: string }>().catch(() => ({}));
  const owned = await resolveOwnedAccount(user.id, providerId, body.providerAccountId);
  if ("error" in owned) return c.json({ error: owned.error, code: owned.code }, owned.status);
  const providerAccountId = owned.account.id;
  const resolved = registry.getProvider(providerId);
  if (!resolved) return c.json({ error: "Provider not found" }, 404);
  if (
    resolved.manifest.auth.type !== "oauth-device-flow"
    || !resolved.handler?.startDeviceAuthorization
    || !resolved.handler.pollDeviceAuthorization
  ) {
    return c.json({ error: "Provider does not support device authorization" }, 400);
  }

  try {
    const authorization = await resolved.handler.startDeviceAuthorization(
      resolved.manifest
    );
    const now = Date.now();
    const id = `oauth_${nanoid()}`;

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.providerOAuthDeviceFlows)
        .where(and(
          eq(schema.providerOAuthDeviceFlows.userId, user.id),
          eq(schema.providerOAuthDeviceFlows.providerId, providerId),
          eq(schema.providerOAuthDeviceFlows.providerAccountId, providerAccountId)
        ));
      await tx.insert(schema.providerOAuthDeviceFlows).values({
        id,
        userId: user.id,
        providerId,
        providerAccountId,
        deviceCodeEncrypted: encrypt(authorization.deviceCode),
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: authorization.verificationUriComplete,
        intervalSeconds: authorization.interval,
        nextPollAt: new Date(now + authorization.interval * 1000),
        expiresAt: new Date(now + authorization.expiresIn * 1000),
      });
    });

    return c.json({
      flowId: id,
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete ?? null,
      interval: authorization.interval,
      expiresAt: new Date(now + authorization.expiresIn * 1000).toISOString(),
    }, 201);
  } catch (error) {
    console.warn(
      `[oauth] Device authorization start failed for ${providerId}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return c.json({ error: "Unable to start device authorization" }, 502);
  }
});

// POST /api/providers/:id/oauth/device/:flowId/poll
app.post("/:id/oauth/device/:flowId/poll", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const flowId = c.req.param("flowId");
  const [flow] = await db
    .select()
    .from(schema.providerOAuthDeviceFlows)
    .where(and(
      eq(schema.providerOAuthDeviceFlows.id, flowId),
      eq(schema.providerOAuthDeviceFlows.userId, user.id),
      eq(schema.providerOAuthDeviceFlows.providerId, providerId)
    ))
    .limit(1);
  if (!flow) return c.json({ error: "Authorization flow not found" }, 404);

  const now = Date.now();
  if (flow.expiresAt.getTime() <= now || flow.status === "expired") {
    await db
      .update(schema.providerOAuthDeviceFlows)
      .set({ status: "expired", errorCode: "expired", updatedAt: new Date() })
      .where(eq(schema.providerOAuthDeviceFlows.id, flow.id));
    return c.json({ status: "expired" });
  }
  if (flow.status === "denied") return c.json({ status: "denied" });
  if (flow.nextPollAt.getTime() > now) {
    return c.json({
      status: "pending",
      retryAfter: Math.max(1, Math.ceil((flow.nextPollAt.getTime() - now) / 1000)),
    }, 202);
  }

  const resolved = registry.getProvider(providerId);
  if (!resolved?.handler?.pollDeviceAuthorization) {
    return c.json({ error: "Provider does not support device authorization" }, 400);
  }

  try {
    const [claimed] = await db
      .update(schema.providerOAuthDeviceFlows)
      .set({
        nextPollAt: new Date(now + flow.intervalSeconds * 1000),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.providerOAuthDeviceFlows.id, flow.id),
        eq(schema.providerOAuthDeviceFlows.userId, user.id),
        eq(schema.providerOAuthDeviceFlows.providerId, providerId),
        eq(schema.providerOAuthDeviceFlows.status, "pending"),
        lte(schema.providerOAuthDeviceFlows.nextPollAt, new Date(now))
      ))
      .returning({ id: schema.providerOAuthDeviceFlows.id });
    if (!claimed) {
      return c.json({
        status: "pending",
        retryAfter: flow.intervalSeconds,
      }, 202);
    }

    const result = await resolved.handler.pollDeviceAuthorization(
      resolved.manifest,
      decrypt(flow.deviceCodeEncrypted)
    );
    if (result.status === "pending") {
      const interval = Math.max(
        flow.intervalSeconds,
        result.interval ?? flow.intervalSeconds
      );
      await db
        .update(schema.providerOAuthDeviceFlows)
        .set({
          intervalSeconds: interval,
          nextPollAt: new Date(Date.now() + interval * 1000),
          updatedAt: new Date(),
        })
        .where(eq(schema.providerOAuthDeviceFlows.id, flow.id));
      return c.json({ status: "pending", retryAfter: interval }, 202);
    }
    if (result.status !== "success") {
      await db
        .update(schema.providerOAuthDeviceFlows)
        .set({
          status: result.status,
          errorCode: result.status,
          updatedAt: new Date(),
        })
        .where(eq(schema.providerOAuthDeviceFlows.id, flow.id));
      return c.json({ status: result.status });
    }

    const oauthIssuer = resolved.manifest.auth.issuer;
    const oauthClientId = resolved.manifest.auth.clientId;
    if (!oauthIssuer || !oauthClientId) {
      throw new Error("Provider OAuth metadata is incomplete");
    }
    const credentialId = await replaceProviderOAuthCredential({
      userId: user.id,
      providerId,
      providerAccountId: flow.providerAccountId,
      credential: result.credential,
      issuer: oauthIssuer,
      clientId: oauthClientId,
      label: `${resolved.manifest.name} OAuth`,
      deviceFlowId: flow.id,
    });

    syncProviderModels(providerId, user.id, flow.providerAccountId ?? undefined).catch((error) =>
      console.error(`[sync] OAuth model sync for ${providerId} failed:`, error)
    );
    refreshProviderAccount(user.id, providerId, flow.providerAccountId).catch((error) =>
      console.error(`[account] OAuth account refresh for ${providerId} failed:`, error)
    );

    return c.json({ status: "connected", credentialId });
  } catch (error) {
    console.warn(
      `[oauth] Device authorization poll failed for ${providerId}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    return c.json({ error: "Unable to complete device authorization" }, 502);
  }
});

// DELETE /api/providers/:id/oauth/device/:flowId
app.delete("/:id/oauth/device/:flowId", async (c) => {
  const user = c.get("user");
  await db
    .delete(schema.providerOAuthDeviceFlows)
    .where(and(
      eq(schema.providerOAuthDeviceFlows.id, c.req.param("flowId")),
      eq(schema.providerOAuthDeviceFlows.userId, user.id),
      eq(schema.providerOAuthDeviceFlows.providerId, c.req.param("id"))
    ));
  return c.json({ cancelled: true });
});

// ── Provider CRUD ────────────────────────────────────────────

// GET /api/providers — list all active providers with status
app.get("/", async (c) => {
  const user = c.get("user");
  const all = await db.select().from(schema.providers);

  const userKeys = await db
    .select()
    .from(schema.providerKeys)
    .where(eq(schema.providerKeys.userId, user.id));

  const modelCounts = await db
    .select({
      providerId: schema.providerModels.providerId,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(schema.providerModels)
    .where(isNotNull(schema.providerModels.catalogEntityId))
    .groupBy(schema.providerModels.providerId);
  const countMap = new Map(modelCounts.map((mc) => [mc.providerId, mc.count]));
  const operationalStates = await db.select().from(schema.providerOperationalStates)
    .where(eq(schema.providerOperationalStates.userId, user.id));
  const operationalByProvider = new Map(operationalStates.map((state) => [state.providerId, state]));

  const result = all.map((p) => {
    const operations = operationalByProvider.get(p.id);
    return ({
    ...p,
    iconKey: resolveProviderIconKey(p),
    hasOwnKey: userKeys.some((k) => k.providerId === p.id),
    modelCount: countMap.get(p.id) || 0,
    balance: p.balanceEndpoint ? { supported: true, value: operations?.balance === null || operations?.balance === undefined ? null : Number(operations.balance), status: operations?.balanceStatus ?? "never_synced", updatedAt: operations?.balanceUpdatedAt ?? null } : { supported: false },
    rateLimits: operations?.rateLimitData ? { supported: true, data: operations.rateLimitData, updatedAt: operations.rateLimitUpdatedAt } : { supported: false },
  }); });

  return c.json(result);
});

// GET /api/providers/:id
app.get("/:id", async (c) => {
  const user = c.get("user");
  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, c.req.param("id")))
    .limit(1);
  if (!provider) return c.json({ error: "Provider not found" }, 404);

  const [models, [key], [operational]] = await Promise.all([db
    .select({
      id: schema.providerModels.id,
      modelId: schema.providerModels.modelId,
      canonicalModelId: schema.providerModels.canonicalModelId,
      canonicalSlug: schema.modelCatalog.canonicalSlug,
      name: schema.modelCatalog.name,
      providerModelId: schema.providerModels.providerModelId,
      inputPrice: schema.providerModels.inputPrice,
      outputPrice: schema.providerModels.outputPrice,
      priceSource: schema.providerModels.priceSource,
      priceFetchedAt: schema.providerModels.priceFetchedAt,
      contextWindow: schema.providerModels.contextWindow,
      maxOutput: schema.providerModels.maxOutput,
      supportsStreaming: schema.providerModels.supportsStreaming,
      supportsTools: schema.providerModels.supportsTools,
      supportsVision: schema.providerModels.supportsVision,
      nativeFormat: schema.providerModels.nativeFormat,
      nativeEndpoint: schema.providerModels.nativeEndpoint,
    })
    .from(schema.providerModels)
    .leftJoin(schema.modelCatalog, eq(schema.providerModels.canonicalModelId, schema.modelCatalog.modelId))
    .where(and(
      eq(schema.providerModels.providerId, provider.id),
      isNotNull(schema.providerModels.catalogEntityId)
    )),
    db.select({ id: schema.providerKeys.id, label: schema.providerKeys.label, createdAt: schema.providerKeys.createdAt })
      .from(schema.providerKeys)
      .where(and(eq(schema.providerKeys.providerId, provider.id), eq(schema.providerKeys.userId, user.id))).limit(1),
    db.select().from(schema.providerOperationalStates)
      .where(and(eq(schema.providerOperationalStates.providerId, provider.id), eq(schema.providerOperationalStates.userId, user.id))).limit(1)]);

  return c.json({
    ...provider,
    iconKey: resolveProviderIconKey(provider),
    auth: {
      type: provider.authType,
      connectLabel: registry.getProvider(provider.id)?.manifest.auth.connectLabel ?? null,
      deviceFlowSupported: Boolean(
        registry.getProvider(provider.id)?.handler?.startDeviceAuthorization
        && registry.getProvider(provider.id)?.handler?.pollDeviceAuthorization
      ),
    },
    keyStatus: key ? {
      configured: true,
      id: key.id,
      label: key.label,
      createdAt: key.createdAt,
      credentialType: provider.authType === "oauth-device-flow" ? "oauth2" : "api_key",
    } : { configured: false },
    operations: {
      balance: { supported: Boolean(provider.balanceEndpoint), value: operational?.balance === null || operational?.balance === undefined ? null : Number(operational.balance), status: operational?.balanceStatus ?? "never_synced", error: operational?.balanceError ?? null, updatedAt: operational?.balanceUpdatedAt ?? null },
      rateLimits: { supported: Boolean(operational?.rateLimitData), data: operational?.rateLimitData ?? null, updatedAt: operational?.rateLimitUpdatedAt ?? null },
      account: registry.getProvider(provider.id)?.handler?.getAccountInfo ? { supported: true, data: operational?.accountData ?? null, status: operational?.accountStatus ?? "never_synced", error: operational?.accountError ?? null, updatedAt: operational?.accountUpdatedAt ?? null } : { supported: false, reason: "not_supported_by_handler" },
    },
    models,
    modelCount: models.length,
  });
});

// DELETE /api/providers/:id
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin" || (user.mode === "managed" && !user.permissions.includes("settings.manage"))) {
    return c.json({ error: "Standalone administrator access required" }, 403);
  }
  const id = c.req.param("id");
  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, id))
    .limit(1);
  if (!provider) return c.json({ error: "Not found" }, 404);

  const deleted = await deleteProviderAndReconcileCatalog(id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  await registry.initialize();
  return c.json({ deleted: true, catalogGenerationId: deleted.reconciliation?.generationId ?? null });
});

// ── Provider Keys ─────────────────────────────────────────────

// POST /api/providers/:id/keys — add API key for provider
app.post("/:id/keys", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const { apiKey, label } = await c.req.json();

  if (!apiKey) return c.json({ error: "apiKey required" }, 400);
  if (!registry.getProvider(providerId)) return c.json({ error: "Provider not found" }, 404);
  const accounts = await db.select().from(schema.providerAccounts).where(and(
    eq(schema.providerAccounts.userId, user.id),
    eq(schema.providerAccounts.providerId, providerId),
  )).limit(2);
  if (accounts.length > 1) {
    return c.json({ error: "Choose an account through the provider accounts API", code: "account_required" }, 409);
  }
  const id = nanoid();
  const accountId = accounts[0]?.id ?? `acc_${nanoid(16)}`;
  try {
    await db.transaction(async (tx) => {
      if (!accounts[0]) {
        await tx.insert(schema.providerAccounts).values({
          id: accountId, userId: user.id, providerId,
          nickname: label?.trim() || "Default",
        });
      }
      await tx.delete(schema.providerKeys).where(and(
        eq(schema.providerKeys.userId, user.id),
        eq(schema.providerKeys.providerId, providerId),
        eq(schema.providerKeys.providerAccountId, accountId),
      ));
      await tx.insert(schema.providerKeys).values({
        id, userId: user.id, providerId, providerAccountId: accountId,
        apiKeyEncrypted: encrypt(apiKey), label: label || "Default",
      });
    });
  } catch (error) {
    const value = `${(error as any)?.code ?? ""} ${String(error)}`;
    if (value.includes("23505")) return c.json({ error: "Account nickname already exists", code: "nickname_conflict" }, 409);
    throw error;
  }

  syncProviderModels(providerId, user.id, accountId).catch((err) =>
    console.error(`[sync] Fetch after key add for ${providerId} failed:`, err)
  );

  return c.json({ id }, 201);
});

// PUT /api/providers/:id/keys/label — rename key label
app.put("/:id/keys/label", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const { label } = await c.req.json();
  if (!label?.trim()) return c.json({ error: "label is required" }, 400);
  const owned = await resolveOwnedAccount(user.id, providerId, undefined, true);
  if ("error" in owned) return c.json({ error: owned.error, code: owned.code }, owned.status);

  const [key] = await db
    .select()
    .from(schema.providerKeys)
    .where(and(eq(schema.providerKeys.userId, user.id), eq(schema.providerKeys.providerId, providerId)))
    .limit(1);
  if (!key) return c.json({ error: "No key found for this provider" }, 404);

  await db
    .update(schema.providerKeys)
    .set({ label: label.trim() })
    .where(eq(schema.providerKeys.id, key.id));

  return c.json({ updated: true, label: label.trim() });
});

// DELETE /api/providers/:id/keys
app.delete("/:id/keys", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const owned = await resolveOwnedAccount(user.id, providerId, undefined, true);
  if ("error" in owned) return c.json({ error: owned.error, code: owned.code }, owned.status);
  await db
    .delete(schema.providerKeys)
    .where(and(eq(schema.providerKeys.userId, user.id), eq(schema.providerKeys.providerId, providerId)));
  await db
    .delete(schema.providerOAuthDeviceFlows)
    .where(and(
      eq(schema.providerOAuthDeviceFlows.userId, user.id),
      eq(schema.providerOAuthDeviceFlows.providerId, providerId)
    ));
  return c.json({ deleted: true });
});

// GET /api/providers/:id/models — list models for a specific provider
app.get("/:id/models", async (c) => {
  const providerId = c.req.param("id");
  const [provider] = await db
    .select()
    .from(schema.providers)
    .where(eq(schema.providers.id, providerId))
    .limit(1);
  if (!provider) return c.json({ error: "Provider not found" }, 404);

  const models = await db
    .select({
      id: schema.providerModels.id,
      modelId: schema.providerModels.modelId,
      providerModelId: schema.providerModels.providerModelId,
      inputPrice: schema.providerModels.inputPrice,
      outputPrice: schema.providerModels.outputPrice,
      contextWindow: schema.providerModels.contextWindow,
      maxOutput: schema.providerModels.maxOutput,
      supportsStreaming: schema.providerModels.supportsStreaming,
      supportsTools: schema.providerModels.supportsTools,
      nativeFormat: schema.providerModels.nativeFormat,
      nativeEndpoint: schema.providerModels.nativeEndpoint,
      name: schema.modelCatalog.name,
      description: schema.modelCatalog.description,
    })
    .from(schema.providerModels)
    .leftJoin(schema.modelCatalog, eq(schema.providerModels.modelId, schema.modelCatalog.modelId))
    .where(and(
      eq(schema.providerModels.providerId, providerId),
      isNotNull(schema.providerModels.catalogEntityId)
    ))
    .orderBy(schema.providerModels.modelId);

  return c.json({ providerId, models, count: models.length });
});

// POST /api/providers/:id/sync — trigger model sync for a single provider
app.post("/:id/sync", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const resolved = registry.getProvider(providerId);
  if (!resolved) return c.json({ error: "Provider not found" }, 404);

  const owned = await resolveOwnedAccount(user.id, providerId);
  if ("error" in owned) return c.json({ error: owned.error, code: owned.code }, owned.status);
  const synced = await syncProviderModels(providerId, user.id, owned.account.id);
  return c.json({ synced });
});

// POST /api/providers/:id/balance — refresh only when a manifest declares support.
app.post("/:id/balance", async (c) => {
  const result = await refreshProviderBalance(c.get("user").id, c.req.param("id"));
  return c.json(result.body, result.httpStatus as any);
});

app.post("/:id/account", async (c) => {
  const result = await refreshProviderAccount(c.get("user").id, c.req.param("id"));
  return c.json(result.body, result.httpStatus as any);
});

// POST /api/providers/:id/test — test connection
app.post("/:id/test", async (c) => {
  const user = c.get("user");
  const providerId = c.req.param("id");
  const owned = await resolveOwnedAccount(user.id, providerId);
  if ("error" in owned) return c.json({ error: owned.error, code: owned.code }, owned.status);
  const apiKey = await registry.getProviderApiKey(providerId, user.id, owned.account.id);
  if (!apiKey) return c.json({ error: "No API key configured for this provider" }, 400);

  const resolved = await registry.getProviderForAccount(providerId, owned.account.id, user.id);
  if (!resolved) return c.json({ error: "Provider not found" }, 404);

  try {
    if (resolved.handler?.testConnection) {
      const oauthCredential = await registry.getProviderOAuthCredential(
        providerId,
        user.id,
        owned.account.id
      );
      const result = await resolved.handler.testConnection(
        resolved.manifest,
        apiKey,
        oauthCredential ?? undefined
      );
      return c.json(result, result.success ? 200 : 400);
    }

    const models = await fetchProviderModels(resolved.manifest, apiKey);
    const success = models.length > 0;
    return c.json(
      {
        success,
        status: success ? 200 : 422,
        error: success ? undefined : "Provider returned no eligible models",
      },
      success ? 200 : 400
    );
  } catch (err: any) {
    return c.json({ success: false, status: err.status ?? 0, error: err.message }, 400);
  }
});

export default app;
