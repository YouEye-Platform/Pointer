import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pruneCatalog } from "./catalog-retention";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import {
  activateCatalogGeneration,
  deleteProviderAndReconcileCatalog,
  dryRunCatalogGarbageCollection,
  reconcileCatalog,
  stageProviderInventorySnapshot,
  stageSourceInventorySnapshot,
} from "./catalog-reconciliation";
import type { ProviderModelInput } from "./catalog-planner";
import type { NormalizedReferenceModel, SourceSnapshot } from "./sources/types";
import { catalogResponseSchema } from "./catalog-contracts";
import { stableCatalogJson } from "./catalog-reconciliation-core";
import { loadCatalog, loadCatalogDetail } from "../routes/catalog";
import { assertCatalogPostgresTestDatabase } from "./catalog-postgres-test-safety";

const integrationTest = process.env.CATALOG_POSTGRES_TEST === "1" ? test : test.skip;
const providerId = "catalog-test-provider";
const providerModelId = "catalog-test-provider-model";
const oldProviderModelId = "catalog-test-old-provider-model";

const reference: NormalizedReferenceModel = {
  id: "anthropic/claude-3.7-sonnet",
  canonicalSlug: "anthropic--claude-3.7-sonnet",
  displayName: "Claude 3.7 Sonnet",
  creator: "anthropic",
  description: "Test reference",
  contextWindow: 200_000,
  maxOutput: 64_000,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools"],
  inputPricePerMillion: 3,
  outputPricePerMillion: 15,
  cacheReadPricePerMillion: null,
  cacheWritePricePerMillion: null,
  raw: { id: "anthropic/claude-3.7-sonnet" },
  provenance: {
    source: "openrouter",
    sourceUrl: "https://openrouter.ai/api/v1/models",
    license: "public",
    fetchedAt: "2026-07-17T00:00:00.000Z",
  },
};

const providerRecord = (id: string, rawModelId: string): ProviderModelInput => ({
  id,
  providerId,
  providerName: "Catalog Test Provider",
  rawModelId,
  existingModelId: rawModelId,
  inputPrice: "1",
  outputPrice: "2",
  contextWindow: 100_000,
  maxOutput: 8_000,
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
});

const referenceSnapshot: SourceSnapshot<NormalizedReferenceModel> = {
  sourceId: "openrouter",
  records: [reference],
  provenance: reference.provenance,
};

async function activeGenerationId() {
  const [row] = await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)
    .where(eq(schema.catalogGenerations.state, "active")).limit(1);
  return row?.id ?? null;
}

async function generationFacts(generationId: string) {
  const [entities, routes, links, snapshots, decisions] = await Promise.all([
    db.select({ id: schema.catalogGenerationEntities.entityId, slug: schema.catalogGenerationEntities.stableSlug }).from(schema.catalogGenerationEntities).where(eq(schema.catalogGenerationEntities.generationId, generationId)),
    db.select({ providerId: schema.catalogGenerationProviderRoutes.providerId, rawModelId: schema.catalogGenerationProviderRoutes.rawModelId, entityId: schema.catalogGenerationProviderRoutes.entityId }).from(schema.catalogGenerationProviderRoutes).where(eq(schema.catalogGenerationProviderRoutes.generationId, generationId)),
    db.select({ entityId: schema.catalogGenerationObservationLinks.entityId }).from(schema.catalogGenerationObservationLinks).where(eq(schema.catalogGenerationObservationLinks.generationId, generationId)),
    db.select({ sourceId: schema.catalogGenerationSnapshots.sourceId }).from(schema.catalogGenerationSnapshots).where(eq(schema.catalogGenerationSnapshots.generationId, generationId)),
    db.select({ state: schema.catalogGenerationDecisions.state }).from(schema.catalogGenerationDecisions).where(eq(schema.catalogGenerationDecisions.generationId, generationId)),
  ]);
  return {
    entities: entities.sort((left, right) => left.id.localeCompare(right.id)),
    routes: routes.sort((left, right) => left.rawModelId.localeCompare(right.rawModelId)),
    linkCount: links.length,
    sources: snapshots.map((row) => row.sourceId).sort(),
    decisionStates: decisions.map((row) => row.state).sort(),
  };
}

