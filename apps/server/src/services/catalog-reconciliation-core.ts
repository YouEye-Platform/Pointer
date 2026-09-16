import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CATALOG_IDENTITY_RESOLVER_VERSION,
  parseIdentityClaims,
  resolveCatalogIdentities,
  type IdentityDecision,
  type IdentityEntity,
  type IdentityObservationInput,
} from "./catalog-identity-resolver";
import type { ProviderModelInput } from "./catalog-planner";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel, SourceProvenance } from "./sources/types";

export const CATALOG_RESOLVER_VERSION = CATALOG_IDENTITY_RESOLVER_VERSION;
export const DEFAULT_CATALOG_RETENTION_DAYS = 30;

const provenanceSchema = z.object({
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  license: z.string().min(1),
  fetchedAt: z.string().datetime({ offset: true }),
});

export const referenceObservationPayloadSchema = z.object({
  id: z.string().min(1),
  canonicalSlug: z.string().nullable(),
  displayName: z.string().min(1),
  creator: z.string(),
  description: z.string().nullable(),
  contextWindow: z.number().int().nonnegative().nullable(),
  maxOutput: z.number().int().nonnegative().nullable(),
  inputModalities: z.array(z.string()),
  outputModalities: z.array(z.string()),
  supportedParameters: z.array(z.string()),
  inputPricePerMillion: z.number().nonnegative().nullable(),
  outputPricePerMillion: z.number().nonnegative().nullable(),
  cacheReadPricePerMillion: z.number().nonnegative().nullable(),
  cacheWritePricePerMillion: z.number().nonnegative().nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
  raw: z.unknown(),
  provenance: provenanceSchema,
});

export const benchmarkObservationPayloadSchema = z.object({
  benchmarkId: z.string().min(1),
  sourceModelId: z.string().min(1).optional(),
  sourceModel: z.string().min(1),
  creator: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  raw: z.unknown(),
  provenance: provenanceSchema,
});

export const providerObservationPayloadSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  rawModelId: z.string().min(1),
  catalogIdentity: z.string().min(1).nullable().optional(),
  displayName: z.string().min(1).nullable().optional(),
  existingModelId: z.string().min(1),
  inputPrice: z.string().nullable(),
  outputPrice: z.string().nullable(),
  contextWindow: z.number().int().nonnegative().nullable(),
  maxOutput: z.number().int().nonnegative().nullable(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsStreaming: z.boolean(),
});

export type ReconciliationObservation = {
  id: string;
  snapshotId: string;
  sourceId: string;
  kind: "reference_model" | "provider_model" | "benchmark_model";
  nativeId: string;
  rawName: string | null;
  organizationHint: string | null;
  payload: unknown;
};

export type ReconciliationSnapshot = {
  id: string;
  sourceId: string;
  fetchedAt: Date;
  sourceState: {
    health: "healthy" | "degraded" | "stale" | "unavailable" | "never_synced";
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    recordCount: number;
    errorCode: string | null;
    errorMessage: string | null;
  };
};

export type ExistingCatalogEntity = {
  id: string;
  stableSlug: string;
  preferredName?: string;
  organizationId?: string | null;
  identityNativeId?: string;
  identityObservedName?: string | null;
  identityOrganizationHint?: string | null;
};

export type CatalogGenerationEntity = {
  id: string;
  stableSlug: string;
  preferredName: string;
  nameProvenance: CatalogNameProvenance;
  organizationId: string | null;
  description: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  referenceInputPrice: number | null;
  referenceOutputPrice: number | null;
  metadataSource: "openrouter" | "provider" | "benchmark";
  metadataFetchedAt: string | null;
  releasedAt: string | null;
  rawMetadata: unknown;
};

export type CatalogNameProvenance = {
  sourceId: string | null;
  observationId: string | null;
  sourceKind: ReconciliationObservation["kind"] | "reviewed_override" | "fallback";
  originalValue: string;
  selectedValue: string;
  fetchedAt: string | null;
  creatorPrefixRemoved: string | null;
};

export type CatalogGenerationPlan = {
  snapshots: ReconciliationSnapshot[];
  entities: CatalogGenerationEntity[];
  organizations: Array<{ id: string; canonicalName: string; websiteUrl: string | null; aliases: string[] }>;
  decisions: IdentityDecision[];
  links: Array<{
    snapshotId: string;
    observationId: string;
    entityId: string;
    method: Exclude<IdentityDecision["method"], "none">;
    confidence: number;
    evidence: string[];
  }>;
  aliases: Array<{ sourceId: string; alias: string; observationId: string; entityId: string }>;
  nameClaims: Array<{
    entityId: string;
    sourceId: string;
    observationId: string;
    value: string;
    normalizedValue: string;
    selected: boolean;
    provenance: Record<string, unknown>;
  }>;
  routes: Array<{
    providerModelId: string;
    providerId: string;
    rawModelId: string;
    snapshotId: string;
    observationId: string;
    entityId: string;
    inputPrice: string | null;
    outputPrice: string | null;
    contextWindow: number | null;
    maxOutput: number | null;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
  }>;
  benchmarks: Array<{
    benchmarkId: string;
    sourceModel: string;
    snapshotId: string;
    observationId: string;
    entityId: string;
    metrics: Record<string, string | number | boolean | null>;
    provenance: SourceProvenance;
    fetchedAt: string;
  }>;
  assets: Array<{
    id: string;
    organizationId: string;
    kind: string;
    originUrl: string;
    license: string;
    contentHash: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    validationState: string;
    cachePath: string | null;
    fetchedAt: Date;
  }>;
  collisions: Array<{ observationId: string; candidates: string[] }>;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
};

