import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import { resolveProviderModelCatalogIdentity } from "../providers/model-discovery";
import { registry } from "../providers/registry";
import { normalizeModelAggressive, normalizeModelLight } from "./model-identity";
import { planCanonicalCatalog, type ProviderModelInput } from "./catalog-planner";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel } from "./sources/types";
import { scheduleCatalogReconciliation } from "./catalog-reconciliation";

export async function syncCanonicalCatalog() {
  const [referenceRows, benchmarkRows, providerRows] = await Promise.all([
    db.select({ payload: schema.sourceRecords.payload }).from(schema.sourceRecords).where(eq(schema.sourceRecords.kind, "reference_model")),
    db.select({ payload: schema.sourceRecords.payload }).from(schema.sourceRecords).where(eq(schema.sourceRecords.kind, "benchmark")),
    db.select({ model: schema.providerModels, providerName: schema.providers.name })
      .from(schema.providerModels)
      .innerJoin(schema.providers, eq(schema.providers.id, schema.providerModels.providerId)),
  ]);
  const references = referenceRows.map((row) => row.payload as NormalizedReferenceModel);
  const benchmarks = benchmarkRows.map((row) => row.payload as NormalizedBenchmarkRecord);
  const providerModels: ProviderModelInput[] = providerRows.map(({ model, providerName }) => ({
    id: model.id,
    providerId: model.providerId,
    providerName,
    rawModelId: model.providerModelId,
    catalogIdentity: resolveProviderModelCatalogIdentity(
      model.rawMetadata,
      registry.getProvider(model.providerId)?.manifest
    ),
    displayName: model.displayName,
    existingModelId: model.modelId,
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    supportsTools: model.supportsTools ?? false,
    supportsVision: model.supportsVision ?? false,
    supportsStreaming: model.supportsStreaming ?? false,
  }));
  const plan = planCanonicalCatalog(references, providerModels, benchmarks);
  const syncedAt = new Date();

  await db.transaction(async (tx) => {
    // Source refreshes can remove or rename a model while the historical
    // model_catalog row remains referenced by usage and other retained data.
    // Release every prior deep-link claim inside this transaction before the
    // current complete plan assigns its slugs. Without this step, a new model
    // can collide with a stale row and roll back the entire catalog refresh.
    await tx.update(schema.modelCatalog).set({ canonicalSlug: null });

    for (const model of plan.models) {
      await tx.insert(schema.modelCatalog).values({
        modelId: model.id,
        canonicalSlug: model.slug,
        name: model.name,
        creator: model.creator,
        description: model.description,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        supportsStreaming: model.supportsStreaming,
        referenceInputPrice: model.referenceInputPrice === null ? null : String(model.referenceInputPrice),
        referenceOutputPrice: model.referenceOutputPrice === null ? null : String(model.referenceOutputPrice),
        metadataSource: model.metadataSource,
        metadataFetchedAt: model.metadataFetchedAt ? new Date(model.metadataFetchedAt) : null,
        rawMetadata: model.rawMetadata,
        updatedAt: syncedAt,
      }).onConflictDoUpdate({
        target: schema.modelCatalog.modelId,
        set: {
          canonicalSlug: model.slug,
          name: model.name,
          creator: model.creator,
          description: model.description,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          supportsTools: model.supportsTools,
          supportsVision: model.supportsVision,
          supportsStreaming: model.supportsStreaming,
          referenceInputPrice: model.referenceInputPrice === null ? null : String(model.referenceInputPrice),
          referenceOutputPrice: model.referenceOutputPrice === null ? null : String(model.referenceOutputPrice),
          metadataSource: model.metadataSource,
          metadataFetchedAt: model.metadataFetchedAt ? new Date(model.metadataFetchedAt) : null,
          rawMetadata: model.rawMetadata,
          updatedAt: syncedAt,
        },
      });
    }

    for (const mapping of plan.providerMappings) {
      await tx.update(schema.providerModels).set({ canonicalModelId: mapping.canonicalModelId })
        .where(eq(schema.providerModels.id, mapping.providerModelId));
    }

    await tx.delete(schema.modelAliases);
    const uniqueAliases = [...new Map(plan.aliases.map((alias) => [`${alias.source}\u0000${alias.alias}`, alias])).values()];
    for (let offset = 0; offset < uniqueAliases.length; offset += 500) {
      await tx.insert(schema.modelAliases).values(uniqueAliases.slice(offset, offset + 500).map((alias) => ({
        id: nanoid(),
        canonicalModelId: alias.canonicalModelId,
        source: alias.source,
        alias: alias.alias,
        normalizedLight: normalizeModelLight(alias.alias),
        normalizedAggressive: normalizeModelAggressive(alias.alias),
        isExplicit: false,
        provenance: alias.provenance,
        fetchedAt: alias.provenance ? new Date(alias.provenance.fetchedAt) : syncedAt,
      })));
    }

    await tx.delete(schema.benchmarkMetrics);
    for (let offset = 0; offset < plan.benchmarks.length; offset += 500) {
      await tx.insert(schema.benchmarkMetrics).values(plan.benchmarks.slice(offset, offset + 500).map((benchmark) => ({
        id: nanoid(),
        canonicalModelId: benchmark.canonicalModelId,
        benchmarkId: benchmark.benchmarkId,
        sourceModel: benchmark.sourceModel,
        metrics: benchmark.metrics,
        provenance: benchmark.provenance,
        fetchedAt: new Date(benchmark.provenance.fetchedAt),
      })));
    }
  });

  let reconciliation: { status: "active"; generationId: string } | { status: "failed"; error: string };
  try {
    const result = await scheduleCatalogReconciliation();
    reconciliation = { status: "active", generationId: result.generationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Catalog reconciliation failed";
    console.error("[catalog] Reconciliation failed:", message);
    reconciliation = { status: "failed", error: message };
  }

  return {
    modelCount: plan.models.length,
    providerMappingCount: plan.providerMappings.length,
    benchmarkCount: plan.benchmarks.length,
    collisions: plan.collisions,
    reconciliation,
  };
}

let catalogSyncInFlight: Promise<Awaited<ReturnType<typeof syncCanonicalCatalog>>> | null = null;

export function scheduleCanonicalCatalogSync() {
  if (catalogSyncInFlight) return catalogSyncInFlight;
  catalogSyncInFlight = syncCanonicalCatalog().finally(() => {
    catalogSyncInFlight = null;
  });
  return catalogSyncInFlight;
}
