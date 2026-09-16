import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { signJwt } from "../middleware/auth";
import { assertCatalogPostgresTestDatabase } from "../services/catalog-postgres-test-safety";
import { reconcileCatalog, stageProviderInventorySnapshot } from "../services/catalog-reconciliation";
import type { ProviderModelInput } from "../services/catalog-planner";
import providerRoutes from "./providers";
import testModelRoutes from "./test-model";
import { encrypt, decrypt } from "../services/encryption";
import { registry } from "../providers/registry";
import { parseProviderCredential } from "../services/provider-credential-codec";
import { replaceProviderOAuthCredential } from "../services/provider-credentials";

const enabled = process.env.CATALOG_POSTGRES_TEST === "1";
const prefix = "provider-current-inventory-test";
const providerId = `${prefix}-provider`;
const currentModelKey = `${prefix}-current`;
const staleModelKey = `${prefix}-stale`;
const userId = `${prefix}-user`;
let token = "";
const accountAId = `${prefix}-account-a`;
const accountBId = `${prefix}-account-b`;

const currentRecord: ProviderModelInput = {
  id: currentModelKey,
  providerId,
  providerName: "Current Inventory Test Provider",
  rawModelId: "acme/current-model",
  displayName: "Current Model",
  existingModelId: "acme/current-model",
  inputPrice: null,
  outputPrice: null,
  contextWindow: 32_000,
  maxOutput: 4_096,
  supportsTools: false,
  supportsVision: false,
  supportsStreaming: true,
};

function authHeaders() {
  return { authorization: `Bearer ${token}` };
}

