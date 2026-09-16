import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, schema } from "../db";
import { eq, and, inArray, ne } from "drizzle-orm";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { invalidateModelResolutionCache } from "../services/model-resolution";
import {
  isReservedModelAlias,
  normalizeManualModelAlias,
  reservedModelAliasMessage,
} from "../services/model-aliases";

const app = new Hono<{ Variables: { user: AuthUser } }>();

app.use("*", authMiddleware);
app.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.res.status < 400) invalidateModelResolutionCache(c.req.param("id"));
});

// Verify an instance belongs to the authenticated user. Returns the row or null.
async function ownedInstance(instanceId: string, userId: string) {
  const [inst] = await db
    .select({ id: schema.instances.id, origin: schema.instances.origin })
    .from(schema.instances)
    .where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, userId)))
    .limit(1);
  return inst ?? null;
}

function normalizedInstanceAlias(value: unknown) {
  if (value != null && typeof value !== "string") {
    return { error: "alias must be a string or null", code: "invalid_model_alias" as const };
  }
  if (typeof value === "string" && value.length > 200) {
    return { error: "alias must be at most 200 characters", code: "invalid_model_alias" as const };
  }
  const normalized = normalizeManualModelAlias(value as string | null | undefined);
  return isReservedModelAlias(normalized)
    ? { error: reservedModelAliasMessage(), code: "reserved_model_alias" as const }
    : { value: normalized };
}

// GET /api/instances
app.get("/", async (c) => {
  const user = c.get("user");
  const includeArchived = c.req.query("includeArchived") === "true";
  const rows = await db
    .select()
    .from(schema.instances)
    .where(
      and(
        eq(schema.instances.userId, user.id),
        ...(includeArchived ? [] : [ne(schema.instances.state, "archived")])
      )
    );
  const managedRows = rows.length
    ? await db
        .select({
          instanceId: schema.managedAppInstallations.instanceId,
          externalInstallationId: schema.managedAppInstallations.externalInstallationId,
          appId: schema.managedAppInstallations.appId,
          displayName: schema.managedAppInstallations.displayName,
          state: schema.managedAppInstallations.state,
        })
        .from(schema.managedAppInstallations)
        .where(inArray(schema.managedAppInstallations.instanceId, rows.map((row) => row.id)))
    : [];
  const managedByInstance = new Map(
    managedRows.map((row) => [row.instanceId, row])
  );
  return c.json(rows.map((row) => ({
    ...row,
    managedApplication: managedByInstance.get(row.id) ?? null,
  })));
});

// POST /api/instances
app.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const id = `inst_${nanoid(12)}`;

  // If no modelGroupId specified, default to user's default group
  let modelGroupId = body.modelGroupId ?? null;
  if (!modelGroupId) {
    const [defaultGroup] = await db
      .select({ id: schema.modelGroups.id })
      .from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.userId, user.id), eq(schema.modelGroups.isDefault, true)))
      .limit(1);
    if (defaultGroup) modelGroupId = defaultGroup.id;
  } else {
    const [ownedGroup] = await db
      .select({ id: schema.modelGroups.id })
      .from(schema.modelGroups)
      .where(and(
        eq(schema.modelGroups.id, modelGroupId),
        eq(schema.modelGroups.userId, user.id),
      ))
      .limit(1);
    if (!ownedGroup) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  }

  await db.insert(schema.instances).values({
    id,
    userId: user.id,
    name: body.name || "New Instance",
    icon: body.icon || "{}",
    color: body.color || "#3B82F6",
    modelGroupId,
  });

  return c.json({ id }, 201);
});

// GET /api/instances/:id
app.get("/:id", async (c) => {
  const user = c.get("user");
  const [inst] = await db
    .select()
    .from(schema.instances)
    .where(and(eq(schema.instances.id, c.req.param("id")), eq(schema.instances.userId, user.id)))
    .limit(1);
  if (!inst) return c.json({ error: "Not found" }, 404);

  const models = await db
    .select()
    .from(schema.instanceModels)
    .where(eq(schema.instanceModels.instanceId, inst.id));

  const keys = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      keyPreview: schema.apiKeys.keyPreview,
      allowedModels: schema.apiKeys.allowedModels,
      fallbackProviderId: schema.apiKeys.fallbackProviderId,
      createdAt: schema.apiKeys.createdAt,
      lastUsed: schema.apiKeys.lastUsed,
      requestCount: schema.apiKeys.requestCount,
      revoked: schema.apiKeys.revoked,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.instanceId, inst.id));

  const [managedApplication] = inst.origin === "managed"
    ? await db
        .select({
          externalInstallationId: schema.managedAppInstallations.externalInstallationId,
          appId: schema.managedAppInstallations.appId,
          displayName: schema.managedAppInstallations.displayName,
          state: schema.managedAppInstallations.state,
        })
        .from(schema.managedAppInstallations)
        .where(eq(schema.managedAppInstallations.instanceId, inst.id))
        .limit(1)
    : [];

  // Fetch group entries if linked
  let groupEntries: any[] = [];
  if (inst.modelGroupId) {
    groupEntries = await db
      .select()
      .from(schema.modelGroupEntries)
      .where(eq(schema.modelGroupEntries.groupId, inst.modelGroupId));
  }

  return c.json({
    ...inst,
    models,
    keys,
    groupEntries,
    managedApplication: managedApplication ?? null,
  });
});

