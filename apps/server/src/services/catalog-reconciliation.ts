import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import {
  CATALOG_RESOLVER_VERSION,
  buildCatalogGenerationPlan,
  benchmarkObservationPayloadSchema,
  catalogGenerationContentHash,
  catalogInventoryHash,
  catalogSnapshotRevision,
  deriveCreatorAliases,
  planCatalogGarbageCollection,
  providerObservationPayloadSchema,
  referenceObservationPayloadSchema,
  type CatalogGenerationPlan,
  type ReconciliationObservation,
  type ReconciliationSnapshot,
} from "./catalog-reconciliation-core";
import type { ProviderModelInput } from "./catalog-planner";
import { sourceTtlMs } from "./sources/config";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel, SourceSnapshot } from "./sources/types";

type CatalogTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SourceRecord = NormalizedReferenceModel | NormalizedBenchmarkRecord;

const CATALOG_ADVISORY_LOCK = 1_347_373_902;
const batchSize = 250;

export type CatalogFailurePoint = "after_plan" | "after_staging" | "before_activation" | "after_activation";
export type CatalogReconciliationOptions = {
  failAt?: CatalogFailurePoint;
  pauseAt?: CatalogFailurePoint;
  onPause?: (point: CatalogFailurePoint) => void | Promise<void>;
  onCheckpoint?: (point: CatalogFailurePoint) => void | Promise<void>;
};

export class CatalogReconciliationError extends Error {
  constructor(message: string, readonly code: "locked" | "invalid" | "missing" | "failed") {
    super(message);
    this.name = "CatalogReconciliationError";
  }
}

