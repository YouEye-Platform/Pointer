import { z } from "zod";

export const CATALOG_CORPUS_VERSION = "1" as const;
export const CATALOG_CONTRACT_VERSION = "1" as const;

const nullableText = z.string().nullable();
const isoTimestamp = z.string().datetime({ offset: true });

export const catalogProvenanceSchema = z.object({
  source: z.string().min(1),
  sourceUrl: z.string().url(),
  license: z.string().min(1),
  fetchedAt: isoTimestamp,
});

export const catalogObservationSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  sourceRecordKey: z.string().min(1),
  kind: z.enum(["reference_model", "provider_model", "benchmark_model"]),
  nativeId: z.string().min(1),
  observedName: nullableText,
  organizationHint: nullableText,
  providerId: nullableText,
  attributes: z.record(z.string(), z.unknown()),
  provenance: catalogProvenanceSchema.nullable(),
  active: z.boolean(),
});

export const catalogEntitySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  preferredName: z.string().min(1),
  organizationId: nullableText,
  active: z.boolean(),
});

export const catalogIdentityDecisionSchema = z.object({
  observationId: z.string().min(1),
  entityId: nullableText,
  state: z.enum(["linked", "ambiguous", "unresolved", "rejected"]),
  method: z.enum(["native_id", "crosswalk", "approved_alias", "structured_match", "reviewed_override", "none"]),
  confidence: z.number().min(0).max(1),
  candidateEntityIds: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  resolverVersion: z.string().min(1),
});

export const catalogOrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  websiteUrl: z.string().url().nullable(),
});

export const catalogAssetSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  kind: z.enum(["icon", "logo"]),
  mediaType: z.string().min(1),
  contentHash: z.string().min(1),
  sourceUrl: z.string().url(),
  license: z.string().min(1),
  fetchedAt: isoTimestamp,
  active: z.boolean(),
});

export const catalogProviderRouteSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  providerModelId: z.string().min(1),
  entityId: nullableText,
  active: z.boolean(),
});

export const catalogBenchmarkLinkSchema = z.object({
  id: z.string().min(1),
  benchmarkId: z.string().min(1),
  sourceModel: z.string().min(1),
  entityId: nullableText,
  provenance: catalogProvenanceSchema,
});

export const catalogAliasClaimSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  alias: z.string().min(1),
  entityId: z.string().min(1),
  explicit: z.boolean(),
});

export const catalogSourceStateSchema = z.object({
  sourceId: z.string().min(1),
  health: z.enum(["healthy", "degraded", "stale", "unavailable", "never_synced"]),
  lastAttemptAt: isoTimestamp.nullable(),
  lastSuccessAt: isoTimestamp.nullable(),
  recordCount: z.number().int().nonnegative(),
  errorCode: nullableText,
  errorMessage: nullableText,
});

export const catalogApiSourceStateSchema = z.object({
  sourceId: z.string().min(1),
  status: z.enum(["never_synced", "disabled", "syncing", "ok", "error"]),
  stale: z.boolean(),
  lastAttemptAt: isoTimestamp.nullable(),
  lastSuccessAt: isoTimestamp.nullable(),
  fetchedAt: isoTimestamp.nullable(),
  recordCount: z.number().int().nonnegative(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).nullable(),
});

export const benchmarkDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  sourceUrl: z.string().url(),
  license: z.string().min(1),
  scoreMetric: z.string().min(1),
  rankMetric: z.string().nullable(),
  unit: z.enum(["points", "percent", "rank"]),
  higherIsBetter: z.boolean(),
  defaultVisible: z.boolean(),
  rankingPriority: z.number().int().nonnegative().nullable(),
  attribution: z.string().nullable(),
});

export const legacyCatalogPresentationSchema = z.object({
  entityId: z.string().min(1),
  currentName: z.string().min(1),
  currentCreator: nullableText,
  currentCreatorIconKey: nullableText,
  currentLogoUrl: z.string().url().nullable(),
  iconOutcome: z.enum(["logo_url", "icon_key", "fallback"]),
});

export const catalogCorpusSchema = z.object({
  corpusVersion: z.literal(CATALOG_CORPUS_VERSION),
  generatedAt: isoTimestamp,
  observations: z.array(catalogObservationSchema),
  entities: z.array(catalogEntitySchema),
  decisions: z.array(catalogIdentityDecisionSchema),
  organizations: z.array(catalogOrganizationSchema),
  assets: z.array(catalogAssetSchema),
  providerRoutes: z.array(catalogProviderRouteSchema),
  benchmarkLinks: z.array(catalogBenchmarkLinkSchema),
  aliases: z.array(catalogAliasClaimSchema),
  sources: z.array(catalogSourceStateSchema),
  legacyPresentation: z.array(legacyCatalogPresentationSchema),
});