export const stableCatalogJson = (value: unknown) => JSON.stringify(stableValue(value));

export const catalogContentHash = (value: unknown) => createHash("sha256")
  .update(stableCatalogJson(value))
  .digest("hex");

// Refresh timestamps and source-health observations are not catalog revisions.
function semanticCatalogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticCatalogValue);
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !["fetchedAt", "metadataFetchedAt", "sourceState"].includes(key))
      .map(([key, child]) => [key, semanticCatalogValue(child)]));
  return value;
}
export const catalogGenerationContentHash = (plan: CatalogGenerationPlan) =>
  catalogContentHash(semanticCatalogValue(plan));

export function deriveCreatorAliases(
  organizations: Array<{ id: string; canonicalName: string; aliases: string[] }>
) {
  const explicitTargets = new Map<string, Set<string>>();
  const fallbackTargets = new Map<string, Set<string>>();
  const add = (targetsByAlias: Map<string, Set<string>>, alias: string, creator: string) => {
    const normalized = alias.toLowerCase().trim().replace(/[_\s]+/g, "-");
    if (!normalized) return;
    const targets = targetsByAlias.get(normalized) ?? new Set<string>();
    targets.add(creator);
    targetsByAlias.set(normalized, targets);
  };
  for (const organization of organizations) {
    const creator = organization.id.replace(/^org\//, "");
    add(fallbackTargets, creator, creator);
    add(fallbackTargets, organization.canonicalName, creator);
    for (const alias of organization.aliases) add(explicitTargets, alias, creator);
  }
  const result: Record<string, string> = {};
  for (const [alias, targets] of explicitTargets) {
    if (targets.size === 1) result[alias] = [...targets][0];
  }
  for (const [alias, targets] of fallbackTargets) {
    if (!(alias in result) && !explicitTargets.has(alias) && targets.size === 1) result[alias] = [...targets][0];
  }
  return result;
}

export function planCompatibilityRedirects(input: {
  currentEntities: Array<{ id: string; stableSlug: string }>;
  historicalEntities: Array<{ id: string; stableSlug: string }>;
  currentRemaps: Array<{ previousEntityId: string; entityId: string }>;
  historicalAliases: Array<{ alias: string; entityId: string }>;
}) {
  const parent = new Map<string, string>();
  const add = (id: string) => { if (!parent.has(id)) parent.set(id, id); };
  const find = (id: string): string => {
    add(id);
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
  };
  for (const entity of [...input.historicalEntities, ...input.currentEntities]) add(entity.id);

  const remapTargets = new Map<string, Set<string>>();
  for (const remap of input.currentRemaps) {
    if (remap.previousEntityId === remap.entityId) continue;
    const targets = remapTargets.get(remap.previousEntityId) ?? new Set<string>();
    targets.add(remap.entityId);
    remapTargets.set(remap.previousEntityId, targets);
  }
  for (const [previousEntityId, targets] of remapTargets) {
    if (targets.size === 1) union(previousEntityId, [...targets][0]);
  }

  const entitiesByPublishedKey = new Map<string, Set<string>>();
  for (const entity of input.historicalEntities) {
    for (const key of [entity.id, entity.stableSlug]) {
      const ids = entitiesByPublishedKey.get(key) ?? new Set<string>();
      ids.add(entity.id);
      entitiesByPublishedKey.set(key, ids);
    }
  }
  for (const alias of input.historicalAliases) {
    const historicalIds = entitiesByPublishedKey.get(alias.alias);
    if (historicalIds?.size === 1) union([...historicalIds][0], alias.entityId);
  }

  const currentEntityIds = new Set(input.currentEntities.map((entity) => entity.id));
  const currentByPublishedKey = new Map(input.currentEntities.flatMap((entity) => [
    [entity.id, entity.id] as const,
    [entity.stableSlug, entity.id] as const,
  ]));
  const currentTargetsByRoot = new Map<string, Set<string>>();
  for (const entity of input.currentEntities) {
    const root = find(entity.id);
    const targets = currentTargetsByRoot.get(root) ?? new Set<string>();
    targets.add(entity.id);
    currentTargetsByRoot.set(root, targets);
  }
  const uniqueCurrentTarget = (entityId: string) => {
    if (currentEntityIds.has(entityId)) return entityId;
    const targets = currentTargetsByRoot.get(find(entityId));
    return targets?.size === 1 ? [...targets][0] : null;
  };
  const targetsByAlias = new Map<string, Set<string>>();
  const addRedirect = (alias: string, entityId: string) => {
    const currentKeyTarget = currentByPublishedKey.get(alias);
    if (!alias || alias === entityId || currentKeyTarget === entityId) return;
    if (currentKeyTarget && currentKeyTarget !== entityId) return;
    const targets = targetsByAlias.get(alias) ?? new Set<string>();
    targets.add(entityId);
    targetsByAlias.set(alias, targets);
  };
  for (const alias of input.historicalAliases) {
    const target = uniqueCurrentTarget(alias.entityId);
    if (target) addRedirect(alias.alias, target);
  }
  for (const entity of input.historicalEntities) {
    if (currentEntityIds.has(entity.id)) continue;
    const target = uniqueCurrentTarget(entity.id);
    if (!target) continue;
    addRedirect(entity.id, target);
    addRedirect(entity.stableSlug, target);
  }
  return [...targetsByAlias.entries()]
    .filter(([, targets]) => targets.size === 1)
    .map(([alias, targets]) => ({ alias, entityId: [...targets][0] }))
    .sort((left, right) => left.alias.localeCompare(right.alias) || left.entityId.localeCompare(right.entityId));
}

const inventoryRecord = (record: unknown) => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const value = record as Record<string, unknown>;
  const provenance = value.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return record;
  const { fetchedAt: _fetchedAt, ...stableProvenance } = provenance as Record<string, unknown>;
  return { ...value, provenance: stableProvenance };
};