export async function acquireCatalogWriteLock(tx: CatalogTransaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(${CATALOG_ADVISORY_LOCK})`);
}

const sourceRecordIdentity = (record: SourceRecord) => "id" in record
  ? { kind: "reference_model" as const, nativeId: record.id, rawName: record.displayName, organizationHint: record.creator }
  : {
    kind: "benchmark_model" as const,
    nativeId: record.sourceModel,
    rawName: record.sourceModel,
    organizationHint: record.creator ?? null,
  };

export async function stageSourceInventorySnapshot(
  tx: CatalogTransaction,
  snapshot: SourceSnapshot<SourceRecord>,
  completedAt: Date,
  options: { onStaged?: () => void | Promise<void> } = {}
) {
  if (snapshot.records.length === 0) throw new CatalogReconciliationError(`Source ${snapshot.sourceId} returned an empty snapshot`, "invalid");
  await acquireCatalogWriteLock(tx);
  for (const record of snapshot.records) {
    if ("benchmarkId" in record) benchmarkObservationPayloadSchema.parse(record);
    else referenceObservationPayloadSchema.parse(record);
  }
  const identities = snapshot.records.map(sourceRecordIdentity);
  const uniqueNativeIds = new Set(identities.map((identity) => identity.nativeId));
  if (uniqueNativeIds.size !== identities.length) throw new CatalogReconciliationError(`Source ${snapshot.sourceId} returned duplicate native IDs`, "invalid");

  const snapshotId = `csn_${nanoid(20)}`;
  const fetchedAt = new Date(snapshot.provenance.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) throw new CatalogReconciliationError(`Source ${snapshot.sourceId} returned an invalid fetched time`, "invalid");
  const contentHash = catalogInventoryHash(snapshot.records);
  const [existingSnapshot] = await tx.select({ id: schema.sourceSnapshots.id })
    .from(schema.sourceSnapshots)
    .where(and(
      eq(schema.sourceSnapshots.sourceId, snapshot.sourceId),
      eq(schema.sourceSnapshots.contentHash, contentHash),
      eq(schema.sourceSnapshots.sourceUrl, snapshot.provenance.sourceUrl),
      eq(schema.sourceSnapshots.license, snapshot.provenance.license),
    ))
    .orderBy(desc(schema.sourceSnapshots.createdAt))
    .limit(1);
  if (existingSnapshot) {
    await tx.update(schema.sourceSnapshots).set({ fetchedAt: fetchedAt, state: "validated" })
      .where(eq(schema.sourceSnapshots.id, existingSnapshot.id));
    return { snapshotId: existingSnapshot.id, contentHash, recordCount: snapshot.records.length, reused: true as const };
  }
  await tx.insert(schema.sourceSnapshots).values({
    id: snapshotId,
    sourceId: snapshot.sourceId,
    revision: catalogSnapshotRevision(completedAt, snapshot.records),
    sourceUrl: snapshot.provenance.sourceUrl,
    license: snapshot.provenance.license,
    fetchedAt,
    recordCount: snapshot.records.length,
    contentHash,
    state: "validated",
    active: false,
  });
  for (let offset = 0; offset < snapshot.records.length; offset += batchSize) {
    await tx.insert(schema.modelObservations).values(snapshot.records.slice(offset, offset + batchSize).map((record, index) => {
      const identity = sourceRecordIdentity(record);
      return {
        id: `cob_${nanoid(20)}`,
        snapshotId,
        sourceId: snapshot.sourceId,
        kind: identity.kind,
        nativeId: identity.nativeId,
        rawName: identity.rawName,
        namespace: identity.organizationHint,
        attributes: {},
        rawPayload: record,
        provenance: snapshot.provenance,
        fetchedAt,
        active: false,
        createdAt: new Date(completedAt.getTime() + offset + index),
      };
    }));
  }
  await options.onStaged?.();
  return { snapshotId, contentHash, recordCount: snapshot.records.length };
}

export async function stageProviderInventorySnapshot(input: {
  providerId: string;
  providerName: string;
  sourceUrl: string;
  records: ProviderModelInput[];
  completedAt?: Date;
}) {
  if (input.records.length === 0) throw new CatalogReconciliationError(`Provider ${input.providerId} returned an empty inventory`, "invalid");
  for (const record of input.records) providerObservationPayloadSchema.parse(record);
  const completedAt = input.completedAt ?? new Date();
  const rawIds = input.records.map((record) => record.rawModelId);
  if (new Set(rawIds).size !== rawIds.length) throw new CatalogReconciliationError(`Provider ${input.providerId} returned duplicate raw model IDs`, "invalid");
  const sourceId = `provider:${input.providerId}`;
  return db.transaction(async (tx) => {
    await acquireCatalogWriteLock(tx);
    await tx.insert(schema.sourceSyncStates).values({
      sourceId,
      status: "ok",
      lastAttemptAt: completedAt,
      lastSuccessAt: completedAt,
      fetchedAt: completedAt,
      recordCount: input.records.length,
      updatedAt: completedAt,
    }).onConflictDoUpdate({
      target: schema.sourceSyncStates.sourceId,
      set: { status: "ok", lastAttemptAt: completedAt, lastSuccessAt: completedAt, fetchedAt: completedAt, recordCount: input.records.length, errorCode: null, errorMessage: null, updatedAt: completedAt },
    });
    const snapshotId = `csn_${nanoid(20)}`;
    const contentHash = catalogInventoryHash(input.records);
    const [existingSnapshot] = await tx.select({ id: schema.sourceSnapshots.id })
      .from(schema.sourceSnapshots)
      .where(and(
        eq(schema.sourceSnapshots.sourceId, sourceId),
        eq(schema.sourceSnapshots.contentHash, contentHash),
        eq(schema.sourceSnapshots.sourceUrl, input.sourceUrl),
        eq(schema.sourceSnapshots.license, "provider-inventory"),
      ))
      .orderBy(desc(schema.sourceSnapshots.createdAt))
      .limit(1);
    if (existingSnapshot) {
      await tx.update(schema.sourceSnapshots).set({ fetchedAt: completedAt, state: "validated" })
        .where(eq(schema.sourceSnapshots.id, existingSnapshot.id));
      return { snapshotId: existingSnapshot.id, contentHash, recordCount: input.records.length, reused: true as const };
    }
    await tx.insert(schema.sourceSnapshots).values({
      id: snapshotId,
      sourceId,
      revision: catalogSnapshotRevision(completedAt, input.records),
      sourceUrl: input.sourceUrl,
      license: "provider-inventory",
      fetchedAt: completedAt,
      recordCount: input.records.length,
      contentHash,
      state: "validated",
      active: false,
    });
    for (let offset = 0; offset < input.records.length; offset += batchSize) {
      await tx.insert(schema.modelObservations).values(input.records.slice(offset, offset + batchSize).map((record) => ({
        id: `cob_${nanoid(20)}`,
        snapshotId,
        sourceId,
        kind: "provider_model",
        nativeId: record.rawModelId,
        rawName: record.displayName || record.rawModelId,
        namespace: record.rawModelId.includes("/") ? record.rawModelId.slice(0, record.rawModelId.indexOf("/")) : null,
        attributes: { providerId: record.providerId },
        rawPayload: record,
        provenance: { source: sourceId, sourceUrl: input.sourceUrl, license: "provider-inventory", fetchedAt: completedAt.toISOString() },
        fetchedAt: completedAt,
        active: false,
      })));
    }
    return { snapshotId, contentHash, recordCount: input.records.length };
  });
}

const latestSnapshots = (
  rows: Array<typeof schema.sourceSnapshots.$inferSelect>,
  sourceStates: Map<string, typeof schema.sourceSyncStates.$inferSelect>,
  now = new Date()
): ReconciliationSnapshot[] => {
  const bySource = new Map<string, typeof schema.sourceSnapshots.$inferSelect>();
  for (const row of rows) {
    if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, row);
  }
  const ttlMs = sourceTtlMs();
  return [...bySource.values()].map((row) => {
    const state = sourceStates.get(row.sourceId);
    const status = state?.status ?? "never_synced";
    const stale = now.getTime() - row.fetchedAt.getTime() > ttlMs;
    return {
      id: row.id,
      sourceId: row.sourceId,
      fetchedAt: row.fetchedAt,
      sourceState: {
        health: status === "ok" ? (stale ? "stale" : "healthy") : status === "never_synced" ? "never_synced" : "degraded",
        lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
        recordCount: state?.recordCount ?? row.recordCount,
        errorCode: state?.errorCode ?? null,
        errorMessage: state?.errorMessage ?? null,
      },
    };
  });
};

type CatalogIdentityReviewRow = {
  observationId: string;
  entityId: string;
  reviewState: string;
  reviewedAt: Date | null;
  updatedAt: Date;
  sourceId: string;
  nativeId: string;
};

const reviewIdentityKey = (sourceId: string, nativeId: string) => `${sourceId}\u0000${nativeId}`;

const effectiveIdentityReviews = (reviewRows: CatalogIdentityReviewRow[]) => {
  const reviewsByIdentity = new Map<string, CatalogIdentityReviewRow[]>();
  for (const row of reviewRows) {
    const key = reviewIdentityKey(row.sourceId, row.nativeId);
    const rows = reviewsByIdentity.get(key) ?? [];
    rows.push(row);
    reviewsByIdentity.set(key, rows);
  }
  return new Map([...reviewsByIdentity.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort((left, right) => {
      const leftTime = (left.reviewedAt ?? left.updatedAt).getTime();
      const rightTime = (right.reviewedAt ?? right.updatedAt).getTime();
      return rightTime - leftTime || left.observationId.localeCompare(right.observationId);
    });
    const latestByEntity = new Map<string, CatalogIdentityReviewRow>();
    for (const review of sorted) if (!latestByEntity.has(review.entityId)) latestByEntity.set(review.entityId, review);
    const effective = [...latestByEntity.values()];
    return [key, {
      approvedEntityId: effective.find((review) => review.reviewState === "approved")?.entityId ?? null,
      rejectedEntityIds: effective.filter((review) => review.reviewState === "rejected").map((review) => review.entityId).sort(),
    }];
  }));
};

const lockCatalogReviewRows = async (tx: CatalogTransaction) => {
  await tx.select({ id: schema.observationEntityLinks.id }).from(schema.observationEntityLinks).for("update");
};

async function loadReconciliationInput(tx: CatalogTransaction, allowEmptyCatalog = false) {
  const eligibleRows = await tx.select().from(schema.sourceSnapshots)
    .where(inArray(schema.sourceSnapshots.state, ["validated", "active"]))
    .orderBy(desc(schema.sourceSnapshots.fetchedAt), desc(schema.sourceSnapshots.createdAt));
  const sourceStateRows = await tx.select().from(schema.sourceSyncStates);
  const disabledSourceIds = new Set(sourceStateRows.filter((state) => state.status === "disabled").map((state) => state.sourceId));
  const providerIds = new Set((await tx.select({ id: schema.providers.id }).from(schema.providers)).map((provider) => provider.id));
  const eligible = eligibleRows.filter((snapshot) =>
    !disabledSourceIds.has(snapshot.sourceId)
    && (!snapshot.sourceId.startsWith("provider:") || providerIds.has(snapshot.sourceId.slice("provider:".length))));
  const snapshots = latestSnapshots(eligible, new Map(sourceStateRows.map((state) => [state.sourceId, state])));
  if (snapshots.length === 0 && !allowEmptyCatalog) throw new CatalogReconciliationError("No validated catalog snapshots are available", "missing");
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const [activeGeneration] = await tx.select().from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active")).limit(1);
  const [observationRows, entityRows, activeAssets, claims, organizationRows, organizationAliasRows, identityRows, reviewRows, compatibilityAliasRows] = await Promise.all([
    tx.select().from(schema.modelObservations).where(inArray(schema.modelObservations.snapshotId, snapshotIds)),
    tx.select({ id: schema.modelEntities.id, stableSlug: schema.modelEntities.stableSlug, preferredName: schema.modelEntities.preferredName, organizationId: schema.modelEntities.organizationId }).from(schema.modelEntities),
    tx.select().from(schema.catalogAssets).where(and(eq(schema.catalogAssets.active, true), eq(schema.catalogAssets.validationState, "valid"))),
    tx.select().from(schema.identityClaims).where(eq(schema.identityClaims.state, "approved")),
    tx.select().from(schema.organizations),
    tx.select().from(schema.organizationAliases),
    activeGeneration ? tx.select({
      entityId: schema.catalogGenerationObservationLinks.entityId,
      kind: schema.modelObservations.kind,
      sourceId: schema.modelObservations.sourceId,
      nativeId: schema.modelObservations.nativeId,
      rawName: schema.modelObservations.rawName,
      namespace: schema.modelObservations.namespace,
    }).from(schema.catalogGenerationObservationLinks)
      .innerJoin(schema.modelObservations, eq(schema.modelObservations.id, schema.catalogGenerationObservationLinks.observationId))
      .where(eq(schema.catalogGenerationObservationLinks.generationId, activeGeneration.id))
      .orderBy(
        sql`case ${schema.modelObservations.kind} when 'reference_model' then 0 when 'provider_model' then 1 else 2 end`,
        schema.modelObservations.sourceId,
        schema.modelObservations.nativeId,
        schema.modelObservations.id
      ) : Promise.resolve([]),
    tx.select({
      observationId: schema.observationEntityLinks.observationId,
      entityId: schema.observationEntityLinks.entityId,
      reviewState: schema.observationEntityLinks.reviewState,
      reviewedAt: schema.observationEntityLinks.reviewedAt,
      updatedAt: schema.observationEntityLinks.updatedAt,
      sourceId: schema.modelObservations.sourceId,
      nativeId: schema.modelObservations.nativeId,
    }).from(schema.observationEntityLinks)
      .innerJoin(schema.modelObservations, eq(schema.modelObservations.id, schema.observationEntityLinks.observationId))
      .where(ne(schema.observationEntityLinks.reviewState, "unreviewed")),
    tx.select({
      alias: schema.catalogGenerationAliases.alias,
      entityId: schema.catalogGenerationAliases.entityId,
    }).from(schema.catalogGenerationAliases)
      .where(eq(schema.catalogGenerationAliases.sourceId, "pointer:entity-redirect")),
  ]);
  const identityByEntity = new Map<string, (typeof identityRows)[number]>();
  for (const identity of identityRows) if (!identityByEntity.has(identity.entityId)) identityByEntity.set(identity.entityId, identity);
  const existingEntities = entityRows.map((entity) => {
    const identity = identityByEntity.get(entity.id);
    return {
      ...entity,
      identityNativeId: identity?.nativeId,
      identityObservedName: identity?.rawName,
      identityOrganizationHint: identity?.namespace,
    };
  });
  const existingOrganizations = organizationRows.map((organization) => ({
    id: organization.id,
    canonicalName: organization.canonicalName,
    websiteUrl: organization.websiteUrl,
    aliases: organizationAliasRows.filter((alias) => alias.organizationId === organization.id).map((alias) => alias.alias).sort(),
  }));
  const observations: ReconciliationObservation[] = observationRows.map((row) => ({
    id: row.id,
    snapshotId: row.snapshotId,
    sourceId: row.sourceId,
    kind: row.kind as ReconciliationObservation["kind"],
    nativeId: row.nativeId,
    rawName: row.rawName,
    organizationHint: row.namespace,
    payload: row.rawPayload,
  }));
  const reviewedOverrides: Record<string, string> = {};
  const rejectedEntityIds: Record<string, string[]> = {};
  const reviewsByIdentity = effectiveIdentityReviews(reviewRows);
  for (const observation of observations) {
    const review = reviewsByIdentity.get(reviewIdentityKey(observation.sourceId, observation.nativeId));
    if (review?.approvedEntityId) reviewedOverrides[observation.id] = review.approvedEntityId;
    if (review?.rejectedEntityIds.length) rejectedEntityIds[observation.id] = review.rejectedEntityIds;
  }
  const creatorAliases = deriveCreatorAliases(existingOrganizations);
  const previousLinks: Record<string, string> = {};
  const previousByIdentity = new Map(identityRows.map((row) => [reviewIdentityKey(row.sourceId, row.nativeId), row.entityId]));
  for (const observation of observations) {
    const entityId = previousByIdentity.get(reviewIdentityKey(observation.sourceId, observation.nativeId));
    if (entityId) previousLinks[observation.id] = entityId;
  }
  const authoritativeCrosswalk: Record<string, string> = {};
  const approvedAliases: Record<string, string> = {};
  const reviewedNames: Record<string, string> = {};
  for (const claim of claims) {
    if (claim.claimType === "crosswalk") authoritativeCrosswalk[claim.value] = claim.entityId;
    if (claim.claimType === "alias") approvedAliases[claim.normalizedValue] = claim.entityId;
  }
  for (const claim of [...claims]
    .filter((item) => item.claimType === "name")
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id))) {
    if (!reviewedNames[claim.entityId]) reviewedNames[claim.entityId] = claim.value;
  }
  return {
    snapshots,
    observations,
    existingEntities,
    existingOrganizations,
    activeAssets,
    previousLinks,
    previousCompatibilityAliases: compatibilityAliasRows,
    reviewedOverrides,
    rejectedEntityIds,
    authoritativeCrosswalk,
    approvedAliases,
    creatorAliases,
    reviewedNames,
    activeGeneration,
  };
}

const observationSnapshotMap = (observations: ReconciliationObservation[]) => new Map(observations.map((item) => [item.id, item.snapshotId]));

const catalogSetDelta = (previous: Iterable<string>, next: Iterable<string>) => {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: [...nextSet].filter((value) => !previousSet.has(value)).length,
    removed: [...previousSet].filter((value) => !nextSet.has(value)).length,
  };
};

async function persistGeneration(tx: CatalogTransaction, generationId: string, plan: CatalogGenerationPlan, observations: ReconciliationObservation[]) {
  const snapshotByObservation = observationSnapshotMap(observations);
  const resolverRunId = `crn_${nanoid(20)}`;
  await tx.insert(schema.resolverRuns).values({
    id: resolverRunId,
    generationId,
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status: "completed",
    completedAt: new Date(),
    stats: {
      observationCount: plan.decisions.length,
      linkedCount: plan.decisions.filter((item) => item.state === "linked").length,
      ambiguousCount: plan.decisions.filter((item) => item.state === "ambiguous").length,
      unresolvedCount: plan.decisions.filter((item) => item.state === "unresolved").length,
    },
  });
  for (let offset = 0; offset < plan.organizations.length; offset += batchSize) {
    for (const organization of plan.organizations.slice(offset, offset + batchSize)) {
      await tx.insert(schema.organizations).values({ id: organization.id, canonicalName: organization.canonicalName, active: false })
        .onConflictDoUpdate({ target: schema.organizations.id, set: { canonicalName: organization.canonicalName } });
    }
  }
  if (plan.organizations.length > 0) {
    await tx.insert(schema.catalogGenerationOrganizations).values(plan.organizations.map((organization) => ({
      id: `cgo_${nanoid(20)}`,
      generationId,
      organizationId: organization.id,
      canonicalName: organization.canonicalName,
      websiteUrl: organization.websiteUrl,
      aliases: organization.aliases,
    })));
  }
  for (const entity of plan.entities) {
    await tx.insert(schema.modelEntities).values({
      id: entity.id,
      stableSlug: entity.stableSlug,
      preferredName: entity.preferredName,
      organizationId: entity.organizationId,
      active: false,
    }).onConflictDoUpdate({
      target: schema.modelEntities.id,
      set: { preferredName: entity.preferredName, organizationId: entity.organizationId, updatedAt: new Date() },
    });
  }
  for (let offset = 0; offset < plan.snapshots.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationSnapshots).values(plan.snapshots.slice(offset, offset + batchSize).map((snapshot) => ({
      id: `cgs_${nanoid(20)}`,
      generationId,
      snapshotId: snapshot.id,
      sourceId: snapshot.sourceId,
      sourceState: snapshot.sourceState,
    })));
  }
  for (let offset = 0; offset < plan.entities.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationEntities).values(plan.entities.slice(offset, offset + batchSize).map((entity) => ({
      id: `cge_${nanoid(20)}`,
      generationId,
      entityId: entity.id,
      preferredName: entity.preferredName,
      stableSlug: entity.stableSlug,
      organizationId: entity.organizationId,
      nameProvenance: entity.nameProvenance,
      description: entity.description,
      contextWindow: entity.contextWindow,
      maxOutput: entity.maxOutput,
      supportsTools: entity.supportsTools,
      supportsVision: entity.supportsVision,
      supportsStreaming: entity.supportsStreaming,
      referenceInputPrice: entity.referenceInputPrice === null ? null : String(entity.referenceInputPrice),
      referenceOutputPrice: entity.referenceOutputPrice === null ? null : String(entity.referenceOutputPrice),
      metadataSource: entity.metadataSource,
      metadataFetchedAt: entity.metadataFetchedAt ? new Date(entity.metadataFetchedAt) : null,
      releasedAt: entity.releasedAt ? new Date(entity.releasedAt) : null,
      rawMetadata: entity.rawMetadata,
    })));
  }
  for (let offset = 0; offset < plan.nameClaims.length; offset += batchSize) {
    for (const claim of plan.nameClaims.slice(offset, offset + batchSize)) {
      await tx.insert(schema.identityClaims).values({
        id: `icl_${nanoid(20)}`,
        entityId: claim.entityId,
        sourceId: claim.sourceId,
        claimType: "name",
        value: claim.value,
        normalizedValue: claim.normalizedValue,
        provenance: { observationId: claim.observationId, selected: claim.selected, ...claim.provenance },
        state: "proposed",
      }).onConflictDoNothing();
    }
  }
  for (let offset = 0; offset < plan.links.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationObservationLinks).values(plan.links.slice(offset, offset + batchSize).map((link) => ({
      id: `cgl_${nanoid(20)}`,
      generationId,
      snapshotId: link.snapshotId,
      observationId: link.observationId,
      entityId: link.entityId,
      method: link.method,
      confidence: String(link.confidence),
      evidence: link.evidence,
    })));
  }
  for (let offset = 0; offset < plan.decisions.length; offset += batchSize) {
    const decisions = plan.decisions.slice(offset, offset + batchSize);
    await tx.insert(schema.catalogGenerationDecisions).values(decisions.map((item) => ({
      id: `cgd_${nanoid(20)}`,
      generationId,
      snapshotId: snapshotByObservation.get(item.observationId)!,
      observationId: item.observationId,
      entityId: item.entityId,
      state: item.state,
      method: item.method,
      confidence: String(item.confidence),
      score: String(item.score),
      margin: String(item.margin),
      candidateEntityIds: item.candidateEntityIds,
      evidence: item.evidence,
      blockers: item.blockers,
      resolverVersion: item.resolverVersion,
    })));
    await tx.insert(schema.resolverDecisions).values(decisions.map((item) => ({
      id: `crd_${nanoid(20)}`,
      resolverRunId,
      observationId: item.observationId,
      entityId: item.entityId,
      state: item.state,
      method: item.method,
      confidence: String(item.confidence),
      candidateEntityIds: item.candidateEntityIds,
      evidence: item.evidence,
      blockers: item.blockers,
    })));
  }
  for (let offset = 0; offset < plan.aliases.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationAliases).values(plan.aliases.slice(offset, offset + batchSize).map((alias) => ({
      id: `cga_${nanoid(20)}`,
      generationId,
      sourceId: alias.sourceId,
      alias: alias.alias,
      observationId: alias.observationId,
      entityId: alias.entityId,
    })));
  }
  for (let offset = 0; offset < plan.routes.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationProviderRoutes).values(plan.routes.slice(offset, offset + batchSize).map((route) => ({
      id: `cgr_${nanoid(20)}`,
      generationId,
      providerModelId: route.providerModelId,
      providerId: route.providerId,
      rawModelId: route.rawModelId,
      snapshotId: route.snapshotId,
      observationId: route.observationId,
      entityId: route.entityId,
      inputPrice: route.inputPrice,
      outputPrice: route.outputPrice,
      contextWindow: route.contextWindow,
      maxOutput: route.maxOutput,
      supportsTools: route.supportsTools,
      supportsVision: route.supportsVision,
      supportsStreaming: route.supportsStreaming,
    })));
  }
  for (let offset = 0; offset < plan.benchmarks.length; offset += batchSize) {
    await tx.insert(schema.catalogGenerationBenchmarkLinks).values(plan.benchmarks.slice(offset, offset + batchSize).map((benchmark) => ({
      id: `cgb_${nanoid(20)}`,
      generationId,
      benchmarkId: benchmark.benchmarkId,
      sourceModel: benchmark.sourceModel,
      snapshotId: benchmark.snapshotId,
      observationId: benchmark.observationId,
      entityId: benchmark.entityId,
      metrics: benchmark.metrics,
      provenance: benchmark.provenance,
      fetchedAt: new Date(benchmark.fetchedAt),
    })));
  }
  if (plan.assets.length > 0) {
    await tx.insert(schema.catalogGenerationAssets).values(plan.assets.map((asset) => ({
      id: `cgt_${nanoid(20)}`,
      generationId,
      assetId: asset.id,
      organizationId: asset.organizationId,
      kind: asset.kind,
      originUrl: asset.originUrl,
      license: asset.license,
      contentHash: asset.contentHash,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      width: asset.width,
      height: asset.height,
      validationState: asset.validationState,
      cachePath: asset.cachePath,
      fetchedAt: asset.fetchedAt,
    })));
  }
}

async function activateGenerationInTransaction(tx: CatalogTransaction, generationId: string, reason: "reconcile" | "rollback") {
  await lockCatalogReviewRows(tx);
  const [[generation], snapshots, organizations, entities, links, routes, benchmarks, assets, [previous], decisions, reviewRows] = await Promise.all([
    tx.select().from(schema.catalogGenerations).where(eq(schema.catalogGenerations.id, generationId)).limit(1),
    tx.select().from(schema.catalogGenerationSnapshots).where(eq(schema.catalogGenerationSnapshots.generationId, generationId)),
    tx.select().from(schema.catalogGenerationOrganizations).where(eq(schema.catalogGenerationOrganizations.generationId, generationId)),
    tx.select().from(schema.catalogGenerationEntities).where(eq(schema.catalogGenerationEntities.generationId, generationId)),
    tx.select().from(schema.catalogGenerationObservationLinks).where(eq(schema.catalogGenerationObservationLinks.generationId, generationId)),
    tx.select().from(schema.catalogGenerationProviderRoutes).where(eq(schema.catalogGenerationProviderRoutes.generationId, generationId)),
    tx.select().from(schema.catalogGenerationBenchmarkLinks).where(eq(schema.catalogGenerationBenchmarkLinks.generationId, generationId)),
    tx.select().from(schema.catalogGenerationAssets).where(eq(schema.catalogGenerationAssets.generationId, generationId)),
    tx.select().from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active")).limit(1),
    tx.select({
      state: schema.catalogGenerationDecisions.state,
      entityId: schema.catalogGenerationDecisions.entityId,
      sourceId: schema.modelObservations.sourceId,
      nativeId: schema.modelObservations.nativeId,
    }).from(schema.catalogGenerationDecisions)
      .innerJoin(schema.modelObservations, eq(schema.modelObservations.id, schema.catalogGenerationDecisions.observationId))
      .where(eq(schema.catalogGenerationDecisions.generationId, generationId)),
    tx.select({
      observationId: schema.observationEntityLinks.observationId,
      entityId: schema.observationEntityLinks.entityId,
      reviewState: schema.observationEntityLinks.reviewState,
      reviewedAt: schema.observationEntityLinks.reviewedAt,
      updatedAt: schema.observationEntityLinks.updatedAt,
      sourceId: schema.modelObservations.sourceId,
      nativeId: schema.modelObservations.nativeId,
    }).from(schema.observationEntityLinks)
      .innerJoin(schema.modelObservations, eq(schema.modelObservations.id, schema.observationEntityLinks.observationId))
      .where(ne(schema.observationEntityLinks.reviewState, "unreviewed")),
  ]);
  if (!generation) throw new CatalogReconciliationError(`Catalog generation ${generationId} does not exist`, "missing");
  if (!["ready", "retired", "active"].includes(generation.state)) throw new CatalogReconciliationError(`Catalog generation ${generationId} cannot be activated from ${generation.state}`, "invalid");
  const explicitEmptyCatalog = (generation.stats as Record<string, unknown>).emptyCatalog === true;
  const emptyProjection = [snapshots, organizations, entities, links, routes, benchmarks, assets].every((rows) => rows.length === 0);
  if (explicitEmptyCatalog ? !emptyProjection : snapshots.length === 0 || entities.length === 0 || links.length === 0) {
    throw new CatalogReconciliationError(`Catalog generation ${generationId} is incomplete`, "invalid");
  }
  const reviewsByIdentity = effectiveIdentityReviews(reviewRows);
  for (const item of decisions) {
    const review = reviewsByIdentity.get(reviewIdentityKey(item.sourceId, item.nativeId));
    if (!review) continue;
    if (review.approvedEntityId && (item.state !== "linked" || item.entityId !== review.approvedEntityId)) {
      throw new CatalogReconciliationError(`Catalog generation ${generationId} conflicts with an approved identity review`, "invalid");
    }
    if (item.state === "linked" && item.entityId && review.rejectedEntityIds.includes(item.entityId)) {
      throw new CatalogReconciliationError(`Catalog generation ${generationId} conflicts with a rejected identity review`, "invalid");
    }
  }
  const activatedAt = new Date();
  if (previous && previous.id !== generationId) {
    await tx.update(schema.catalogGenerations).set({ state: "retired" }).where(eq(schema.catalogGenerations.id, previous.id));
  }
  await tx.update(schema.catalogGenerations).set({
    state: "active",
    activatedAt,
    completedAt: generation.completedAt ?? activatedAt,
    stats: {
      ...(generation.stats as Record<string, unknown>),
      activationReason: reason,
      previousGenerationId: previous?.id ?? null,
      activatedAt: activatedAt.toISOString(),
    },
  }).where(eq(schema.catalogGenerations.id, generationId));

  await tx.update(schema.sourceSnapshots).set({ active: false, state: sql`case when ${schema.sourceSnapshots.active} then 'retired' else ${schema.sourceSnapshots.state} end` });
  await tx.update(schema.sourceSnapshots).set({ active: true, state: "active" }).where(inArray(schema.sourceSnapshots.id, snapshots.map((row) => row.snapshotId)));
  await tx.update(schema.modelObservations).set({ active: false });
  await tx.update(schema.modelObservations).set({ active: true }).where(inArray(schema.modelObservations.snapshotId, snapshots.map((row) => row.snapshotId)));
  await tx.update(schema.modelEntities).set({ active: false });
  await tx.update(schema.modelEntities).set({ active: true }).where(inArray(schema.modelEntities.id, entities.map((row) => row.entityId)));
  await tx.update(schema.organizations).set({ active: false });
  const organizationIds = organizations.map((row) => row.organizationId);
  if (organizationIds.length > 0) await tx.update(schema.organizations).set({ active: true }).where(inArray(schema.organizations.id, organizationIds));
  await tx.update(schema.catalogAssets).set({ active: false });
  if (assets.length > 0) await tx.update(schema.catalogAssets).set({ active: true }).where(inArray(schema.catalogAssets.id, assets.map((row) => row.assetId)));

  await tx.update(schema.providerModels).set({ catalogObservationId: null, catalogEntityId: null });
  for (const route of routes) {
    await tx.update(schema.providerModels).set({ catalogObservationId: route.observationId, catalogEntityId: route.entityId })
      .where(eq(schema.providerModels.id, route.providerModelId));
  }
  await tx.update(schema.benchmarkMetrics).set({ catalogObservationId: null, catalogEntityId: null });
  for (const benchmark of benchmarks) {
    await tx.update(schema.benchmarkMetrics).set({ catalogObservationId: benchmark.observationId, catalogEntityId: benchmark.entityId })
      .where(and(eq(schema.benchmarkMetrics.benchmarkId, benchmark.benchmarkId), eq(schema.benchmarkMetrics.sourceModel, benchmark.sourceModel)));
  }
  for (const link of links) {
    await tx.insert(schema.observationEntityLinks).values({
      id: `cel_${nanoid(20)}`,
      observationId: link.observationId,
      entityId: link.entityId,
      method: link.method,
      confidence: link.confidence,
      evidence: link.evidence,
      resolverVersion: CATALOG_RESOLVER_VERSION,
    }).onConflictDoUpdate({
      target: schema.observationEntityLinks.observationId,
      set: { entityId: link.entityId, method: link.method, confidence: link.confidence, evidence: link.evidence, resolverVersion: CATALOG_RESOLVER_VERSION, updatedAt: activatedAt },
      setWhere: eq(schema.observationEntityLinks.reviewState, "unreviewed"),
    });
  }
  return { generationId, previousGenerationId: previous?.id ?? null, snapshotCount: snapshots.length, entityCount: entities.length, routeCount: routes.length, benchmarkCount: benchmarks.length };
}

const catalogCheckpoint = async (options: CatalogReconciliationOptions, point: CatalogFailurePoint) => {
  if (options.failAt === point) throw new Error(`catalog reconciliation failpoint: ${point}`);
  await options.onCheckpoint?.(point);
  if (options.pauseAt === point) {
    await options.onPause?.(point);
    await new Promise<void>(() => {});
  }
};

type CatalogReconciliationAttempt = {
  generationId: string;
  startedAt: Date;
  parentGenerationId: string | null;
};

const newCatalogReconciliationAttempt = (): CatalogReconciliationAttempt => ({
  generationId: `cgn_${nanoid(20)}`,
  startedAt: new Date(),
  parentGenerationId: null,
});

const recordCatalogReconciliationFailure = async (attempt: CatalogReconciliationAttempt, error: unknown) => {
    const failedAt = new Date();
    const message = error instanceof Error ? error.message.slice(0, 500) : "Catalog reconciliation failed";
    await db.transaction(async (tx) => {
      await tx.insert(schema.catalogGenerations).values({
        id: attempt.generationId,
        parentGenerationId: attempt.parentGenerationId,
        state: "failed",
        resolverVersion: CATALOG_RESOLVER_VERSION,
        startedAt: attempt.startedAt,
        completedAt: failedAt,
        stats: { durationMs: failedAt.getTime() - attempt.startedAt.getTime(), failure: true },
        error: message,
      }).onConflictDoNothing();
      await tx.insert(schema.resolverRuns).values({
        id: `crn_${nanoid(20)}`,
        generationId: attempt.generationId,
        resolverVersion: CATALOG_RESOLVER_VERSION,
        status: "failed",
        startedAt: attempt.startedAt,
        completedAt: failedAt,
        stats: { durationMs: failedAt.getTime() - attempt.startedAt.getTime() },
        error: message,
      });
    });
};

const reconcileCatalogInTransaction = async (
  tx: CatalogTransaction,
  attempt: CatalogReconciliationAttempt,
  options: CatalogReconciliationOptions,
  allowEmptyCatalog = false
) => {
  await acquireCatalogWriteLock(tx);
  await lockCatalogReviewRows(tx);
  const input = await loadReconciliationInput(tx, allowEmptyCatalog);
  attempt.parentGenerationId = input.activeGeneration?.id ?? null;
  const plan = buildCatalogGenerationPlan(input, { allowEmptyCatalog });
  const [previousEntities, previousRoutes, previousBenchmarks] = input.activeGeneration
    ? await Promise.all([
      tx.select({ entityId: schema.catalogGenerationEntities.entityId }).from(schema.catalogGenerationEntities).where(eq(schema.catalogGenerationEntities.generationId, input.activeGeneration.id)),
      tx.select({ providerId: schema.catalogGenerationProviderRoutes.providerId, rawModelId: schema.catalogGenerationProviderRoutes.rawModelId, entityId: schema.catalogGenerationProviderRoutes.entityId }).from(schema.catalogGenerationProviderRoutes).where(eq(schema.catalogGenerationProviderRoutes.generationId, input.activeGeneration.id)),
      tx.select({ benchmarkId: schema.catalogGenerationBenchmarkLinks.benchmarkId, sourceModel: schema.catalogGenerationBenchmarkLinks.sourceModel, entityId: schema.catalogGenerationBenchmarkLinks.entityId }).from(schema.catalogGenerationBenchmarkLinks).where(eq(schema.catalogGenerationBenchmarkLinks.generationId, input.activeGeneration.id)),
    ])
    : [[], [], []];
  const entityDelta = catalogSetDelta(previousEntities.map((item) => item.entityId), plan.entities.map((item) => item.id));
  const routeDelta = catalogSetDelta(
    previousRoutes.map((item) => `${item.providerId}\u0000${item.rawModelId}\u0000${item.entityId}`),
    plan.routes.map((item) => `${item.providerId}\u0000${item.rawModelId}\u0000${item.entityId}`)
  );
  const benchmarkDelta = catalogSetDelta(
    previousBenchmarks.map((item) => `${item.benchmarkId}\u0000${item.sourceModel}\u0000${item.entityId}`),
    plan.benchmarks.map((item) => `${item.benchmarkId}\u0000${item.sourceModel}\u0000${item.entityId}`)
  );
  const contentHash = catalogGenerationContentHash(plan);
  await catalogCheckpoint(options, "after_plan");
  const activeStats = input.activeGeneration?.stats as Record<string, unknown> | undefined;
  if (input.activeGeneration && activeStats?.contentHash === contentHash) {
    const stats = {
      durationMs: 0,
      snapshotCount: plan.snapshots.length,
      observationCount: input.observations.length,
      entityCount: plan.entities.length,
      routeCount: plan.routes.length,
      benchmarkCount: plan.benchmarks.length,
      emptyCatalog: allowEmptyCatalog && plan.snapshots.length === 0,
      ambiguousCount: plan.decisions.filter((item) => item.state === "ambiguous").length,
      unresolvedCount: plan.decisions.filter((item) => item.state === "unresolved").length,
      addedEntityCount: 0,
      deactivatedEntityCount: 0,
      addedRouteCount: 0,
      removedRouteCount: 0,
      addedBenchmarkCount: 0,
      removedBenchmarkCount: 0,
      changeCount: 0,
      contentHash,
      noOp: true as const,
    };
    return {
      generationId: input.activeGeneration.id,
      previousGenerationId: input.activeGeneration.parentGenerationId,
      snapshotCount: plan.snapshots.length,
      entityCount: plan.entities.length,
      routeCount: plan.routes.length,
      benchmarkCount: plan.benchmarks.length,
      noOp: true as const,
      stats,
    };
  }
  await tx.insert(schema.catalogGenerations).values({
    id: attempt.generationId,
    parentGenerationId: attempt.parentGenerationId,
    state: "building",
    resolverVersion: CATALOG_RESOLVER_VERSION,
    startedAt: attempt.startedAt,
    stats: {},
  });
  await persistGeneration(tx, attempt.generationId, plan, input.observations);
  await catalogCheckpoint(options, "after_staging");
  const completedAt = new Date();
  const stats = {
    durationMs: completedAt.getTime() - attempt.startedAt.getTime(),
    snapshotCount: plan.snapshots.length,
    observationCount: input.observations.length,
    entityCount: plan.entities.length,
    routeCount: plan.routes.length,
    benchmarkCount: plan.benchmarks.length,
    emptyCatalog: allowEmptyCatalog && plan.snapshots.length === 0,
    ambiguousCount: plan.decisions.filter((item) => item.state === "ambiguous").length,
    unresolvedCount: plan.decisions.filter((item) => item.state === "unresolved").length,
    addedEntityCount: entityDelta.added,
    deactivatedEntityCount: entityDelta.removed,
    addedRouteCount: routeDelta.added,
    removedRouteCount: routeDelta.removed,
    addedBenchmarkCount: benchmarkDelta.added,
    removedBenchmarkCount: benchmarkDelta.removed,
    changeCount: entityDelta.added + entityDelta.removed + routeDelta.added + routeDelta.removed + benchmarkDelta.added + benchmarkDelta.removed,
    contentHash,
  };
  await tx.update(schema.catalogGenerations).set({ state: "ready", completedAt, stats }).where(eq(schema.catalogGenerations.id, attempt.generationId));
  await catalogCheckpoint(options, "before_activation");
  const activated = await activateGenerationInTransaction(tx, attempt.generationId, "reconcile");
  await catalogCheckpoint(options, "after_activation");
  return { ...activated, stats };
};

export async function reconcileCatalog(options: CatalogReconciliationOptions = {}) {
  const attempt = newCatalogReconciliationAttempt();
  try {
    return await db.transaction((tx) => reconcileCatalogInTransaction(tx, attempt, options));
  } catch (error) {
    await recordCatalogReconciliationFailure(attempt, error);
    throw error;
  }
}

export async function deleteProviderAndReconcileCatalog(providerId: string) {
  const attempt = newCatalogReconciliationAttempt();
  try {
    return await db.transaction(async (tx) => {
      await acquireCatalogWriteLock(tx);
      const [provider] = await tx.select({ id: schema.providers.id }).from(schema.providers).where(eq(schema.providers.id, providerId)).limit(1);
      if (!provider) return null;
      const [activeGeneration] = await tx.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)
        .where(eq(schema.catalogGenerations.state, "active")).limit(1);
      await tx.delete(schema.providers).where(eq(schema.providers.id, providerId));
      if (!activeGeneration) return { deleted: true as const, reconciliation: null };
      const reconciliation = await reconcileCatalogInTransaction(tx, attempt, {}, true);
      return { deleted: true as const, reconciliation };
    });
  } catch (error) {
    await recordCatalogReconciliationFailure(attempt, error);
    throw error;
  }
}

export async function activateCatalogGeneration(generationId: string) {
  return db.transaction(async (tx) => {
    await acquireCatalogWriteLock(tx);
    return activateGenerationInTransaction(tx, generationId, "rollback");
  });
}

export async function listCatalogGenerations() {
  return db.select().from(schema.catalogGenerations).orderBy(desc(schema.catalogGenerations.createdAt));
}

export async function dryRunCatalogGarbageCollection(options: { now?: Date; retentionDays?: number } = {}) {
  const retentionDays = options.retentionDays ?? 30;
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 86_400_000);
  // Diagnostic preview is bounded, not an in-memory copy of the entire catalog.
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '10s'`);
    const protectedRows = await tx.execute(sql`select id, parent_generation_id, stats->>'previousGenerationId' as previous
      from catalog_generations where state in ('active','building','ready') limit 1000`);
    const protectedGenerationIds = [...new Set(protectedRows.flatMap(r =>
      [r.id, r.parent_generation_id, r.previous].filter(Boolean).map(String)))];
    const generations = await tx.execute(sql`select g.id from catalog_generations g
      where g.state in ('retired','failed') and g.created_at < ${cutoff.toISOString()}
      and not exists (select 1 from catalog_generations p where p.state in ('active','building','ready')
        and (p.parent_generation_id=g.id or p.stats->>'previousGenerationId'=g.id))
      and not exists (select 1 from resolver_runs r where r.generation_id=g.id and r.status='running')
      order by g.created_at limit 1000`);
    const snapshots = await tx.execute(sql`select s.id from source_snapshots s
      where not s.active and s.state in ('retired','failed') and s.created_at < ${cutoff.toISOString()}
      and not exists (select 1 from catalog_generation_snapshots r where r.snapshot_id=s.id)
      and not exists (select 1 from model_observations o join observation_entity_links l on l.observation_id=o.id
        where o.snapshot_id=s.id and l.review_state <> 'unreviewed')
      order by s.created_at limit 1000`);
    const snapshotIds = snapshots.map(r => String(r.id));
    const observations = snapshotIds.length ? await tx.select({ id: schema.modelObservations.id })
      .from(schema.modelObservations).where(inArray(schema.modelObservations.snapshotId, snapshotIds)).limit(1000) : [];
    const assets = await tx.execute(sql`select a.id from catalog_assets a
      where not a.active and a.created_at < ${cutoff.toISOString()}
      and not exists (select 1 from catalog_generation_assets r where r.asset_id=a.id)
      order by a.created_at limit 1000`);
    const generationIds = generations.map(r => String(r.id));
    const observationIds = observations.map(r => String(r.id));
    const assetIds = assets.map(r => String(r.id));
    return { dryRun: true, bounded: true, limitPerKind: 1000, retentionDays,
      cutoff: cutoff.toISOString(), protectedGenerationIds, generationIds, generationCount: generationIds.length,
      snapshotIds, snapshotCount: snapshotIds.length, observationIds, observationCount: observationIds.length,
      assetIds, assetCount: assetIds.length,
      truncated: [generations, snapshots, observations, assets].some(rows => rows.length === 1000) };
  });
}

let reconciliationInFlight: Promise<Awaited<ReturnType<typeof reconcileCatalog>>> | null = null;

export function scheduleCatalogReconciliation() {
  if (reconciliationInFlight) return reconciliationInFlight;
  reconciliationInFlight = reconcileCatalog().finally(() => {
    reconciliationInFlight = null;
  });
  return reconciliationInFlight;
}