async function generationIdentityFacts(generationId: string) {
  const [[generation], decisions] = await Promise.all([
    db.select({ stats: schema.catalogGenerations.stats }).from(schema.catalogGenerations)
      .where(eq(schema.catalogGenerations.id, generationId)).limit(1),
    db.select({
      observationId: schema.catalogGenerationDecisions.observationId,
      entityId: schema.catalogGenerationDecisions.entityId,
      state: schema.catalogGenerationDecisions.state,
      method: schema.catalogGenerationDecisions.method,
      confidence: schema.catalogGenerationDecisions.confidence,
      score: schema.catalogGenerationDecisions.score,
      margin: schema.catalogGenerationDecisions.margin,
      candidateEntityIds: schema.catalogGenerationDecisions.candidateEntityIds,
      evidence: schema.catalogGenerationDecisions.evidence,
      blockers: schema.catalogGenerationDecisions.blockers,
      resolverVersion: schema.catalogGenerationDecisions.resolverVersion,
    }).from(schema.catalogGenerationDecisions).where(eq(schema.catalogGenerationDecisions.generationId, generationId)),
  ]);
  return {
    contentHash: (generation.stats as Record<string, unknown>).contentHash,
    decisions: decisions.sort((left, right) => left.observationId.localeCompare(right.observationId)),
  };
}