const canonicalRecordOrder = (records: unknown[]) => [...records]
  .map((record) => stableCatalogJson(inventoryRecord(record)))
  .sort()
  .map((record) => JSON.parse(record) as unknown);

export const catalogInventoryHash = (records: unknown[]) => catalogContentHash(canonicalRecordOrder(records));

export const catalogSnapshotRevision = (fetchedAt: Date, records: unknown[]) =>
  `${fetchedAt.toISOString()}:${catalogInventoryHash(records)}`;

const disambiguatedSlug = (slug: string, id: string) => `${slug}--${catalogContentHash(id).slice(0, 10)}`;

function stableSlugs(
  planned: Array<{ id: string; stableSlug: string }>,
  existing: ExistingCatalogEntity[]
) {
  const existingById = new Map(existing.map((entity) => [entity.id, entity.stableSlug]));
  const reserved = new Map(existing.map((entity) => [entity.stableSlug, entity.id]));
  const result = new Map<string, string>();
  for (const model of [...planned].sort((left, right) => left.id.localeCompare(right.id))) {
    let stableSlug = existingById.get(model.id) ?? model.stableSlug;
    const owner = reserved.get(stableSlug);
    if (owner && owner !== model.id) stableSlug = disambiguatedSlug(stableSlug, model.id);
    while (reserved.has(stableSlug) && reserved.get(stableSlug) !== model.id) {
      stableSlug = disambiguatedSlug(stableSlug, `${model.id}:${stableSlug}`);
    }
    reserved.set(stableSlug, model.id);
    result.set(model.id, stableSlug);
  }
  return result;
}

const sourceMetadata = (
  entityId: string,
  observationsById: Map<string, ReconciliationObservation>,
  decisions: IdentityDecision[],
  references: Map<string, NormalizedReferenceModel>,
  providers: Map<string, ProviderModelInput>,
  benchmarks: Map<string, NormalizedBenchmarkRecord>
): Omit<CatalogGenerationEntity, "id" | "stableSlug" | "preferredName" | "nameProvenance" | "organizationId"> => {
  const linked = decisions.filter((item) => item.state === "linked" && item.entityId === entityId)
    .map((item) => observationsById.get(item.observationId))
    .filter((item): item is ReconciliationObservation => Boolean(item))
    .sort((left, right) => {
      const authority = { reference_model: 0, provider_model: 1, benchmark_model: 2 } as const;
      return authority[left.kind] - authority[right.kind]
        || left.sourceId.localeCompare(right.sourceId)
        || left.nativeId.localeCompare(right.nativeId)
        || left.id.localeCompare(right.id);
    });
  const reference = linked.map((item) => references.get(item.id)).find(Boolean);
  if (reference) return {
    description: reference.description,
    contextWindow: reference.contextWindow,
    maxOutput: reference.maxOutput,
    supportsTools: reference.supportedParameters.includes("tools"),
    supportsVision: reference.inputModalities.includes("image"),
    supportsStreaming: true,
    referenceInputPrice: reference.inputPricePerMillion,
    referenceOutputPrice: reference.outputPricePerMillion,
    metadataSource: "openrouter",
    metadataFetchedAt: reference.provenance.fetchedAt,
    releasedAt: reference.releasedAt ?? null,
    rawMetadata: reference.raw,
  };
  const provider = linked.map((item) => providers.get(item.id)).find(Boolean);
  if (provider) return {
    description: null,
    contextWindow: provider.contextWindow,
    maxOutput: provider.maxOutput,
    supportsTools: provider.supportsTools,
    supportsVision: provider.supportsVision,
    supportsStreaming: provider.supportsStreaming,
    referenceInputPrice: null,
    referenceOutputPrice: null,
    metadataSource: "provider",
    metadataFetchedAt: null,
    releasedAt: null,
    rawMetadata: { providerId: provider.providerId, rawModelId: provider.rawModelId },
  };
  const benchmark = linked.map((item) => benchmarks.get(item.id)).find(Boolean);
  return {
    description: null,
    contextWindow: null,
    maxOutput: null,
    supportsTools: false,
    supportsVision: false,
    supportsStreaming: false,
    referenceInputPrice: null,
    referenceOutputPrice: null,
    metadataSource: "benchmark",
    metadataFetchedAt: benchmark?.provenance.fetchedAt ?? null,
    releasedAt: null,
    rawMetadata: benchmark?.raw ?? {},
  };
};

