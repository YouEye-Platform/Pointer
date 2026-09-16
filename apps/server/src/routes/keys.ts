import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { invalidateModelResolutionCache } from "../services/model-resolution";
import { hashApiKey } from "../middleware/api-key";
import { z } from "zod";

const app = new Hono<{ Variables: { user: AuthUser } }>();

app.use("*", authMiddleware);
app.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.res.status < 400) invalidateModelResolutionCache();
});

// GET /api/keys — list user's API keys (never returns the raw key or hash)
app.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      keyPreview: schema.apiKeys.keyPreview,
      instanceId: schema.apiKeys.instanceId,
      allowedModels: schema.apiKeys.allowedModels,
      fallbackProviderId: schema.apiKeys.fallbackProviderId,
      createdAt: schema.apiKeys.createdAt,
      lastUsed: schema.apiKeys.lastUsed,
      requestCount: schema.apiKeys.requestCount,
      revoked: schema.apiKeys.revoked,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.userId, user.id));
  return c.json(rows);
});

app.get("/:id", async (c) => {
  const user = c.get("user");
  const [key] = await db.select({
    id: schema.apiKeys.id, name: schema.apiKeys.name, keyPreview: schema.apiKeys.keyPreview,
    instanceId: schema.apiKeys.instanceId, allowedModels: schema.apiKeys.allowedModels,
    fallbackProviderId: schema.apiKeys.fallbackProviderId, createdAt: schema.apiKeys.createdAt,
    lastUsed: schema.apiKeys.lastUsed, requestCount: schema.apiKeys.requestCount, revoked: schema.apiKeys.revoked,
  }).from(schema.apiKeys).where(and(eq(schema.apiKeys.id, c.req.param("id")), eq(schema.apiKeys.userId, user.id))).limit(1);
  if (!key) return c.json({ error: "API key not found" }, 404);
  return c.json(key);
});

const updateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  instanceId: z.string().min(1).optional(),
  allowedModels: z.array(z.string().min(1).max(200)).max(200).optional(),
  fallbackProviderId: z.string().min(1).nullable().optional(),
});

app.put("/:id", async (c) => {
  const user = c.get("user");
  const body = updateKeySchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const [key] = await db.select({ id: schema.apiKeys.id, purpose: schema.apiKeys.purpose }).from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, c.req.param("id")), eq(schema.apiKeys.userId, user.id))).limit(1);
  if (!key) return c.json({ error: "API key not found" }, 404);
  if (key.purpose === "managed_application") {
    return c.json({ error: "Managed credentials require the lifecycle API", code: "managed_resource_protected" }, 409);
  }
  if (body.data.instanceId) {
    const [instance] = await db.select({ id: schema.instances.id }).from(schema.instances)
      .where(and(eq(schema.instances.id, body.data.instanceId), eq(schema.instances.userId, user.id))).limit(1);
    if (!instance) return c.json({ error: "Instance not found" }, 404);
  }
  await db.update(schema.apiKeys).set(body.data).where(eq(schema.apiKeys.id, key.id));
  return c.json({ updated: true });
});

// POST /api/keys — mint a new ptr_ API key bound to an instance
app.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  if (!body.instanceId) return c.json({ error: "instanceId required" }, 400);

  // Verify instance belongs to user
  const [inst] = await db
    .select({ id: schema.instances.id })
    .from(schema.instances)
    .where(and(eq(schema.instances.id, body.instanceId), eq(schema.instances.userId, user.id)))
    .limit(1);
  if (!inst) return c.json({ error: "Instance not found" }, 404);

  const id = nanoid();
  const rawKey = `ptr_${nanoid(32)}`;
  const keyHash = await hashApiKey(rawKey);
  const keyPreview = `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;

  await db.insert(schema.apiKeys).values({
    id,
    userId: user.id,
    instanceId: body.instanceId,
    keyHash,
    keyPreview,
    name: body.name || "API Key",
    allowedModels: body.allowedModels || ["*"],
    fallbackProviderId: body.fallbackProviderId,
  });

  // Return the raw key ONCE — it is stored only as a hash and cannot be retrieved later
  return c.json({ id, key: rawKey, keyPreview }, 201);
});

// DELETE /api/keys/:id — revoke (soft delete)
app.delete("/:id", async (c) => {
  const user = c.get("user");
  const [key] = await db
    .select({ id: schema.apiKeys.id, purpose: schema.apiKeys.purpose })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, c.req.param("id")), eq(schema.apiKeys.userId, user.id)))
    .limit(1);
  if (!key) return c.json({ error: "API key not found" }, 404);
  if (key.purpose === "managed_application") {
    return c.json({ error: "Managed credentials require the lifecycle API", code: "managed_resource_protected" }, 409);
  }
  const revoked = await db
    .update(schema.apiKeys)
    .set({ revoked: true, lifecycle: "retired", revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, c.req.param("id")), eq(schema.apiKeys.userId, user.id)))
    .returning({ id: schema.apiKeys.id });
  if (revoked.length === 0) return c.json({ error: "API key not found" }, 404);
  return c.json({ revoked: true });
});

export default app;
