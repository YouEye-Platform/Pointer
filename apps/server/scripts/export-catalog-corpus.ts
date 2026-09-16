import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { db, schema } from "../src/db";
import { catalogCorpusSchema, type CatalogCorpus, type CatalogIdentityDecision, type CatalogObservation } from "../src/services/catalog-contracts";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel, SourceProvenance } from "../src/services/sources/types";

const generatedAt = new Date().toISOString();
const stableId = (prefix: string, ...parts: string[]) => `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
const creatorId = (value: string) => `org_${value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
const creatorIconKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const iso = (value: Date | null) => value?.toISOString() ?? null;

const [models, aliases, benchmarks, providerModels, providers, sourceRecords, sourceStates] = await Promise.all([
  db.select().from(schema.modelCatalog).orderBy(asc(schema.modelCatalog.modelId)),
  db.select().from(schema.modelAliases).orderBy(asc(schema.modelAliases.source), asc(schema.modelAliases.alias)),
  db.select().from(schema.benchmarkMetrics).orderBy(asc(schema.benchmarkMetrics.benchmarkId), asc(schema.benchmarkMetrics.sourceModel)),
  db.select().from(schema.providerModels).orderBy(asc(schema.providerModels.providerId), asc(schema.providerModels.providerModelId)),
  db.select().from(schema.providers).orderBy(asc(schema.providers.id)),
  db.select().from(schema.sourceRecords).orderBy(asc(schema.sourceRecords.sourceId), asc(schema.sourceRecords.recordKey)),
  db.select().from(schema.sourceSyncStates).orderBy(asc(schema.sourceSyncStates.sourceId)),
]);

const providerNames = new Map(providers.map((row) => [row.id, row.name]));
const benchmarkEntity = new Map(benchmarks.map((row) => [`${row.benchmarkId}\u0000${row.sourceModel}`, row.canonicalModelId]));
const observations: CatalogObservation[] = [];
const decisions: CatalogIdentityDecision[] = [];

for (const row of sourceRecords) {
  if (row.kind === "reference_model") {
    const payload = row.payload as NormalizedReferenceModel;
    const id = stableId("obs", row.sourceId, row.recordKey);
    observations.push({
      id,
      sourceId: row.sourceId,
      sourceRecordKey: row.recordKey,
      kind: "reference_model",
      nativeId: payload.id,
      observedName: payload.displayName,
      organizationHint: payload.creator || null,
      providerId: null,
      attributes: {
        canonicalSlug: payload.canonicalSlug,
        contextWindow: payload.contextWindow,
        maxOutput: payload.maxOutput,
        inputModalities: payload.inputModalities,
        outputModalities: payload.outputModalities,
        supportedParameters: payload.supportedParameters,
      },
      provenance: payload.provenance,
      active: true,
    });
    decisions.push({ observationId: id, entityId: payload.id, state: "linked", method: "native_id", confidence: 1, candidateEntityIds: [], evidence: ["Legacy reference model primary key"], resolverVersion: "legacy-export-v1" });
  } else if (row.kind === "benchmark") {
    const payload = row.payload as NormalizedBenchmarkRecord;
    const id = stableId("obs", row.sourceId, row.recordKey);
    const entityId = benchmarkEntity.get(`${payload.benchmarkId}\u0000${payload.sourceModel}`) ?? null;
    observations.push({
      id,
      sourceId: row.sourceId,
      sourceRecordKey: row.recordKey,
      kind: "benchmark_model",
      nativeId: payload.sourceModel,
      observedName: payload.sourceModel,
      organizationHint: null,
      providerId: null,
      attributes: { benchmarkId: payload.benchmarkId, metrics: payload.metrics },
      provenance: payload.provenance,
      active: true,
    });
    decisions.push({ observationId: id, entityId, state: entityId ? "linked" : "unresolved", method: entityId ? "structured_match" : "none", confidence: entityId ? 0.5 : 0, candidateEntityIds: [], evidence: ["Legacy benchmark mapping"], resolverVersion: "legacy-export-v1" });
  }
}

for (const row of providerModels) {
  const id = stableId("obs", `provider:${row.providerId}`, row.id);
  observations.push({
    id,
    sourceId: `provider:${row.providerId}`,
    sourceRecordKey: row.id,
    kind: "provider_model",
    nativeId: row.providerModelId,
    observedName: null,
    organizationHint: providerNames.get(row.providerId) ?? row.providerId,
    providerId: row.providerId,
    attributes: {
      modelId: row.modelId,
      contextWindow: row.contextWindow,
      maxOutput: row.maxOutput,
      supportsStreaming: row.supportsStreaming,
      supportsTools: row.supportsTools,
      supportsVision: row.supportsVision,
    },
    provenance: null,
    active: true,
  });
  decisions.push({ observationId: id, entityId: row.canonicalModelId, state: row.canonicalModelId ? "linked" : "unresolved", method: row.canonicalModelId ? "structured_match" : "none", confidence: row.canonicalModelId ? 0.5 : 0, candidateEntityIds: [], evidence: ["Legacy provider model mapping"], resolverVersion: "legacy-export-v1" });
}

const creators = [...new Set(models.map((row) => row.creator).filter((value): value is string => Boolean(value)))].sort();
const activeEntityIds = new Set([
  ...providerModels.map((row) => row.canonicalModelId).filter((value): value is string => Boolean(value)),
  ...benchmarks.map((row) => row.canonicalModelId).filter((value): value is string => Boolean(value)),
  ...models.filter((row) => row.metadataSource !== null).map((row) => row.modelId),
]);
const corpus: CatalogCorpus = {
  corpusVersion: "1",
  generatedAt,
  observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
  entities: models.map((row) => ({
    id: row.modelId,
    slug: row.canonicalSlug ?? row.modelId,
    preferredName: row.name,
    organizationId: row.creator ? creatorId(row.creator) : null,
    active: activeEntityIds.has(row.modelId),
  })),
  decisions: decisions.sort((a, b) => a.observationId.localeCompare(b.observationId)),
  organizations: creators.map((creator) => ({ id: creatorId(creator), name: creator, aliases: [creator], websiteUrl: null })),
  assets: [],
  providerRoutes: providerModels.map((row) => ({ id: row.id, providerId: row.providerId, providerModelId: row.providerModelId, entityId: row.canonicalModelId, active: true })),
  benchmarkLinks: benchmarks.map((row) => ({
    id: row.id,
    benchmarkId: row.benchmarkId,
    sourceModel: row.sourceModel,
    entityId: row.canonicalModelId,
    provenance: row.provenance as SourceProvenance,
  })),
  aliases: aliases.map((row) => ({ id: row.id, source: row.source, alias: row.alias, entityId: row.canonicalModelId, explicit: row.isExplicit ?? false })),
  sources: sourceStates.map((row) => ({
    sourceId: row.sourceId,
    health: row.status === "ok" ? "healthy" : row.status === "never_synced" ? "never_synced" : row.lastSuccessAt ? "stale" : row.status === "syncing" ? "degraded" : "unavailable",
    lastAttemptAt: iso(row.lastAttemptAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    recordCount: row.recordCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  })),
  legacyPresentation: models.map((row) => ({
    entityId: row.modelId,
    currentName: row.name,
    currentCreator: row.creator,
    currentCreatorIconKey: row.creatorIconKey ?? (row.creator ? creatorIconKey(row.creator) : null),
    currentLogoUrl: row.logoUrl,
    iconOutcome: row.logoUrl ? "logo_url" : row.creatorIconKey || row.creator ? "icon_key" : "fallback",
  })),
};

process.stdout.write(`${JSON.stringify(catalogCorpusSchema.parse(corpus), null, 2)}\n`);
await db.$client.end();