const normalizeClaimText = (value: string) => value.toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ");

const compactClaimText = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const localRouteLabel = (value: string) => {
  const local = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  return local.replace(/:(?:free|paid)$/i, "").trim();
};

const formatSourceDisplayToken = (token: string) => {
  const parts = token.split("-").filter(Boolean);
  if (parts.length < 3 || token.includes(":") || !/[A-Z]/.test(parts[0])) return token;

  return parts.reduce((displayName, part, index) => {
    if (index === 0) return part;
    const previous = parts[index - 1];
    const keepsVersionHyphen = index === 1
      && /^[A-Z]{2,10}$/.test(previous)
      && /^\d+(?:\.\d+)*(?:[A-Za-z])?$/.test(part);
    return `${displayName}${keepsVersionHyphen ? "-" : " "}${part}`;
  }, "");
};

const formatSourceDisplayName = (value: string) => value
  .trim()
  .replace(/\s+/g, " ")
  .split(" ")
  .map(formatSourceDisplayToken)
  .join(" ");

const creatorPrefix = (value: string, creatorAliases: Set<string>) => {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const prefix = value.slice(0, separator).trim();
  const normalizedPrefix = normalizeClaimText(prefix);
  const compactPrefix = compactClaimText(prefix);
  const matched = [...creatorAliases].some((alias) => {
    const compactAlias = compactClaimText(alias);
    return alias === normalizedPrefix
      || compactAlias === compactPrefix
      || (compactPrefix.length >= 3 && compactAlias.startsWith(compactPrefix));
  });
  return matched ? prefix : null;
};

function selectCanonicalName(input: {
  entity: IdentityEntity;
  decisions: IdentityDecision[];
  observationsById: Map<string, ReconciliationObservation>;
  snapshotsById: Map<string, ReconciliationSnapshot>;
  reviewedName?: string;
  organizationAliases: string[];
}) {
  const linked = input.decisions
    .filter((decision) => decision.state === "linked" && decision.entityId === input.entity.id)
    .map((decision) => input.observationsById.get(decision.observationId))
    .filter((observation): observation is ReconciliationObservation => Boolean(observation));
  const creatorAliases = new Set([
    input.entity.claims.creator,
    input.entity.claims.namespace,
    ...input.organizationAliases,
    ...linked.flatMap((observation) => [observation.organizationHint, observation.nativeId.includes("/") ? observation.nativeId.slice(0, observation.nativeId.indexOf("/")) : null]),
  ].filter((value): value is string => Boolean(value)).map(normalizeClaimText));
  const candidates = linked.map((observation) => {
    const localNative = localRouteLabel(observation.nativeId);
    const rawClaim = observation.rawName?.trim();
    const presentationClaim = rawClaim && rawClaim.includes("/") && !/\s/.test(rawClaim)
      ? localRouteLabel(rawClaim)
      : rawClaim;
    const value = presentationClaim && presentationClaim !== observation.nativeId ? presentationClaim : localNative;
    const distinct = value !== observation.nativeId && value !== localNative;
    const authority = observation.kind === "provider_model" ? 300 : observation.kind === "reference_model" ? 250 : 100;
    const prefix = creatorPrefix(value, creatorAliases);
    const selectedValue = prefix ? value.slice(value.indexOf(":") + 1).trim() : value;
    const fetchedAt = input.snapshotsById.get(observation.snapshotId)?.fetchedAt.toISOString() ?? null;
    return {
      observation,
      value,
      selectedValue: selectedValue || value,
      prefix,
      fetchedAt,
      score: authority + (distinct ? 100 : 0),
    };
  }).sort((left, right) => right.score - left.score
    || (right.fetchedAt ?? "").localeCompare(left.fetchedAt ?? "")
    || left.observation.sourceId.localeCompare(right.observation.sourceId)
    || left.observation.nativeId.localeCompare(right.observation.nativeId)
    || left.observation.id.localeCompare(right.observation.id));

  const reviewed = input.reviewedName?.trim();
  const selected = candidates[0];
  const reviewedPrefix = reviewed ? creatorPrefix(reviewed, creatorAliases) : null;
  const selectedName = reviewed
    ? (reviewedPrefix ? reviewed.slice(reviewed.indexOf(":") + 1).trim() : reviewed)
    : selected
      ? formatSourceDisplayName(selected.selectedValue)
      : localRouteLabel(input.entity.claims.rawNativeId);
  const provenance: CatalogNameProvenance = reviewed ? {
    sourceId: null,
    observationId: null,
    sourceKind: "reviewed_override",
    originalValue: reviewed,
    selectedValue: selectedName,
    fetchedAt: null,
    creatorPrefixRemoved: reviewedPrefix,
  } : selected ? {
    sourceId: selected.observation.sourceId,
    observationId: selected.observation.id,
    sourceKind: selected.observation.kind,
    originalValue: selected.value,
    selectedValue: selectedName,
    fetchedAt: selected.fetchedAt,
    creatorPrefixRemoved: selected.prefix,
  } : {
    sourceId: null,
    observationId: null,
    sourceKind: "fallback",
    originalValue: input.entity.claims.rawNativeId,
    selectedValue: selectedName,
    fetchedAt: null,
    creatorPrefixRemoved: null,
  };
  const nameClaims = candidates.map((candidate) => ({
    entityId: input.entity.id,
    sourceId: candidate.observation.sourceId,
    observationId: candidate.observation.id,
    value: candidate.value,
    normalizedValue: normalizeClaimText(candidate.value),
    selected: !reviewed && candidate.observation.id === selected?.observation.id,
    provenance: {
      sourceKind: candidate.observation.kind,
      nativeId: candidate.observation.nativeId,
      fetchedAt: candidate.fetchedAt,
      creatorPrefixRemoved: candidate.prefix,
    },
  }));
  return { selectedName, provenance, nameClaims };
}