export const catalogApiProviderSchema = z.object({
  providerModelKey: z.string().min(1),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  providerIconKey: nullableText,
  rawModelId: z.string().min(1),
  pricing: z.object({
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    currency: z.literal("USD"),
    source: nullableText,
    fetchedAt: isoTimestamp.nullable(),
  }).strict(),
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), streaming: z.boolean() }).strict(),
  contextWindow: z.number().int().nonnegative().nullable(),
  maxOutput: z.number().int().nonnegative().nullable(),
  available: z.boolean(),
  accounts: z.array(z.object({
    id: z.string().min(1),
    nickname: nullableText,
  }).strict()),
}).strict();

export const catalogItemSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  nameProvenance: z.object({
    sourceId: nullableText,
    observationId: nullableText,
    sourceKind: z.enum(["reference_model", "provider_model", "benchmark_model", "reviewed_override", "fallback"]),
    originalValue: z.string().min(1),
    selectedValue: z.string().min(1),
    fetchedAt: isoTimestamp.nullable(),
    creatorPrefixRemoved: nullableText,
  }),
  creator: nullableText,
  creatorIconKey: nullableText,
  modelIconKey: nullableText,
  description: nullableText,
  contextWindow: z.number().int().nonnegative().nullable(),
  maxOutput: z.number().int().nonnegative().nullable(),
  capabilities: z.object({ reasoning: z.boolean(), vision: z.boolean(), tools: z.boolean(), streaming: z.boolean() }),
  referencePricing: z.object({
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    currency: z.literal("USD"),
    source: nullableText,
    fetchedAt: isoTimestamp.nullable(),
  }),
  providerCount: z.number().int().nonnegative(),
  availableProviderCount: z.number().int().nonnegative(),
  available: z.boolean(),
  providers: z.array(catalogApiProviderSchema),
  aliases: z.array(z.object({ source: z.string().min(1), alias: z.string().min(1), provenance: z.unknown() })),
  metadataSource: nullableText,
  metadataFetchedAt: isoTimestamp.nullable(),
  releasedAt: isoTimestamp.nullable(),
  organization: catalogOrganizationSchema.nullable(),
  asset: catalogAssetSchema.nullable(),
  routes: z.array(catalogProviderRouteSchema),
  benchmarks: z.array(catalogBenchmarkLinkSchema.extend({
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    fetchedAt: isoTimestamp,
    presentation: z.object({
      label: z.string().min(1),
      score: z.number().nullable(),
      rank: z.number().nullable(),
      effectiveRank: z.number().positive().nullable(),
      rankDerived: z.boolean(),
      population: z.number().int().positive().nullable(),
      percentile: z.number().min(0).max(1).nullable(),
      unit: z.enum(["points", "percent", "rank"]),
      higherIsBetter: z.boolean(),
    }),
  })),
  recommendedRanking: z.object({
    method: z.literal("mean_percentile"),
    rank: z.number().int().positive(),
    percentile: z.number().min(0).max(1),
    coverage: z.number().int().positive(),
    eligibleSources: z.number().int().positive(),
    sources: z.array(z.object({
      sourceId: z.string().min(1),
      sourceLabel: z.string().min(1),
      rank: z.number().positive(),
      publishedRank: z.number().positive().nullable(),
      rankDerived: z.boolean(),
      population: z.number().int().positive(),
      percentile: z.number().min(0).max(1),
      score: z.number().nullable(),
      attribution: z.string().nullable(),
    })),
  }).nullable(),
  supportedByActiveObservation: z.boolean(),
}).strict();

export const catalogResponseSchema = z.object({
  contractVersion: z.literal(CATALOG_CONTRACT_VERSION),
  snapshotId: z.string().min(1),
  generatedAt: isoTimestamp,
  items: z.array(catalogItemSchema),
  benchmarkDescriptors: z.array(benchmarkDescriptorSchema),
  ranking: z.object({
    sort: z.literal("recommended"),
    method: z.literal("mean_percentile"),
    sourceIds: z.array(z.string()),
  }),
  sources: z.array(catalogApiSourceStateSchema),
}).strict();

export type CatalogCorpus = z.infer<typeof catalogCorpusSchema>;
export type CatalogObservation = z.infer<typeof catalogObservationSchema>;
export type CatalogEntity = z.infer<typeof catalogEntitySchema>;
export type CatalogIdentityDecision = z.infer<typeof catalogIdentityDecisionSchema>;
export type CatalogSourceState = z.infer<typeof catalogSourceStateSchema>;
export type CatalogApiSourceState = z.infer<typeof catalogApiSourceStateSchema>;
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

export const CATALOG_INVARIANTS = Object.freeze([
  "Every visible entity is supported by at least one active observation.",
  "Every active provider route resolves to exactly one active entity.",
  "Source-native identifiers are unique within a source snapshot.",
  "Unknown values remain null and are never inferred from presentation fallbacks.",
  "Benchmark values retain source, license, fetch time, and source model provenance.",
  "Ambiguous observations remain unresolved until deterministic evidence or review resolves them.",
  "Canonical entity IDs and deep-link slugs remain stable across snapshot generations.",
  "Only a completely reconciled generation may become the active catalog snapshot.",
]);
