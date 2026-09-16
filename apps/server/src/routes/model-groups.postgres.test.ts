import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { signJwt } from "../middleware/auth";
import { assertCatalogPostgresTestDatabase } from "../services/catalog-postgres-test-safety";
import { reconcileCatalog, stageProviderInventorySnapshot } from "../services/catalog-reconciliation";
import type { ProviderModelInput } from "../services/catalog-planner";
import catalogRoutes from "./catalog";
import groupRoutes from "./model-groups";

const enabled = process.env.CATALOG_POSTGRES_TEST === "1";
const prefix = "model-group-api-test";
const providerId = `${prefix}-provider`;
const providerModelKey = `${prefix}-provider-model`;
const userAId = `${prefix}-user-a`;
const userBId = `${prefix}-user-b`;
const groupAId = `${prefix}-group-a`;
const groupBId = `${prefix}-group-b`;
const accountAId = `${prefix}-account-a`;
const accountBId = `${prefix}-account-b`;
const accountWithoutModelId = `${prefix}-account-without-model`;
let tokenA = "";
let tokenB = "";
let catalogEntityId = "";

const providerRecord: ProviderModelInput = {
  id: providerModelKey,
  providerId,
  providerName: "Model Group Test Provider",
  rawModelId: "fixture/human-model",
  displayName: "Human Model",
  existingModelId: "fixture/human-model",
  inputPrice: "1",
  outputPrice: "2",
  contextWindow: 64_000,
  maxOutput: 4_096,
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
};

function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function groupRequest(token: string, path: string, init: RequestInit = {}) {
  return groupRoutes.request(`http://pointer.test${path}`, {
    ...init,
    headers: { ...headers(token), ...(init.headers ?? {}) },
  });
}