export function buildCatalogGenerationPlan(input: {
  snapshots: ReconciliationSnapshot[];
  observations: ReconciliationObservation[];
  existingEntities?: ExistingCatalogEntity[];
  existingOrganizations?: Array<{ id: string; canonicalName: string; websiteUrl: string | null; aliases: string[] }>;
  activeAssets?: CatalogGenerationPlan["assets"];
  previousLinks?: Record<string, string>;
  previousCompatibilityAliases?: Array<{ alias: string; entityId: string }>;
  reviewedOverrides?: Record<string, string>;
  rejectedEntityIds?: Record<string, string[]>;
  authoritativeCrosswalk?: Record<string, string>;
  approvedAliases?: Record<string, string>;
  creatorAliases?: Record<string, string>;
  reviewedNames?: Record<string, string>;
}, options: { allowEmptyCatalog?: boolean } = {}): CatalogGenerationPlan {
  const references = new Map<string, NormalizedReferenceModel>();
  const providers = new Map<string, ProviderModelInput>();
  const benchmarks = new Map<string, NormalizedBenchmarkRecord>();
  const identityObservations: IdentityObservationInput[] = [];

  for (const observation of input.observations) {
    if (observation.kind === "reference_model") {
      references.set(observation.id, referenceObservationPayloadSchema.parse(observation.payload) as NormalizedReferenceModel);
    } else if (observation.kind === "provider_model") {
      providers.set(observation.id, providerObservationPayloadSchema.parse(observation.payload) as ProviderModelInput);
    } else {
      benchmarks.set(observation.id, benchmarkObservationPayloadSchema.parse(observation.payload) as NormalizedBenchmarkRecord);
    }
  }

  const identitySources = new Map<string, Set<string>>();
  const addIdentitySource = (
    nativeId: string,
    observedName: string | null,
    organizationHint: string | null,
    sourceId: string
  ) => {
    const key = parseIdentityClaims({
      nativeId,
      observedName,
      organizationHint,
    }, input.creatorAliases).identityKey;
    const sources = identitySources.get(key) ?? new Set<string>();
    sources.add(sourceId);
    identitySources.set(key, sources);
    return key;
  };

  for (const observation of input.observations) {
    const provider = providers.get(observation.id);
    addIdentitySource(
      observation.kind === "benchmark_model"
        ? observation.rawName || observation.nativeId
        : observation.nativeId,
      observation.rawName,
      observation.organizationHint,
      observation.sourceId
    );
    if (provider?.catalogIdentity) {
      addIdentitySource(
        provider.catalogIdentity,
        observation.rawName,
        provider.catalogIdentity.includes("/")
          ? provider.catalogIdentity.slice(0, provider.catalogIdentity.indexOf("/"))
          : observation.organizationHint,
        observation.sourceId
      );
    }
  }

  for (const observation of input.observations) {
    const provider = providers.get(observation.id);
    const catalogOrganizationHint = provider?.catalogIdentity?.includes("/")
      ? provider.catalogIdentity.slice(0, provider.catalogIdentity.indexOf("/"))
      : observation.organizationHint;
    const catalogIdentityKey = provider?.catalogIdentity
      ? parseIdentityClaims({
          nativeId: provider.catalogIdentity,
          observedName: observation.rawName,
          organizationHint: catalogOrganizationHint,
        }, input.creatorAliases).identityKey
      : null;
    const corroboratedCatalogIdentity = provider?.catalogIdentity
      && catalogIdentityKey
      && [...(identitySources.get(catalogIdentityKey) ?? [])]
        .some((sourceId) => sourceId !== observation.sourceId);
    const identityNativeId = corroboratedCatalogIdentity
      ? provider.catalogIdentity!
      : (
      observation.kind === "benchmark_model"
        ? observation.rawName || observation.nativeId
        : observation.nativeId
      );
    identityObservations.push({
      id: observation.id,
      sourceId: observation.sourceId,
      kind: observation.kind,
      nativeId: identityNativeId,
      observedName: observation.rawName,
      organizationHint: corroboratedCatalogIdentity
        ? catalogOrganizationHint
        : observation.organizationHint,
    });
  }

  const resolved = resolveCatalogIdentities({
    observations: identityObservations,
    existingEntities: (input.existingEntities ?? []).filter((entity) => entity.preferredName).map((entity) => ({
      id: entity.id,
      stableSlug: entity.stableSlug,
      preferredName: entity.preferredName!,
      organizationId: entity.organizationId ?? null,
      claims: parseIdentityClaims({
        nativeId: entity.identityNativeId ?? entity.preferredName!,
        observedName: entity.identityObservedName ?? entity.preferredName!,
        organizationHint: entity.identityOrganizationHint ?? entity.organizationId?.replace(/^org\//, "") ?? null,
      }, input.creatorAliases),
    })),
    reviewedOverrides: input.reviewedOverrides,
    rejectedEntityIds: input.rejectedEntityIds,
    authoritativeCrosswalk: input.authoritativeCrosswalk,
    approvedAliases: input.approvedAliases,
    creatorAliases: input.creatorAliases,
    priorLinks: input.previousLinks,
  });
  const observationsById = new Map(input.observations.map((item) => [item.id, item]));
  const snapshotsById = new Map(input.snapshots.map((item) => [item.id, item]));
  const stableSlugByEntity = stableSlugs(resolved.entities, input.existingEntities ?? []);
  const existingOrganizationById = new Map((input.existingOrganizations ?? []).map((organization) => [organization.id, organization]));
  const nameSelections = new Map(resolved.entities.map((entity) => [entity.id, selectCanonicalName({
    entity,
    decisions: resolved.decisions,
    observationsById,
    snapshotsById,
    reviewedName: input.reviewedNames?.[entity.id],
    organizationAliases: entity.organizationId ? existingOrganizationById.get(entity.organizationId)?.aliases ?? [] : [],
  })]));
  const entities: CatalogGenerationEntity[] = resolved.entities.map((entity) => {
    const name = nameSelections.get(entity.id)!;
    return {
      id: entity.id,
      stableSlug: stableSlugByEntity.get(entity.id)!,
      preferredName: name.selectedName,
      nameProvenance: name.provenance,
      organizationId: entity.organizationId,
      ...sourceMetadata(entity.id, observationsById, resolved.decisions, references, providers, benchmarks),
    };
  });
  const links: CatalogGenerationPlan["links"] = [];
  const aliases: CatalogGenerationPlan["aliases"] = [];
  const routes: CatalogGenerationPlan["routes"] = [];
  const benchmarkLinks: CatalogGenerationPlan["benchmarks"] = [];

  for (const item of resolved.decisions.filter((decision) => decision.state === "linked" && decision.entityId)) {
    const observation = observationsById.get(item.observationId)!;
    links.push({
      snapshotId: observation.snapshotId,
      observationId: observation.id,
      entityId: item.entityId!,
      method: item.method as Exclude<IdentityDecision["method"], "none">,
      confidence: item.confidence,
      evidence: item.evidence,
    });
    const provider = providers.get(observation.id);
    for (const alias of new Set([
      observation.nativeId,
      observation.rawName,
      provider?.catalogIdentity,
    ].filter((value): value is string => Boolean(value)))) {
      aliases.push({ sourceId: observation.sourceId, alias, observationId: observation.id, entityId: item.entityId! });
    }
    if (provider) routes.push({
      providerModelId: provider.id,
      providerId: provider.providerId,
      rawModelId: provider.rawModelId,
      snapshotId: observation.snapshotId,
      observationId: observation.id,
      entityId: item.entityId!,
      inputPrice: provider.inputPrice,
      outputPrice: provider.outputPrice,
      contextWindow: provider.contextWindow,
      maxOutput: provider.maxOutput,
      supportsTools: provider.supportsTools,
      supportsVision: provider.supportsVision,
      supportsStreaming: provider.supportsStreaming,
    });
    const benchmark = benchmarks.get(observation.id);
    if (benchmark) benchmarkLinks.push({
      benchmarkId: benchmark.benchmarkId,
      sourceModel: benchmark.sourceModel,
      snapshotId: observation.snapshotId,
      observationId: observation.id,
      entityId: item.entityId!,
      metrics: benchmark.metrics,
      provenance: benchmark.provenance,
      fetchedAt: benchmark.provenance.fetchedAt,
    });
  }

  const anchorByEntity = new Map(resolved.decisions
    .filter((item): item is IdentityDecision & { entityId: string } => item.state === "linked" && Boolean(item.entityId))
    .map((item) => [item.entityId, item]));
  const redirects = planCompatibilityRedirects({
    currentEntities: resolved.entities.map((entity) => ({ id: entity.id, stableSlug: stableSlugByEntity.get(entity.id)! })),
    historicalEntities: input.existingEntities ?? [],
    currentRemaps: resolved.decisions.flatMap((item) => {
      const previousEntityId = input.previousLinks?.[item.observationId];
      return item.state === "linked" && item.entityId && previousEntityId
        ? [{ previousEntityId, entityId: item.entityId }]
        : [];
    }),
    historicalAliases: input.previousCompatibilityAliases ?? [],
  });
  for (const { alias, entityId } of redirects) {
    const anchor = anchorByEntity.get(entityId);
    if (anchor) aliases.push({ sourceId: "pointer:entity-redirect", alias, observationId: anchor.observationId, entityId });
  }

  const organizationCandidates = [...new Map(resolved.entities.filter((entity) => entity.organizationId && entity.claims.creator)
    .map((entity) => {
      const existing = existingOrganizationById.get(entity.organizationId!);
      const prefixCounts = new Map<string, number>();
      for (const candidate of resolved.entities.filter((item) => item.organizationId === entity.organizationId)) {
        const prefix = nameSelections.get(candidate.id)?.provenance.creatorPrefixRemoved;
        if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      }
      const claimedName = [...prefixCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
      return [entity.organizationId!, {
        id: entity.organizationId!,
        claimedName,
        existingName: existing?.canonicalName,
        creatorName: entity.claims.creator!,
        websiteUrl: existing?.websiteUrl ?? null,
        aliases: [...(existing?.aliases ?? [])].sort(),
      }];
    })).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const existingOrganizationNameOwner = new Map((input.existingOrganizations ?? [])
    .map((organization) => [organization.canonicalName, organization.id]));
  const selectedOrganizationNameOwner = new Map<string, string>();
  const organizations = organizationCandidates.map((candidate) => {
    const canonicalName = [candidate.claimedName, candidate.existingName, candidate.creatorName]
      .filter((value): value is string => Boolean(value))
      .find((value) => {
        const existingOwner = existingOrganizationNameOwner.get(value);
        const selectedOwner = selectedOrganizationNameOwner.get(value);
        return (!existingOwner || existingOwner === candidate.id) && (!selectedOwner || selectedOwner === candidate.id);
      }) ?? candidate.id.replace(/^org\//, "");
    selectedOrganizationNameOwner.set(canonicalName, candidate.id);
    return {
      id: candidate.id,
      canonicalName,
      websiteUrl: candidate.websiteUrl,
      aliases: candidate.aliases,
    };
  });
  const organizationIds = new Set(organizations.map((organization) => organization.id));
  const uniqueAliases = [...new Map(aliases.map((alias) => [`${alias.sourceId}\u0000${alias.alias}\u0000${alias.entityId}`, alias])).values()];
  const result = {
    snapshots: [...input.snapshots].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    entities: entities.sort((left, right) => left.id.localeCompare(right.id)),
    organizations,
    decisions: resolved.decisions,
    links: links.sort((left, right) => left.observationId.localeCompare(right.observationId)),
    aliases: uniqueAliases.sort((left, right) => `${left.sourceId}\u0000${left.alias}\u0000${left.entityId}`.localeCompare(`${right.sourceId}\u0000${right.alias}\u0000${right.entityId}`)),
    nameClaims: [...nameSelections.values()].flatMap((selection) => selection.nameClaims)
      .sort((left, right) => `${left.entityId}\u0000${left.sourceId}\u0000${left.value}`.localeCompare(`${right.entityId}\u0000${right.sourceId}\u0000${right.value}`)),
    routes: routes.sort((left, right) => left.providerModelId.localeCompare(right.providerModelId)),
    benchmarks: benchmarkLinks.sort((left, right) => `${left.benchmarkId}\u0000${left.sourceModel}`.localeCompare(`${right.benchmarkId}\u0000${right.sourceModel}`)),
    assets: [...(input.activeAssets ?? [])].filter((asset) => organizationIds.has(asset.organizationId)).sort((left, right) => left.id.localeCompare(right.id)),
    collisions: resolved.decisions.filter((item) => item.state === "ambiguous")
      .map((item) => ({ observationId: item.observationId, candidates: item.candidateEntityIds })),
  } satisfies CatalogGenerationPlan;
  validateCatalogGenerationPlan(result, input.observations, options);
  return result;
}

const assertUnique = <T>(items: T[], key: (item: T) => string, label: string) => {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
};

export function validateCatalogGenerationPlan(
  plan: CatalogGenerationPlan,
  observations: ReconciliationObservation[],
  options: { allowEmptyCatalog?: boolean } = {}
) {
  const validEmptyCatalog = options.allowEmptyCatalog === true
    && plan.snapshots.length === 0
    && observations.length === 0
    && plan.entities.length === 0;
  if (plan.snapshots.length === 0 && !validEmptyCatalog) throw new Error("Catalog generation has no validated snapshots");
  if (plan.entities.length === 0 && !validEmptyCatalog) throw new Error("Catalog generation has no entities");
  assertUnique(plan.snapshots, (snapshot) => snapshot.sourceId, "source snapshot");
  assertUnique(plan.entities, (entity) => entity.id, "entity ID");
  assertUnique(plan.entities, (entity) => entity.stableSlug, "entity slug");
  assertUnique(plan.organizations, (organization) => organization.id, "organization ID");
  assertUnique(plan.organizations, (organization) => organization.canonicalName, "organization name");
  assertUnique(plan.assets, (asset) => asset.id, "asset ID");
  assertUnique(plan.links, (link) => link.observationId, "observation link");
  assertUnique(plan.aliases, (alias) => `${alias.sourceId}\u0000${alias.alias}\u0000${alias.entityId}`, "alias");
  assertUnique(plan.routes, (route) => route.providerModelId, "provider model route");
  assertUnique(plan.routes, (route) => `${route.providerId}\u0000${route.rawModelId}`, "provider raw route");
  assertUnique(plan.benchmarks, (benchmark) => `${benchmark.benchmarkId}\u0000${benchmark.sourceModel}`, "benchmark link");

  const snapshotIds = new Set(plan.snapshots.map((snapshot) => snapshot.id));
  const observationIds = new Set(observations.filter((observation) => snapshotIds.has(observation.snapshotId)).map((observation) => observation.id));
  const entityIds = new Set(plan.entities.map((entity) => entity.id));
  const organizationIds = new Set(plan.organizations.map((organization) => organization.id));
  const supportedEntities = new Set(plan.links.map((link) => link.entityId));
  for (const observation of observations) {
    if (!snapshotIds.has(observation.snapshotId)) throw new Error(`Observation ${observation.id} is outside the selected snapshots`);
  }
  for (const link of plan.links) {
    if (!observationIds.has(link.observationId)) throw new Error(`Dangling observation link: ${link.observationId}`);
    if (!entityIds.has(link.entityId)) throw new Error(`Dangling entity link: ${link.entityId}`);
    if (observationsById(observations, link.observationId).snapshotId !== link.snapshotId) throw new Error(`Observation snapshot mismatch: ${link.observationId}`);
  }
  const linksByObservation = new Map(plan.links.map((link) => [link.observationId, link]));
  for (const alias of plan.aliases) {
    const link = linksByObservation.get(alias.observationId);
    if (!link || link.entityId !== alias.entityId) throw new Error(`Invalid alias link: ${alias.sourceId}:${alias.alias}`);
  }
  for (const entity of plan.entities) {
    if (!supportedEntities.has(entity.id)) throw new Error(`Entity has no active observation support: ${entity.id}`);
    if (entity.organizationId && !organizationIds.has(entity.organizationId)) throw new Error(`Entity has no generation organization: ${entity.id}`);
  }
  for (const asset of plan.assets) {
    if (!organizationIds.has(asset.organizationId)) throw new Error(`Asset has no generation organization: ${asset.id}`);
  }
  for (const route of plan.routes) {
    if (!observationIds.has(route.observationId) || !entityIds.has(route.entityId)) throw new Error(`Invalid route link: ${route.providerModelId}`);
  }
  for (const benchmark of plan.benchmarks) {
    if (!observationIds.has(benchmark.observationId) || !entityIds.has(benchmark.entityId)) {
      throw new Error(`Invalid benchmark link: ${benchmark.benchmarkId}:${benchmark.sourceModel}`);
    }
    provenanceSchema.parse(benchmark.provenance);
  }
}

const observationsById = (observations: ReconciliationObservation[], id: string) => {
  const observation = observations.find((item) => item.id === id);
  if (!observation) throw new Error(`Missing observation ${id}`);
  return observation;
};

export type CatalogGcCandidate = {
  id: string;
  createdAt: Date;
  state: string;
  referencedByProtectedGeneration: boolean;
};

export function planCatalogGarbageCollection<T extends CatalogGcCandidate>(
  candidates: T[],
  options: { now: Date; retentionDays?: number }
) {
  const retentionDays = options.retentionDays ?? DEFAULT_CATALOG_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Catalog retention must be at least one day");
  const cutoff = options.now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return candidates.filter((candidate) =>
    ["failed", "retired"].includes(candidate.state)
    && !candidate.referencedByProtectedGeneration
    && candidate.createdAt.getTime() < cutoff
  );
}