// PUT /api/instances/:id
app.put("/:id", async (c) => {
  const user = c.get("user");
  const instance = await ownedInstance(c.req.param("id"), user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") {
    return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);
  }
  const body = await c.req.json();
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.icon !== undefined) updates.icon = body.icon;
  if (body.color !== undefined) updates.color = body.color;
  if (body.modelGroupId !== undefined) {
    if (body.modelGroupId !== null) {
      const [ownedGroup] = await db
        .select({ id: schema.modelGroups.id })
        .from(schema.modelGroups)
        .where(and(
          eq(schema.modelGroups.id, body.modelGroupId),
          eq(schema.modelGroups.userId, user.id),
        ))
        .limit(1);
      if (!ownedGroup) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
    }
    updates.modelGroupId = body.modelGroupId;
  }

  await db
    .update(schema.instances)
    .set(updates)
    .where(and(eq(schema.instances.id, c.req.param("id")), eq(schema.instances.userId, user.id)));
  return c.json({ updated: true });
});

// DELETE /api/instances/:id
app.delete("/:id", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") {
    return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);
  }
  await db.transaction(async (tx) => {
    const keyRows = await tx
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.instanceId, instanceId));
    if (keyRows.length > 0) {
      await tx
        .update(schema.usageLogs)
        .set({ apiKeyId: null })
        .where(inArray(schema.usageLogs.apiKeyId, keyRows.map((key) => key.id)));
    }
    await tx
      .delete(schema.instances)
      .where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, user.id)));
  });
  return c.json({ deleted: true });
});

// ── Instance Models ───────────────────────────────────────────
// Divergence from v05: these sub-routes verify instance ownership before
// mutating instance_models. v05 omitted the check on POST/PUT/DELETE models,
// which let any authenticated user edit another user's instance models.

// POST /api/instances/:id/models — add a custom model
app.post("/:id/models", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);

  const body = await c.req.json();
  if (!body.modelId || !body.providerId) {
    return c.json({ error: "modelId and providerId are required" }, 400);
  }
  const alias = normalizedInstanceAlias(body.alias);
  if ("error" in alias) return c.json(alias, 400);
  const id = nanoid();

  // If setting as default, clear other defaults for this model
  if (body.isDefault) {
    await db
      .update(schema.instanceModels)
      .set({ isDefault: false })
      .where(and(eq(schema.instanceModels.instanceId, instanceId), eq(schema.instanceModels.modelId, body.modelId)));
  }

  await db.insert(schema.instanceModels).values({
    id,
    instanceId,
    modelId: body.modelId,
    providerId: body.providerId,
    providerAccountId: body.providerAccountId ?? null,
    enabled: body.enabled ?? true,
    isDefault: body.isDefault ?? false,
    priority: body.priority ?? 0,
    alias: alias.value,
    source: body.source ?? "custom",
  });

  return c.json({ id }, 201);
});

// PUT /api/instances/:id/models/:mid — update alias/priority/enabled
app.put("/:id/models/:mid", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);

  const body = await c.req.json();
  const updates: Record<string, any> = {};
  if (body.alias !== undefined) {
    const alias = normalizedInstanceAlias(body.alias);
    if ("error" in alias) return c.json(alias, 400);
    updates.alias = alias.value;
  }
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  if (Object.keys(updates).length > 0) {
    await db
      .update(schema.instanceModels)
      .set(updates)
      .where(and(eq(schema.instanceModels.id, c.req.param("mid")), eq(schema.instanceModels.instanceId, instanceId)));
  }
  return c.json({ updated: true });
});

// DELETE /api/instances/:id/models/:mid
app.delete("/:id/models/:mid", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);

  await db
    .delete(schema.instanceModels)
    .where(and(eq(schema.instanceModels.id, c.req.param("mid")), eq(schema.instanceModels.instanceId, instanceId)));
  return c.json({ deleted: true });
});

// ── Batch provider-models ────────────────────────────────────

const batchProviderModelsSchema = z.object({
  providerId: z.string().min(1),
  providerAccountId: z.string().min(1).optional(),
  models: z.array(z.string().min(1)),
});

// POST /api/instances/:id/provider-models — batch add provider-toggled models
app.post("/:id/provider-models", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const body = batchProviderModelsSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);

  let added = 0;
  for (const modelId of body.data.models) {
    try {
      await db
        .insert(schema.instanceModels)
        .values({
          id: nanoid(),
          instanceId,
          modelId,
          providerId: body.data.providerId,
          providerAccountId: body.data.providerAccountId ?? null,
          enabled: true,
          isDefault: false,
          priority: 0,
          source: "provider",
        })
        .onConflictDoNothing();
      added++;
    } catch {
      // Skip duplicates
    }
  }

  return c.json({ added });
});

// DELETE /api/instances/:id/provider-models — batch remove provider models
app.delete("/:id/provider-models", async (c) => {
  const user = c.get("user");
  const instanceId = c.req.param("id");
  const body = await c.req.json();
  const providerId = body.providerId;
  if (!providerId) return c.json({ error: "providerId required" }, 400);

  const instance = await ownedInstance(instanceId, user.id);
  if (!instance) return c.json({ error: "Not found" }, 404);
  if (instance.origin === "managed") return c.json({ error: "Managed instances require the lifecycle API", code: "managed_resource_protected" }, 409);

  const conditions = [
    eq(schema.instanceModels.instanceId, instanceId),
    eq(schema.instanceModels.providerId, providerId),
  ];
  if (body.models?.length) {
    conditions.push(inArray(schema.instanceModels.modelId, body.models));
  }

  const toRemove = await db
    .select({ id: schema.instanceModels.id })
    .from(schema.instanceModels)
    .where(and(...conditions));
  const ids = toRemove.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(schema.instanceModels).where(inArray(schema.instanceModels.id, ids));
  }
  return c.json({ removed: ids.length });
});

export default app;