describe.skipIf(!enabled)("model groups and provider availability PostgreSQL integration", () => {
  beforeAll(async () => {
    assertCatalogPostgresTestDatabase();
    await db.delete(schema.users).where(
      // Both IDs use a fixed prefix and are test-only.
      // Drizzle has no startsWith helper here, so delete the explicit fixtures.
      eq(schema.users.id, userAId),
    );
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));

    await db.insert(schema.providers).values({
      id: providerId,
      name: "Model Group Test Provider",
      type: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      status: "error",
    });
    await db.insert(schema.providerModels).values({
      id: providerModelKey,
      providerId,
      modelId: "fixture/human-model",
      displayName: "Human Model",
      providerModelId: "fixture/human-model",
      supportsStreaming: true,
      supportsTools: true,
    });
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Model Group Test Provider",
      sourceUrl: "https://provider.example.test/v1/models",
      records: [providerRecord],
      completedAt: new Date("2026-07-29T00:00:00Z"),
    });
    await reconcileCatalog();

    const [providerModel] = await db.select({
      catalogEntityId: schema.providerModels.catalogEntityId,
    }).from(schema.providerModels).where(eq(schema.providerModels.id, providerModelKey));
    if (!providerModel?.catalogEntityId) throw new Error("test provider model did not reconcile");
    catalogEntityId = providerModel.catalogEntityId;

    await db.insert(schema.users).values([
      { id: userAId, email: "model-group-a@example.test", name: "Group User A", passwordHash: "not-used", role: "user" },
      { id: userBId, email: "model-group-b@example.test", name: "Group User B", passwordHash: "not-used", role: "user" },
    ]);
    await db.insert(schema.modelGroups).values([
      { id: groupAId, userId: userAId, name: "Primary", isDefault: true, position: 0 },
      { id: groupBId, userId: userAId, name: "Secondary", isDefault: false, position: 1 },
    ]);
    await db.insert(schema.providerAccounts).values([
      { id: accountAId, userId: userAId, providerId, nickname: "Primary test account" },
      { id: accountBId, userId: userAId, providerId, nickname: "Second test account" },
      { id: accountWithoutModelId, userId: userBId, providerId, nickname: "No model entitlement" },
    ]);
    const [key] = await db.insert(schema.providerKeys).values({
      id: `${prefix}-key-a`,
      userId: userAId,
      providerId,
      providerAccountId: accountAId,
      apiKeyEncrypted: "synthetic-test-ciphertext",
    }).returning();
    await db.insert(schema.providerKeys).values({
      id: `${prefix}-key-b`,
      userId: userAId,
      providerId,
      providerAccountId: accountBId,
      apiKeyEncrypted: "synthetic-test-ciphertext",
    });
    await db.insert(schema.providerKeys).values({
      id: `${prefix}-key-without-model`,
      userId: userBId,
      providerId,
      providerAccountId: accountWithoutModelId,
      apiKeyEncrypted: "synthetic-test-ciphertext",
    });
    await db.insert(schema.providerAccountModels).values([
      { id: `${prefix}-account-model-a`, providerAccountId: accountAId, providerModelId: providerModelKey },
      { id: `${prefix}-account-model-b`, providerAccountId: accountBId, providerModelId: providerModelKey },
    ]);
    await db.insert(schema.providerKeyShares).values({
      id: `${prefix}-share`,
      providerKeyId: key.id,
      sharedWithUserId: userBId,
    });
    tokenA = await signJwt({ id: userAId, email: "model-group-a@example.test", name: "Group User A", role: "user" });
    tokenB = await signJwt({ id: userBId, email: "model-group-b@example.test", name: "Group User B", role: "user" });
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.delete(schema.users).where(eq(schema.users.id, userAId));
    await db.delete(schema.users).where(eq(schema.users.id, userBId));
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));
  });

  test("availability uses the user's own provider connection and no instance exposure", async () => {
    const responseA = await catalogRoutes.request("http://pointer.test/?availability=available", {
      headers: headers(tokenA),
    });
    expect(responseA.status).toBe(200);
    const availableA = await responseA.json() as { items: Array<{ id: string; available: boolean; providers: Array<{ available: boolean }> }> };
    expect(availableA.items.find((item) => item.id === catalogEntityId)).toMatchObject({
      available: true,
      providers: [expect.objectContaining({ available: true })],
    });

    const responseB = await catalogRoutes.request("http://pointer.test/?availability=available", {
      headers: headers(tokenB),
    });
    expect(responseB.status).toBe(200);
    const availableB = await responseB.json() as { items: Array<{ id: string }> };
    expect(availableB.items.some((item) => item.id === catalogEntityId)).toBe(false);

    await db.insert(schema.instances).values({
      id: `${prefix}-instance`,
      userId: userBId,
      name: "Does not grant availability",
    });
    await db.insert(schema.instanceModels).values({
      id: `${prefix}-instance-model`,
      instanceId: `${prefix}-instance`,
      modelId: catalogEntityId,
      providerId,
      source: "custom",
      priority: 0,
    });
    const afterExposure = await catalogRoutes.request("http://pointer.test/?availability=available", {
      headers: headers(tokenB),
    });
    const afterExposureBody = await afterExposure.json() as { items: Array<{ id: string }> };
    expect(afterExposureBody.items.some((item) => item.id === catalogEntityId)).toBe(false);
  });

  test("adds an exact active provider route and returns canonical presentation", async () => {
    const ambiguous = await groupRequest(tokenA, `/${groupAId}/entries`, {
      method: "POST",
      body: JSON.stringify({ catalogEntityId, providerModelKey }),
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "provider_account_required" });

    const added = await groupRequest(tokenA, `/${groupAId}/entries`, {
      method: "POST",
      body: JSON.stringify({ catalogEntityId, providerModelKey, providerAccountId: accountAId }),
    });
    expect(added.status).toBe(201);

    const detail = await groupRequest(tokenA, `/${groupAId}`);
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      entries: Array<{
        id: string;
        catalogEntityId: string;
        providerModelKey: string;
        modelName: string;
        rawModelId: string;
        providerAccountNickname: string;
        hiddenAliases: string[];
      }>;
    };
    expect(body.entries[0]).toMatchObject({
      catalogEntityId,
      providerModelKey,
      modelName: "Human Model",
      rawModelId: "fixture/human-model",
      providerAccountNickname: "Primary test account",
      hiddenAliases: ["big", "opus", "default"],
    });

    const duplicate = await groupRequest(tokenA, `/${groupAId}/entries`, {
      method: "POST",
      body: JSON.stringify({ catalogEntityId, providerModelKey, providerAccountId: accountBId }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "duplicate_model_alias_required" });

    const alternate = await groupRequest(tokenA, `/${groupAId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        catalogEntityId,
        providerModelKey,
        providerAccountId: accountBId,
        alias: "Human Model Backup",
      }),
    });
    expect(alternate.status).toBe(201);

    const exactRouteDuplicate = await groupRequest(tokenA, `/${groupAId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        catalogEntityId,
        providerModelKey,
        providerAccountId: accountBId,
        alias: "Another public name",
      }),
    });
    expect(exactRouteDuplicate.status).toBe(409);
    expect(await exactRouteDuplicate.json()).toMatchObject({ code: "model_route_already_in_group" });

    const updatedDetail = await groupRequest(tokenA, `/${groupAId}`);
    const updatedBody = await updatedDetail.json() as {
      entries: Array<{ alias: string | null; hiddenAliases: string[] }>;
    };
    expect(updatedBody.entries).toHaveLength(2);
    expect(updatedBody.entries[0]).toMatchObject({ alias: null, hiddenAliases: ["big", "opus", "default"] });
    expect(updatedBody.entries[1]).toMatchObject({ alias: "Human Model Backup", hiddenAliases: ["medium", "sonnet", "secondary"] });

    expect((await groupRequest(tokenB, `/${groupAId}`)).status).toBe(404);
  });

  test("keeps exactly one user-owned default without relinking instances", async () => {
    await db.insert(schema.instances).values({
      id: `${prefix}-linked-instance`,
      userId: userAId,
      name: "Existing link",
      modelGroupId: groupAId,
    });
    const changed = await groupRequest(tokenA, `/${groupBId}/set-default`, { method: "PUT", body: "{}" });
    expect(changed.status).toBe(200);
    const defaults = await db.select().from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.userId, userAId), eq(schema.modelGroups.isDefault, true)));
    expect(defaults.map((group) => group.id)).toEqual([groupBId]);
    const [instance] = await db.select().from(schema.instances)
      .where(eq(schema.instances.id, `${prefix}-linked-instance`));
    expect(instance.modelGroupId).toBe(groupAId);
    expect((await groupRequest(tokenA, `/${groupBId}`, { method: "DELETE" })).status).toBe(400);
  });
});