describe.skipIf(!enabled)("provider current inventory PostgreSQL integration", () => {
  beforeAll(async () => {
    assertCatalogPostgresTestDatabase();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));

    await db.insert(schema.users).values({
      id: userId,
      email: "provider-current-inventory@example.test",
      name: "Provider Inventory User",
      passwordHash: "not-used",
      role: "user",
    });
    await db.insert(schema.providers).values({
      id: providerId,
      name: "Current Inventory Test Provider",
      type: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      status: "active",
    });
    await db.insert(schema.providerModels).values([
      {
        id: currentModelKey,
        providerId,
        modelId: "acme/current-model",
        displayName: "Current Model",
        providerModelId: "acme/current-model",
      },
      {
        id: staleModelKey,
        providerId,
        modelId: "acme/removed-model",
        displayName: "Removed Model",
        providerModelId: "acme/removed-model",
      },
    ]);
    await db.insert(schema.providerKeys).values({
      id: `${prefix}-key`,
      userId,
      providerId,
      apiKeyEncrypted: "synthetic-test-ciphertext",
    });
    await db.insert(schema.providerAccounts).values([
      { id: accountAId, userId, providerId, nickname: "OAuth A" },
      { id: accountBId, userId, providerId, nickname: "OAuth B" },
    ]);
    await db.insert(schema.providerAccountModels).values([
      { id: `${prefix}-account-model-a`, providerAccountId: accountAId, providerModelId: currentModelKey },
      { id: `${prefix}-account-model-b`, providerAccountId: accountBId, providerModelId: currentModelKey },
    ]);
    await db.insert(schema.providerKeys).values([
      { id: `${prefix}-account-key-a`, userId, providerId, providerAccountId: accountAId, apiKeyEncrypted: encrypt("synthetic-account-key-a") },
      { id: `${prefix}-account-key-b`, userId, providerId, providerAccountId: accountBId, apiKeyEncrypted: encrypt("synthetic-account-key-b") },
    ]);
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Current Inventory Test Provider",
      sourceUrl: "https://provider.example.test/v1/models",
      records: [currentRecord],
      completedAt: new Date("2026-07-29T00:00:00Z"),
    });
    await reconcileCatalog();
    token = await signJwt({
      id: userId,
      email: "provider-current-inventory@example.test",
      name: "Provider Inventory User",
      role: "user",
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));
  });

  test("provider list, detail, model list, and test targets exclude historical rows", async () => {
    const listResponse = await providerRoutes.request("http://pointer.test/", {
      headers: authHeaders(),
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as Array<{ id: string; modelCount: number }>;
    expect(list.find((provider) => provider.id === providerId)?.modelCount).toBe(1);

    const detailResponse = await providerRoutes.request(`http://pointer.test/${providerId}`, {
      headers: authHeaders(),
    });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as {
      modelCount: number;
      models: Array<{ providerModelId: string }>;
    };
    expect(detail.modelCount).toBe(1);
    expect(detail.models.map((model) => model.providerModelId)).toEqual(["acme/current-model"]);

    const modelsResponse = await providerRoutes.request(`http://pointer.test/${providerId}/models`, {
      headers: authHeaders(),
    });
    expect(modelsResponse.status).toBe(200);
    const models = await modelsResponse.json() as {
      count: number;
      models: Array<{ providerModelId: string }>;
    };
    expect(models.count).toBe(1);
    expect(models.models.map((model) => model.providerModelId)).toEqual(["acme/current-model"]);

    const targetsResponse = await testModelRoutes.request("http://pointer.test/targets", {
      headers: authHeaders(),
    });
    expect(targetsResponse.status).toBe(200);
    const targets = await targetsResponse.json() as {
      models: Array<{ providers: Array<{ rawModelId: string }> }>;
    };
    const rawModelIds = targets.models.flatMap((model) =>
      model.providers.map((provider) => provider.rawModelId)
    );
    expect(rawModelIds).toContain("acme/current-model");
    expect(rawModelIds).not.toContain("acme/removed-model");
  });

  test("OAuth replacement changes only the selected provider account", async () => {
    await replaceProviderOAuthCredential({
      userId,
      providerId,
      providerAccountId: accountAId,
      credential: { accessToken: "synthetic-oauth-access", refreshToken: "synthetic-oauth-refresh" },
      issuer: "https://oauth.example.test",
      clientId: "pointer-test",
      label: "OAuth A",
    });
    const keys = await db.select({
      id: schema.providerKeys.id,
      providerAccountId: schema.providerKeys.providerAccountId,
    }).from(schema.providerKeys).where(eq(schema.providerKeys.userId, userId));
    expect(keys.find((key) => key.providerAccountId === accountAId)?.id)
      .not.toBe(`${prefix}-account-key-a`);
    expect(keys.find((key) => key.providerAccountId === accountBId)?.id)
      .toBe(`${prefix}-account-key-b`);
  });

  test("database refresh serialization rotates once and never resurrects a replaced key", async () => {
    const internal = registry as any;
    const previous = internal.providers.get(providerId);
    let calls = 0;
    internal.providers.set(providerId, { manifest: {}, handler: {
      refreshOAuthCredential: async () => {
        calls++;
        await Bun.sleep(30);
        return { accessToken: "synthetic-rotated-access", refreshToken: "synthetic-rotated-refresh",
          expiresAt: new Date(Date.now() + 3600000).toISOString() };
      },
    } });
    try {
      const [row] = await db.select().from(schema.providerKeys)
        .where(eq(schema.providerKeys.providerAccountId, accountAId));
      const parsed = parseProviderCredential(decrypt(row.apiKeyEncrypted));
      if (parsed.kind !== "oauth2") throw new Error("Missing test OAuth credential");
      // Bypass the in-process promise cache: these independent transactions
      // exercise the same row-lock boundary used by multiple server processes.
      const result = await Promise.all([
        internal.resolveOAuthAccessToken(row.id, providerId, parsed.value),
        internal.resolveOAuthAccessToken(row.id, providerId, parsed.value),
      ]);
      expect(calls).toBe(1);
      expect(result).toEqual(["synthetic-rotated-access", "synthetic-rotated-access"]);
      const [saved] = await db.select().from(schema.providerKeys).where(eq(schema.providerKeys.id, row.id));
      expect(JSON.parse(decrypt(saved.apiKeyEncrypted)).refreshToken).toBe("synthetic-rotated-refresh");
      await replaceProviderOAuthCredential({ userId, providerId, providerAccountId: accountAId,
        credential: { accessToken: "synthetic-reconnected", refreshToken: "synthetic-new-refresh" },
        issuer: "https://oauth.example.test", clientId: "pointer-test", label: "Reconnected test account" });
      expect(await internal.resolveOAuthAccessToken(row.id, providerId, parsed.value)).toBeNull();
      expect(calls).toBe(1);
    } finally {
      if (previous) internal.providers.set(providerId, previous); else internal.providers.delete(providerId);
    }
  });
});
