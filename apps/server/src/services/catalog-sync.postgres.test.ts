import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { assertCatalogPostgresTestDatabase } from "./catalog-postgres-test-safety";
import { syncCanonicalCatalog } from "./catalog-sync";
import type { NormalizedReferenceModel } from "./sources/types";

const integrationTest = process.env.CATALOG_POSTGRES_TEST === "1" ? test : test.skip;
const sourceId = "catalog-slug-replacement-test";
const staleModelId = "vendor/stale-model";
const currentModelId = "vendor/current-model";
const sharedSlug = "vendor/shared-model";

const provenance = {
  source: sourceId,
  sourceUrl: "https://catalog-sync.example.test/models",
  license: "test",
  fetchedAt: "2026-08-08T00:00:00.000Z",
};

const reference: NormalizedReferenceModel = {
  id: currentModelId,
  canonicalSlug: sharedSlug,
  displayName: "Current Model",
  creator: "vendor",
  description: "Current source-owned model",
  contextWindow: 32_000,
  maxOutput: 8_000,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools"],
  inputPricePerMillion: 1,
  outputPricePerMillion: 2,
  cacheReadPricePerMillion: null,
  cacheWritePricePerMillion: null,
  raw: { id: currentModelId },
  provenance,
};

describe("legacy catalog projection PostgreSQL integration", () => {
  beforeAll(async () => {
    if (process.env.CATALOG_POSTGRES_TEST !== "1") return;
    assertCatalogPostgresTestDatabase();
    await db.execute(sql`truncate table
      source_records,
      source_sync_states,
      model_catalog restart identity cascade`);
    await db.insert(schema.sourceSyncStates).values({
      sourceId,
      status: "healthy",
      lastAttemptAt: new Date(provenance.fetchedAt),
    });
    await db.insert(schema.sourceRecords).values({
      id: `${sourceId}:current`,
      sourceId,
      recordKey: currentModelId,
      kind: "reference_model",
      payload: reference,
      provenance,
      fetchedAt: new Date(provenance.fetchedAt),
    });
    await db.insert(schema.modelCatalog).values({
      modelId: staleModelId,
      canonicalSlug: sharedSlug,
      name: "Stale Model",
    });
  });

  afterAll(async () => {
    if (process.env.CATALOG_POSTGRES_TEST !== "1") return;
    await db.execute(sql`truncate table
      source_records,
      source_sync_states,
      model_catalog restart identity cascade`);
  });

  integrationTest("atomically transfers a slug from retained stale history to the current plan", async () => {
    await expect(syncCanonicalCatalog()).resolves.toMatchObject({
      modelCount: 1,
      providerMappingCount: 0,
    });

    const rows = await db.select({
      id: schema.modelCatalog.modelId,
      slug: schema.modelCatalog.canonicalSlug,
    }).from(schema.modelCatalog)
      .where(sql`${schema.modelCatalog.modelId} in (${staleModelId}, ${currentModelId})`);

    expect(rows.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: currentModelId, slug: sharedSlug },
      { id: staleModelId, slug: null },
    ]);
    expect(await db.select().from(schema.modelCatalog)
      .where(eq(schema.modelCatalog.canonicalSlug, sharedSlug))).toHaveLength(1);
  });
});