describe("catalog reconciliation PostgreSQL integration", () => {
  beforeAll(async () => {
    if (process.env.CATALOG_POSTGRES_TEST !== "1") return;
    assertCatalogPostgresTestDatabase();
    await db.execute(sql`truncate table
      catalog_generation_assets,
      catalog_generation_benchmark_links,
      catalog_generation_provider_routes,
      catalog_generation_aliases,
      catalog_generation_decisions,
      catalog_generation_observation_links,
      catalog_generation_entities,
      catalog_generation_organizations,
      catalog_generation_snapshots,
      resolver_decisions,
      resolver_runs,
      observation_entity_links,
      model_observations,
      source_snapshots,
      identity_claims,
      catalog_assets,
      organization_aliases,
      organizations,
      model_entities,
      catalog_generations,
      source_records,
      source_sync_states restart identity cascade`);
    await db.delete(schema.providerModels).where(eq(schema.providerModels.providerId, providerId));
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));
    await db.insert(schema.providers).values({
      id: providerId,
      name: "Catalog Test Provider",
      type: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      status: "active",
    });
    await db.insert(schema.providerModels).values([
      { id: providerModelId, providerId, modelId: "claude-3.7-sonnet", providerModelId: "claude-3.7-sonnet", supportsStreaming: true },
      { id: oldProviderModelId, providerId, modelId: "acme/old-model", providerModelId: "acme/old-model", supportsStreaming: true },
    ]);
    await db.insert(schema.sourceSyncStates).values({ sourceId: "openrouter", status: "syncing", lastAttemptAt: new Date("2026-07-17T00:00:00Z") });
    await db.transaction((tx) => stageSourceInventorySnapshot(tx, referenceSnapshot, new Date("2026-07-17T00:00:01Z")));
  });

  afterAll(async () => {
    if (process.env.CATALOG_POSTGRES_TEST !== "1") return;
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));
  });

  integrationTest("activates a complete generation and preserves exact raw provider IDs", async () => {
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [
        providerRecord(providerModelId, "claude-3.7-sonnet"),
        providerRecord(oldProviderModelId, "acme/old-model"),
      ],
      completedAt: new Date("2026-07-17T00:00:02Z"),
    });
    const first = await reconcileCatalog();
    expect(await activeGenerationId()).toBe(first.generationId);
    const facts = await generationFacts(first.generationId);
    expect(facts.sources).toEqual(["openrouter", `provider:${providerId}`]);
    expect(facts.routes.map((route) => route.rawModelId)).toEqual(["acme/old-model", "claude-3.7-sonnet"]);
    const canonicalEntityId = facts.routes.find((route) => route.rawModelId === "claude-3.7-sonnet")?.entityId;
    expect(canonicalEntityId?.startsWith("model/")).toBe(true);
    expect(canonicalEntityId).not.toBe(reference.id);
    expect(facts.decisionStates.every((state) => state === "linked")).toBe(true);
    const [resolverRun] = await db.select().from(schema.resolverRuns).where(eq(schema.resolverRuns.generationId, first.generationId));
    expect(resolverRun.status).toBe("completed");
    expect(resolverRun.resolverVersion).toBe("catalog-identity-2");
    expect((await db.select().from(schema.resolverDecisions).where(eq(schema.resolverDecisions.resolverRunId, resolverRun.id))).length).toBe(facts.decisionStates.length);
  });

  integrationTest("resolves retained entity IDs and slugs through generation compatibility aliases", async () => {
    const generationId = (await activeGenerationId())!;
    const [link] = await db.select().from(schema.catalogGenerationObservationLinks)
      .where(eq(schema.catalogGenerationObservationLinks.generationId, generationId)).limit(1);
    await db.insert(schema.catalogGenerationAliases).values([
      {
        id: "catalog-test-redirect-id",
        generationId,
        sourceId: "pointer:entity-redirect",
        alias: "model/historical-catalog-test",
        observationId: link.observationId,
        entityId: link.entityId,
      },
      {
        id: "catalog-test-redirect-slug",
        generationId,
        sourceId: "pointer:entity-redirect",
        alias: "models/historical-catalog-test",
        observationId: link.observationId,
        entityId: link.entityId,
      },
    ]);
    expect((await loadCatalogDetail("model/historical-catalog-test")).item?.id).toBe(link.entityId);
    expect((await loadCatalogDetail("models/historical-catalog-test")).item?.id).toBe(link.entityId);
  });

  integrationTest("rolls back every interruption boundary without changing the active pointer", async () => {
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [
        { ...providerRecord(providerModelId, "claude-3.7-sonnet"), inputPrice: "1.5" },
        providerRecord(oldProviderModelId, "acme/old-model"),
      ],
      completedAt: new Date("2026-07-17T00:00:30Z"),
    });
    const before = await activeGenerationId();
    const responseBefore = stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()));
    expect(before).not.toBeNull();
    for (const failAt of ["after_plan", "after_staging", "before_activation", "after_activation"] as const) {
      await expect(reconcileCatalog({ failAt })).rejects.toThrow(`catalog reconciliation failpoint: ${failAt}`);
      expect(await activeGenerationId()).toBe(before);
      expect(stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()))).toBe(responseBefore);
      const activeCount = await db.select({ count: sql<number>`count(*)::int` }).from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active"));
      expect(activeCount[0].count).toBe(1);
    }
    const failedRuns = await db.select().from(schema.resolverRuns).where(eq(schema.resolverRuns.status, "failed"));
    expect(failedRuns).toHaveLength(4);
  });

  integrationTest("freezes organization, alias, asset, and source presentation for exact rollback", async () => {
    const organizationId = "org/anthropic";
    await db.insert(schema.organizationAliases).values({
      id: "catalog-test-org-alias",
      organizationId,
      alias: "Anthropic Original",
      normalizedAlias: "anthropic-original",
    });
    await db.insert(schema.catalogAssets).values([
      {
        id: "catalog-test-asset",
        organizationId,
        kind: "logo",
        originUrl: "https://assets.example.test/original.svg",
        license: "test-original",
        contentHash: "catalog-test-original",
        mimeType: "image/svg+xml",
        byteSize: 10,
        validationState: "valid",
        fetchedAt: new Date("2026-07-17T00:00:03Z"),
        active: true,
      },
      {
        id: "catalog-test-icon",
        organizationId,
        kind: "icon",
        originUrl: "https://assets.example.test/original-icon.svg",
        license: "test-original",
        contentHash: "catalog-test-original-icon",
        mimeType: "image/svg+xml",
        byteSize: 5,
        validationState: "valid",
        fetchedAt: new Date("2026-07-17T00:00:03Z"),
        active: true,
      },
    ]);
    const original = await reconcileCatalog();
    const parsedOriginalResponse = catalogResponseSchema.parse(await loadCatalog());
    expect(parsedOriginalResponse.items.find((item) => item.organization?.id === organizationId)?.asset?.kind).toBe("logo");
    const originalResponse = stableCatalogJson(parsedOriginalResponse);

    await db.update(schema.organizations).set({ canonicalName: "Anthropic Mutated" }).where(eq(schema.organizations.id, organizationId));
    await db.update(schema.organizationAliases).set({ alias: "Anthropic Mutated", normalizedAlias: "anthropic-mutated" })
      .where(eq(schema.organizationAliases.id, "catalog-test-org-alias"));
    await db.update(schema.catalogAssets).set({
      originUrl: "https://assets.example.test/mutated.svg",
      license: "test-mutated",
      contentHash: "catalog-test-mutated",
      byteSize: 20,
    }).where(eq(schema.catalogAssets.id, "catalog-test-asset"));
    const mutated = await reconcileCatalog();
    expect(stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()))).not.toBe(originalResponse);

    await activateCatalogGeneration(original.generationId);
    expect(stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()))).toBe(originalResponse);
    await activateCatalogGeneration(mutated.generationId);
  });

  integrationTest("rejects empty and duplicate inventories without deactivating last-known-good data", async () => {
    const before = await activeGenerationId();
    await expect(stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [],
    })).rejects.toThrow("empty inventory");
    const duplicate = providerRecord(providerModelId, "claude-3.7-sonnet");
    await expect(stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [duplicate, { ...duplicate, id: "duplicate-row" }],
    })).rejects.toThrow("duplicate raw model IDs");
    await expect(db.transaction((tx) => stageSourceInventorySnapshot(tx, { ...referenceSnapshot, records: [] }, new Date()))).rejects.toThrow("empty snapshot");
    expect(await activeGenerationId()).toBe(before);
  });

  integrationTest("deactivates removed provider observations without deleting historical generations", async () => {
    const firstGenerationId = await activeGenerationId();
    expect(firstGenerationId).not.toBeNull();
    const firstFacts = await generationFacts(firstGenerationId!);
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [providerRecord(providerModelId, "claude-3.7-sonnet")],
      completedAt: new Date("2026-07-17T00:01:00Z"),
    });
    const second = await reconcileCatalog();
    const secondFacts = await generationFacts(second.generationId);
    expect(second.stats.deactivatedEntityCount).toBe(1);
    expect(second.stats.removedRouteCount).toBe(1);
    expect(second.stats.changeCount).toBeGreaterThanOrEqual(2);
    expect(secondFacts.routes.map((route) => route.rawModelId)).toEqual(["claude-3.7-sonnet"]);
    expect(firstFacts.routes.map((route) => route.rawModelId)).toContain("acme/old-model");
    expect((await db.select().from(schema.catalogGenerationProviderRoutes).where(eq(schema.catalogGenerationProviderRoutes.generationId, firstGenerationId!))).length).toBe(2);
  });

  integrationTest("reuses the active generation for identical inputs and can retain the pointer", async () => {
    const previous = await activeGenerationId();
    const previousFacts = await generationFacts(previous!);
    const previousIdentityFacts = await generationIdentityFacts(previous!);
    const previousResponse = stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()));
    const repeated = await reconcileCatalog();
    expect(repeated).toMatchObject({ generationId: previous, noOp: true });
    expect(await generationFacts(repeated.generationId)).toEqual(previousFacts);
    expect(await generationIdentityFacts(repeated.generationId)).toEqual(previousIdentityFacts);
    const repeatedResponse = catalogResponseSchema.parse(await loadCatalog());
    const parsedPreviousResponse = catalogResponseSchema.parse(JSON.parse(previousResponse));
    expect(repeatedResponse.items).toEqual(parsedPreviousResponse.items);
    expect(repeatedResponse.sources).toEqual(parsedPreviousResponse.sources);
    await activateCatalogGeneration(previous!);
    expect(await activeGenerationId()).toBe(previous);
    expect(await generationFacts(previous!)).toEqual(previousFacts);
    expect(stableCatalogJson(catalogResponseSchema.parse(await loadCatalog()))).toBe(previousResponse);
  });

  integrationTest("applies approved reviews, honors rejections, and preserves the reviewed target", async () => {
    const generationBeforeReview = (await activeGenerationId())!;
    const [providerObservation] = await db.select({ id: schema.modelObservations.id }).from(schema.modelObservations)
      .where(and(
        eq(schema.modelObservations.sourceId, `provider:${providerId}`),
        eq(schema.modelObservations.nativeId, "claude-3.7-sonnet"),
        eq(schema.modelObservations.active, true)
      )).limit(1);
    const [originalLink] = await db.select().from(schema.observationEntityLinks)
      .where(eq(schema.observationEntityLinks.observationId, providerObservation.id)).limit(1);
    const reviewedEntityId = originalLink.entityId;

    await db.update(schema.observationEntityLinks).set({
      reviewState: "approved",
      reviewedAt: new Date("2026-07-17T00:02:00Z"),
    }).where(eq(schema.observationEntityLinks.observationId, providerObservation.id));
    const approved = await reconcileCatalog();
    const approvedDecision = (await generationIdentityFacts(approved.generationId)).decisions
      .find((decision) => decision.observationId === providerObservation.id);
    expect(approvedDecision).toMatchObject({ entityId: reviewedEntityId, state: "linked", method: "reviewed_override" });

    await db.update(schema.observationEntityLinks).set({
      reviewState: "rejected",
      reviewedAt: new Date("2026-07-17T00:03:00Z"),
    }).where(eq(schema.observationEntityLinks.observationId, providerObservation.id));
    await expect(activateCatalogGeneration(generationBeforeReview)).rejects.toThrow("conflicts with a rejected identity review");
    const rejected = await reconcileCatalog();
    const rejectedDecision = (await generationIdentityFacts(rejected.generationId)).decisions
      .find((decision) => decision.observationId === providerObservation.id);
    expect(rejectedDecision?.entityId).not.toBe(reviewedEntityId);
    expect(rejectedDecision?.method).not.toBe("reviewed_override");
    const [preservedReview] = await db.select().from(schema.observationEntityLinks)
      .where(eq(schema.observationEntityLinks.observationId, providerObservation.id)).limit(1);
    expect(preservedReview).toMatchObject({ entityId: reviewedEntityId, reviewState: "rejected" });

    await db.update(schema.observationEntityLinks).set({
      reviewState: "approved",
      reviewedAt: new Date("2026-07-17T00:04:00Z"),
    }).where(eq(schema.observationEntityLinks.observationId, providerObservation.id));
    const restored = await reconcileCatalog();
    const restoredDecision = (await generationIdentityFacts(restored.generationId)).decisions
      .find((decision) => decision.observationId === providerObservation.id);
    expect(restoredDecision).toMatchObject({ entityId: reviewedEntityId, state: "linked", method: "reviewed_override" });
    await expect(activateCatalogGeneration(rejected.generationId)).rejects.toThrow("conflicts with an approved identity review");
    expect(await activeGenerationId()).toBe(restored.generationId);
  });

  integrationTest("serializes review mutations with reconciliation activation", async () => {
    const [reviewedLink] = await db.select({ observationId: schema.observationEntityLinks.observationId })
      .from(schema.observationEntityLinks).where(eq(schema.observationEntityLinks.reviewState, "approved")).limit(1);
    let reachedCheckpoint!: () => void;
    let resumeReconciliation!: () => void;
    const checkpoint = new Promise<void>((resolve) => { reachedCheckpoint = resolve; });
    const resume = new Promise<void>((resolve) => { resumeReconciliation = resolve; });
    const reconciliation = reconcileCatalog({
      onCheckpoint: async (point) => {
        if (point !== "after_plan") return;
        reachedCheckpoint();
        await resume;
      },
    });
    await checkpoint;
    let lockTimedOut = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '50ms'`);
        await tx.update(schema.observationEntityLinks).set({ updatedAt: new Date() })
          .where(eq(schema.observationEntityLinks.observationId, reviewedLink.observationId));
      });
    } catch {
      lockTimedOut = true;
    } finally {
      resumeReconciliation();
    }
    expect(lockTimedOut).toBe(true);
    await reconciliation;
  });

  integrationTest("serializes concurrent reconciliation and keeps one active generation", async () => {
    const [left, right] = await Promise.all([reconcileCatalog(), reconcileCatalog()]);
    expect(left.generationId).toBe(right.generationId);
    expect(left).toMatchObject({ noOp: true });
    expect(right).toMatchObject({ noOp: true });
    const rows = await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(left.generationId);
  });

  integrationTest("reuses A after A-B-A inventory without leaving B selected", async () => {
    const stage = (description: string, time: string) => db.transaction(tx => stageSourceInventorySnapshot(tx, {
      ...referenceSnapshot, records: [{ ...reference, description }],
      provenance: { ...referenceSnapshot.provenance, fetchedAt: time },
    }, new Date(time)));
    const a = await stage("Cycle A", "2026-09-09T01:00:00Z");
    const b = await stage("Cycle B", "2026-09-09T01:01:00Z");
    const again = await stage("Cycle A", "2026-09-09T01:02:00Z");
    expect(again.snapshotId).toBe(a.snapshotId);
    expect(again.snapshotId).not.toBe(b.snapshotId);
    await reconcileCatalog();
    const rows = await db.select().from(schema.catalogGenerationSnapshots)
      .where(eq(schema.catalogGenerationSnapshots.generationId, (await activeGenerationId())!));
    expect(rows.filter(r => r.sourceId === "openrouter").map(r => r.snapshotId)).toEqual([a.snapshotId]);
    expect(await reconcileCatalog()).toMatchObject({ noOp: true });
  });

  integrationTest("protects the active and rollback generations from dry-run garbage collection", async () => {
    const plan = await dryRunCatalogGarbageCollection({ now: new Date("2027-07-17T00:00:00Z"), retentionDays: 30 });
    expect(plan.dryRun).toBe(true);
    expect(plan.generationIds.some((id) => plan.protectedGenerationIds.includes(id))).toBe(false);
    expect(plan.protectedGenerationIds).toContain(await activeGenerationId());
    const [active] = await db.select().from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active")).limit(1);
    const rollbackGenerationId = (active.stats as Record<string, unknown>).previousGenerationId;
    if (typeof rollbackGenerationId === "string") expect(plan.protectedGenerationIds).toContain(rollbackGenerationId);
  });

  integrationTest("plans unreferenced snapshots, observations, and superseded assets without deleting them", async () => {
    const sourceId = "catalog-gc-test";
    const snapshotId = "catalog-gc-test-snapshot";
    const observationId = "catalog-gc-test-observation";
    const validatedSnapshotId = "catalog-gc-test-validated-snapshot";
    const reviewedSnapshotId = "catalog-gc-test-reviewed-snapshot";
    const reviewedObservationId = "catalog-gc-test-reviewed-observation";
    const assetId = "catalog-gc-test-asset";
    const old = new Date("2025-01-01T00:00:00Z");
    await db.insert(schema.sourceSyncStates).values({ sourceId, status: "ok", fetchedAt: old, recordCount: 1, updatedAt: old });
    await db.insert(schema.sourceSnapshots).values({
      id: snapshotId,
      sourceId,
      revision: "gc-test",
      sourceUrl: "https://gc.example.test/models",
      license: "test",
      fetchedAt: old,
      recordCount: 1,
      contentHash: "gc-test",
      state: "retired",
      active: false,
      createdAt: old,
    });
    await db.insert(schema.sourceSnapshots).values({
      id: reviewedSnapshotId,
      sourceId,
      revision: "gc-test-reviewed",
      sourceUrl: "https://gc.example.test/reviewed-models",
      license: "test",
      fetchedAt: old,
      recordCount: 1,
      contentHash: "gc-test-reviewed",
      state: "retired",
      active: false,
      createdAt: old,
    });
    await db.insert(schema.modelObservations).values({
      id: reviewedObservationId,
      snapshotId: reviewedSnapshotId,
      sourceId,
      kind: "reference_model",
      nativeId: "gc/reviewed-model",
      rawName: "GC Reviewed Model",
      rawPayload: {},
      provenance: {},
      fetchedAt: old,
      active: false,
      createdAt: old,
    });
    const [reviewedEntity] = await db.select({ id: schema.modelEntities.id }).from(schema.modelEntities).limit(1);
    await db.insert(schema.observationEntityLinks).values({
      id: "catalog-gc-test-reviewed-link",
      observationId: reviewedObservationId,
      entityId: reviewedEntity.id,
      method: "reviewed_override",
      confidence: "1",
      evidence: ["gc-protection-test"],
      resolverVersion: "test",
      decisionState: "linked",
      reviewState: "approved",
    });
    await db.insert(schema.modelObservations).values({
      id: observationId,
      snapshotId,
      sourceId,
      kind: "reference_model",
      nativeId: "gc/test-model",
      rawName: "GC Test Model",
      rawPayload: {},
      provenance: {},
      fetchedAt: old,
      active: false,
      createdAt: old,
    });
    await db.insert(schema.sourceSnapshots).values({
      id: validatedSnapshotId,
      sourceId,
      revision: "gc-test-validated",
      sourceUrl: "https://gc.example.test/pending-models",
      license: "test",
      fetchedAt: old,
      recordCount: 1,
      contentHash: "gc-test-validated",
      state: "validated",
      active: false,
      createdAt: old,
    });
    await db.insert(schema.catalogAssets).values({
      id: assetId,
      organizationId: "org/anthropic",
      kind: "logo",
      originUrl: "https://gc.example.test/old.svg",
      license: "test",
      contentHash: "gc-test-old",
      mimeType: "image/svg+xml",
      byteSize: 1,
      validationState: "valid",
      fetchedAt: old,
      active: false,
      createdAt: old,
      updatedAt: old,
    });
    const plan = await dryRunCatalogGarbageCollection({ now: new Date("2027-07-17T00:00:00Z"), retentionDays: 30 });
    expect(plan.snapshotIds).toContain(snapshotId);
    expect(plan.snapshotIds).not.toContain(validatedSnapshotId);
    expect(plan.snapshotIds).not.toContain(reviewedSnapshotId);
    expect(plan.observationIds).toContain(observationId);
    expect(plan.assetIds).toContain(assetId);
    expect(await db.select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, snapshotId))).toHaveLength(1);
    expect(await db.select().from(schema.modelObservations).where(eq(schema.modelObservations.id, observationId))).toHaveLength(1);
    expect(await db.select().from(schema.catalogAssets).where(eq(schema.catalogAssets.id, assetId))).toHaveLength(1);
    const activeBeforeCleanup = await activeGenerationId();
    const cleanup = await pruneCatalog();
    expect(cleanup.outcome).toBe("completed");
    expect(await activeGenerationId()).toBe(activeBeforeCleanup);
    expect(await db.select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, snapshotId))).toHaveLength(0);
    expect(await db.select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, reviewedSnapshotId))).toHaveLength(1);
    expect(await db.select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, validatedSnapshotId))).toHaveLength(1);
    expect((await pruneCatalog()).outcome).toBe("completed");
    await db.delete(schema.catalogAssets).where(eq(schema.catalogAssets.id, assetId));
    await db.delete(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.sourceId, sourceId));
    await db.delete(schema.sourceSyncStates).where(eq(schema.sourceSyncStates.sourceId, sourceId));
  });

  integrationTest("retains denormalized route history when an operational provider is deleted", async () => {
    const generationId = await activeGenerationId();
    const before = await generationFacts(generationId!);
    const [deleted] = await Promise.all([deleteProviderAndReconcileCatalog(providerId), reconcileCatalog()]);
    expect(deleted?.deleted).toBe(true);
    expect((await generationFacts((await activeGenerationId())!)).routes).toHaveLength(0);
    expect((await generationFacts(generationId!)).routes).toEqual(before.routes);
  });

  integrationTest("persists duplicate display aliases for distinct source-native entities", async () => {
    const sourceId = "catalog-duplicate-alias-test";
    const provenance = {
      source: sourceId,
      sourceUrl: "https://duplicate.example.test/models",
      license: "test",
      fetchedAt: "2026-07-17T00:10:00.000Z",
    };
    const records: NormalizedReferenceModel[] = ["vendor-a/shared-name", "vendor-b/shared-name"].map((id) => ({
      ...reference,
      id,
      canonicalSlug: id.replace("/", "--"),
      displayName: "Shared Display Name",
      creator: id.split("/")[0],
      provenance,
    }));
    await db.insert(schema.sourceSyncStates).values({ sourceId, status: "syncing", lastAttemptAt: new Date(provenance.fetchedAt) });
    await db.transaction((tx) => stageSourceInventorySnapshot(tx, { sourceId, records, provenance }, new Date(provenance.fetchedAt)));
    const reconciled = await reconcileCatalog();
    const aliases = await db.select().from(schema.catalogGenerationAliases)
      .where(eq(schema.catalogGenerationAliases.generationId, reconciled.generationId));
    const shared = aliases.filter((alias) => alias.sourceId === sourceId && alias.alias === "Shared Display Name");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((alias) => alias.entityId)).size).toBe(2);
  });

  integrationTest("activates an empty catalog when the last provider is deleted", async () => {
    await db.execute(sql`truncate table
      source_sync_states,
      catalog_generations,
      source_snapshots,
      model_entities,
      organizations,
      catalog_assets restart identity cascade`);
    await db.delete(schema.providers).where(eq(schema.providers.id, providerId));
    await db.insert(schema.providers).values({
      id: providerId,
      name: "Catalog Test Provider",
      type: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      status: "active",
    });
    await stageProviderInventorySnapshot({
      providerId,
      providerName: "Catalog Test Provider",
      sourceUrl: "https://provider.example.test/v1",
      records: [providerRecord(providerModelId, "catalog-test/provider-only-model-1")],
      completedAt: new Date("2026-07-17T00:20:00Z"),
    });
    const populated = await reconcileCatalog();
    expect((await generationFacts(populated.generationId)).routes).toHaveLength(1);

    const deleted = await deleteProviderAndReconcileCatalog(providerId);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.reconciliation?.generationId).not.toBe(populated.generationId);
    expect(await db.select().from(schema.providers).where(eq(schema.providers.id, providerId))).toHaveLength(0);
    expect(await generationFacts(populated.generationId)).toMatchObject({ linkCount: 1 });
    expect(await generationFacts(deleted!.reconciliation!.generationId)).toEqual({
      entities: [],
      routes: [],
      linkCount: 0,
      sources: [],
      decisionStates: [],
    });
    expect(catalogResponseSchema.parse(await loadCatalog())).toMatchObject({ items: [], sources: [] });
    const emptyGenerationId = await activeGenerationId();
    await expect(reconcileCatalog()).rejects.toThrow("No validated catalog snapshots are available");
    expect(await activeGenerationId()).toBe(emptyGenerationId);

    const restoredAt = new Date("2026-07-17T00:21:00Z");
    await db.insert(schema.sourceSyncStates).values({ sourceId: "openrouter", status: "syncing", lastAttemptAt: restoredAt });
    await db.transaction((tx) => stageSourceInventorySnapshot(tx, referenceSnapshot, restoredAt));
    const restored = await reconcileCatalog();
    expect((await generationFacts(restored.generationId)).entities).toHaveLength(1);
  });
});
