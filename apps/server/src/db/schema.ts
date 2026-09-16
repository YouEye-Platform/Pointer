import {
  pgTable,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
  date,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Users ─────────────────────────────────────────────────────
// No user_sessions table: auth is stateless JWT, not server-side sessions.

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("local"), // 'local' | 'service' | 'external'
  email: text("email").unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"), // 'admin' | 'user'
  externalIssuer: text("external_issuer"),
  externalSubject: text("external_subject"),
  state: text("state").notNull().default("active"), // 'active' | 'disabled'
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check("users_kind_check", sql`${t.kind} in ('local', 'service', 'external')`),
  check("users_role_check", sql`${t.role} in ('admin', 'user')`),
  check("users_state_check", sql`${t.state} in ('active', 'disabled')`),
  check(
    "users_local_credentials_check",
    sql`(${t.kind} <> 'local') or (${t.email} is not null and ${t.passwordHash} is not null)`
  ),
  check(
    "users_service_password_check",
    sql`(${t.kind} <> 'service') or ${t.passwordHash} is null`
  ),
  check(
    "users_external_identity_check",
    sql`(${t.kind} = 'external' and ${t.externalIssuer} is not null and ${t.externalSubject} is not null)
      or (${t.kind} <> 'external' and ${t.externalIssuer} is null and ${t.externalSubject} is null)`
  ),
  uniqueIndex("idx_users_external_identity")
    .on(t.externalIssuer, t.externalSubject)
    .where(sql`${t.externalIssuer} is not null and ${t.externalSubject} is not null`),
]);

// ── Providers ─────────────────────────────────────────────────

export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'openai-compatible' | 'anthropic-compatible' | 'custom'
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type").default("bearer"), // 'bearer' | 'header' | 'query' | 'oauth-device-flow' | 'none'
  authHeader: text("auth_header"),
  modelsEndpoint: text("models_endpoint"),
  balanceEndpoint: text("balance_endpoint"),
  balanceParser: jsonb("balance_parser"), // { path, currency, subtractPath }
  balancePollInterval: integer("balance_poll_interval"), // seconds
  status: text("status").notNull().default("active"), // 'active' | 'error' | 'disabled'
  currentBalance: numeric("current_balance"),
  balanceUpdatedAt: timestamp("balance_updated_at", { withTimezone: true }),
  isBuiltin: boolean("is_builtin").default(false),
  manifestPath: text("manifest_path"),
  extraHeaders: jsonb("extra_headers"), // Record<string, string>
  handlerId: text("handler_id"), // references a handler in providers.d/_handlers/
  handlerConfig: jsonb("handler_config"), // arbitrary config passed to handler
  rateLimitData: jsonb("rate_limit_data"), // cached rate limit headers from proxy responses
  rateLimitUpdatedAt: timestamp("rate_limit_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// A provider is a reusable protocol definition. An account is one user's
// concrete credential and optional endpoint override. Keeping these separate
// lets a user connect the same provider more than once without duplicating the
// global catalog or exposing account nicknames through the inference API.
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "restrict" }),
    nickname: text("nickname"),
    baseUrl: text("base_url"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_provider_accounts_user_nickname")
      .on(t.userId, t.nickname)
      .where(sql`${t.nickname} is not null`),
    index("idx_provider_accounts_user_provider").on(t.userId, t.providerId),
    check("provider_accounts_status_check", sql`${t.status} in ('active', 'disabled', 'error')`),
  ]
);

// ── Provider Keys ─────────────────────────────────────────────

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    providerAccountId: text("provider_account_id").references(() => providerAccounts.id, { onDelete: "cascade" }),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    adminKeyEncrypted: text("admin_key_encrypted"), // optional admin/management key
    label: text("label"),
    isShared: boolean("is_shared").default(false),
    sharedModels: jsonb("shared_models"), // null = all, ["claude-*"] = specific glob patterns
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_provider_keys_user").on(t.userId),
    index("idx_provider_keys_provider").on(t.providerId),
    uniqueIndex("idx_provider_keys_account")
      .on(t.providerAccountId)
      .where(sql`${t.providerAccountId} is not null`),
  ]
);

export const providerKeyShares = pgTable(
  "provider_key_shares",
  {
    id: text("id").primaryKey(),
    providerKeyId: text("provider_key_id")
      .notNull()
      .references(() => providerKeys.id, { onDelete: "cascade" }),
    sharedWithUserId: text("shared_with_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_share_unique").on(t.providerKeyId, t.sharedWithUserId)]
);

export const providerOAuthDeviceFlows = pgTable(
  "provider_oauth_device_flows",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    providerAccountId: text("provider_account_id").references(() => providerAccounts.id, { onDelete: "cascade" }),
    deviceCodeEncrypted: text("device_code_encrypted").notNull(),
    userCode: text("user_code").notNull(),
    verificationUri: text("verification_uri").notNull(),
    verificationUriComplete: text("verification_uri_complete"),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_provider_oauth_device_user_provider").on(t.userId, t.providerId),
    index("idx_provider_oauth_device_account").on(t.providerAccountId),
    index("idx_provider_oauth_device_expires").on(t.expiresAt),
    check(
      "provider_oauth_device_status_check",
      sql`${t.status} in ('pending', 'denied', 'expired')`
    ),
  ]
);

export const providerOperationalStates = pgTable(
  "provider_operational_states",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    balance: numeric("balance"),
    balanceCurrency: text("balance_currency"),
    balanceStatus: text("balance_status").notNull().default("never_synced"),
    balanceError: text("balance_error"),
    balanceUpdatedAt: timestamp("balance_updated_at", { withTimezone: true }),
    rateLimitData: jsonb("rate_limit_data"),
    rateLimitUpdatedAt: timestamp("rate_limit_updated_at", { withTimezone: true }),
    accountData: jsonb("account_data"),
    accountStatus: text("account_status").notNull().default("never_synced"),
    accountError: text("account_error"),
    accountUpdatedAt: timestamp("account_updated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("idx_provider_operational_user_provider").on(t.userId, t.providerId)]
);

// ── Model Catalog ─────────────────────────────────────────────

export const modelCatalog = pgTable("model_catalog", {
  modelId: text("model_id").primaryKey(),
  canonicalSlug: text("canonical_slug").unique(),
  name: text("name").notNull(),
  creator: text("creator"),
  creatorIconKey: text("creator_icon_key"),
  description: text("description"),
  contextWindow: integer("context_window"),
  maxOutput: integer("max_output"),
  isReasoning: boolean("is_reasoning").default(false),
  supportsVision: boolean("supports_vision").default(false),
  supportsTools: boolean("supports_tools").default(false),
  supportsStreaming: boolean("supports_streaming").default(true),
  arenaElo: integer("arena_elo"),
  codingScore: numeric("coding_score"),
  qualityScore: numeric("quality_score"),
  logoUrl: text("logo_url"),
  releaseDate: date("release_date"),
  referenceInputPrice: numeric("reference_input_price"),
  referenceOutputPrice: numeric("reference_output_price"),
  metadataSource: text("metadata_source"),
  metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true }),
  rawMetadata: jsonb("raw_metadata"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const modelAliases = pgTable(
  "model_aliases",
  {
    id: text("id").primaryKey(),
    canonicalModelId: text("canonical_model_id").notNull().references(() => modelCatalog.modelId, { onDelete: "cascade" }),
    source: text("source").notNull(),
    alias: text("alias").notNull(),
    normalizedLight: text("normalized_light").notNull(),
    normalizedAggressive: text("normalized_aggressive").notNull(),
    isExplicit: boolean("is_explicit").notNull().default(false),
    provenance: jsonb("provenance"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_model_alias_source_alias").on(t.source, t.alias),
    index("idx_model_alias_canonical").on(t.canonicalModelId),
    index("idx_model_alias_light").on(t.normalizedLight),
    index("idx_model_alias_aggressive").on(t.normalizedAggressive),
  ]
);

export const benchmarkMetrics = pgTable(
  "benchmark_metrics",
  {
    id: text("id").primaryKey(),
    canonicalModelId: text("canonical_model_id").references(() => modelCatalog.modelId, { onDelete: "set null" }),
    catalogObservationId: text("catalog_observation_id").references(() => modelObservations.id, { onDelete: "set null" }),
    catalogEntityId: text("catalog_entity_id").references(() => modelEntities.id, { onDelete: "set null" }),
    benchmarkId: text("benchmark_id").notNull(),
    sourceModel: text("source_model").notNull(),
    metrics: jsonb("metrics").notNull(),
    provenance: jsonb("provenance").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_benchmark_source_model").on(t.benchmarkId, t.sourceModel),
    index("idx_benchmark_canonical").on(t.canonicalModelId),
    index("idx_benchmark_catalog_observation").on(t.catalogObservationId),
    index("idx_benchmark_catalog_entity").on(t.catalogEntityId),
  ]
);

export const providerModels = pgTable(
  "provider_models",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    displayName: text("display_name"),
    canonicalModelId: text("canonical_model_id").references(() => modelCatalog.modelId, { onDelete: "set null" }),
    catalogObservationId: text("catalog_observation_id").references(() => modelObservations.id, { onDelete: "set null" }),
    catalogEntityId: text("catalog_entity_id").references(() => modelEntities.id, { onDelete: "set null" }),
    providerModelId: text("provider_model_id").notNull(),
    inputPrice: numeric("input_price"),
    outputPrice: numeric("output_price"),
    contextWindow: integer("context_window"),
    maxOutput: integer("max_output"),
    supportsStreaming: boolean("supports_streaming").default(true),
    supportsTools: boolean("supports_tools").default(false),
    supportsVision: boolean("supports_vision").default(false),
    nativeFormat: text("native_format"),
    nativeEndpoint: text("native_endpoint"),
    priceSource: text("price_source"),
    priceFetchedAt: timestamp("price_fetched_at", { withTimezone: true }),
    rawMetadata: jsonb("raw_metadata"),
  },
  (t) => [
    uniqueIndex("idx_provider_model_unique").on(t.providerId, t.modelId),
    index("idx_provider_models_model").on(t.modelId),
    index("idx_provider_models_catalog_observation").on(t.catalogObservationId),
    index("idx_provider_models_catalog_entity").on(t.catalogEntityId),
    check(
      "provider_models_native_format_check",
      sql`${t.nativeFormat} is null or ${t.nativeFormat} in ('chat-completions', 'messages', 'responses', 'google-generate-content')`
    ),
    check(
      "provider_models_native_endpoint_check",
      sql`${t.nativeEndpoint} is null or (${t.nativeEndpoint} like '/%' and ${t.nativeEndpoint} not like '//%')`
    ),
  ]
);

// The provider catalog is shared, but availability is account-specific. This
// mapping prevents one custom endpoint or subscription tier from making a
// model appear usable through another account that never reported it.
export const providerAccountModels = pgTable(
  "provider_account_models",
  {
    id: text("id").primaryKey(),
    providerAccountId: text("provider_account_id").notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    providerModelId: text("provider_model_id").notNull()
      .references(() => providerModels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_provider_account_models_unique").on(t.providerAccountId, t.providerModelId),
    index("idx_provider_account_models_model").on(t.providerModelId),
  ]
);

// Generic upstream snapshots. Source-specific failures never delete the last successful records.
export const sourceSyncStates = pgTable("source_sync_states", {
  sourceId: text("source_id").primaryKey(),
  status: text("status").notNull().default("never_synced"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  recordCount: integer("record_count").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sourceRecords = pgTable(
  "source_records",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => sourceSyncStates.sourceId, { onDelete: "cascade" }),
    recordKey: text("record_key").notNull(),
    kind: text("kind").notNull(), // 'reference_model' | 'benchmark'
    payload: jsonb("payload").notNull(),
    provenance: jsonb("provenance").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_source_record_unique").on(t.sourceId, t.recordKey),
    index("idx_source_records_source").on(t.sourceId),
    index("idx_source_records_kind").on(t.kind),
  ]
);

// ── Canonical catalog persistence ─────────────────────────────
// Generation-scoped catalog tables are authoritative.

export const catalogGenerations = pgTable(
  "catalog_generations",
  {
    id: text("id").primaryKey(),
    parentGenerationId: text("parent_generation_id"),
    state: text("state").notNull().default("building"),
    resolverVersion: text("resolver_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    stats: jsonb("stats").notNull().default({}),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_catalog_generations_state").on(t.state),
    index("idx_catalog_generation_parent").on(t.parentGenerationId),
    uniqueIndex("idx_catalog_generation_active").on(sql`(true)`).where(sql`${t.state} = 'active'`),
    check("chk_catalog_generation_state", sql`${t.state} in ('building', 'ready', 'active', 'failed', 'retired')`),
    foreignKey({
      name: "fk_catalog_generation_parent",
      columns: [t.parentGenerationId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
  ]
);

export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").references(() => catalogGenerations.id, { onDelete: "set null" }),
    sourceId: text("source_id").notNull().references(() => sourceSyncStates.sourceId, { onDelete: "restrict" }),
    revision: text("revision").notNull(),
    sourceUrl: text("source_url").notNull(),
    license: text("license").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    recordCount: integer("record_count").notNull(),
    contentHash: text("content_hash").notNull(),
    state: text("state").notNull().default("staged"),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_source_snapshot_revision").on(t.sourceId, t.revision),
    uniqueIndex("idx_source_snapshot_id_source").on(t.id, t.sourceId),
    uniqueIndex("idx_source_snapshot_one_active").on(t.sourceId).where(sql`${t.active}`),
    index("idx_source_snapshot_generation").on(t.generationId),
    index("idx_source_snapshot_active").on(t.sourceId, t.active),
    check("chk_source_snapshot_state", sql`${t.state} in ('staged', 'validated', 'active', 'failed', 'retired')`),
    check("chk_source_snapshot_record_count", sql`${t.recordCount} >= 0`),
  ]
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    websiteUrl: text("website_url"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_organizations_canonical_name").on(t.canonicalName), index("idx_organizations_active").on(t.active)]
);

export const organizationAliases = pgTable(
  "organization_aliases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    provenance: jsonb("provenance"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_organization_alias_unique").on(t.organizationId, t.normalizedAlias),
    index("idx_organization_alias_normalized").on(t.normalizedAlias),
  ]
);

export const catalogAssets = pgTable(
  "catalog_assets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    originUrl: text("origin_url").notNull(),
    license: text("license").notNull(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    validationState: text("validation_state").notNull().default("pending"),
    validationError: text("validation_error"),
    cachePath: text("cache_path"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_asset_id_organization").on(t.id, t.organizationId),
    uniqueIndex("idx_catalog_asset_content").on(t.organizationId, t.kind, t.contentHash),
    uniqueIndex("idx_catalog_asset_one_active").on(t.organizationId, t.kind).where(sql`${t.active}`),
    index("idx_catalog_asset_active").on(t.organizationId, t.kind, t.active),
    check("chk_catalog_asset_kind", sql`${t.kind} in ('icon', 'logo')`),
    check("chk_catalog_asset_mime", sql`${t.mimeType} like 'image/%'`),
    check("chk_catalog_asset_validation", sql`${t.validationState} in ('pending', 'valid', 'invalid')`),
    check("chk_catalog_asset_size", sql`${t.byteSize} >= 0`),
    check("chk_catalog_asset_width", sql`${t.width} is null or ${t.width} > 0`),
    check("chk_catalog_asset_height", sql`${t.height} is null or ${t.height} > 0`),
  ]
);

export const modelEntities = pgTable(
  "model_entities",
  {
    id: text("id").primaryKey(),
    stableSlug: text("stable_slug").notNull(),
    preferredName: text("preferred_name").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_model_entity_stable_slug").on(t.stableSlug),
    index("idx_model_entity_organization").on(t.organizationId),
    index("idx_model_entity_active").on(t.active),
  ]
);

export const modelObservations = pgTable(
  "model_observations",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id").notNull().references(() => sourceSnapshots.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    nativeId: text("native_id").notNull(),
    rawName: text("raw_name"),
    namespace: text("namespace"),
    attributes: jsonb("attributes").notNull().default({}),
    rawPayload: jsonb("raw_payload").notNull(),
    provenance: jsonb("provenance").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_model_observation_native").on(t.sourceId, t.snapshotId, t.nativeId),
    uniqueIndex("idx_model_observation_id_snapshot").on(t.id, t.snapshotId),
    index("idx_model_observation_snapshot").on(t.snapshotId),
    index("idx_model_observation_source_active").on(t.sourceId, t.active),
    index("idx_model_observation_native_lookup").on(t.sourceId, t.nativeId),
    check("chk_model_observation_kind", sql`${t.kind} in ('reference_model', 'provider_model', 'benchmark_model')`),
  ]
);

export const observationEntityLinks = pgTable(
  "observation_entity_links",
  {
    id: text("id").primaryKey(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    resolverVersion: text("resolver_version").notNull(),
    decisionState: text("decision_state").notNull().default("linked"),
    reviewState: text("review_state").notNull().default("unreviewed"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_observation_entity_link_observation").on(t.observationId),
    index("idx_observation_entity_link_entity").on(t.entityId),
    check("chk_observation_link_confidence", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    check("chk_observation_link_method", sql`${t.method} in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')`),
    check("chk_observation_link_decision", sql`${t.decisionState} in ('linked', 'rejected')`),
    check("chk_observation_link_review", sql`${t.reviewState} in ('unreviewed', 'approved', 'rejected')`),
  ]
);

export const identityClaims = pgTable(
  "identity_claims",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "cascade" }),
    sourceId: text("source_id"),
    claimType: text("claim_type").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    provenance: jsonb("provenance"),
    state: text("state").notNull().default("proposed"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_identity_claim_lookup").on(t.claimType, t.normalizedValue, t.state),
    index("idx_identity_claim_entity").on(t.entityId),
    uniqueIndex("idx_identity_claim_unique").on(t.entityId, sql`coalesce(${t.sourceId}, '')`, t.claimType, t.normalizedValue),
    check("chk_identity_claim_type", sql`${t.claimType} in ('native_id', 'alias', 'name', 'crosswalk')`),
    check("chk_identity_claim_state", sql`${t.state} in ('proposed', 'approved', 'rejected')`),
  ]
);

export const resolverRuns = pgTable(
  "resolver_runs",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").references(() => catalogGenerations.id, { onDelete: "set null" }),
    resolverVersion: text("resolver_version").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    stats: jsonb("stats").notNull().default({}),
    error: text("error"),
  },
  (t) => [index("idx_resolver_run_generation").on(t.generationId), check("chk_resolver_run_status", sql`${t.status} in ('running', 'completed', 'failed')`)]
);

export const resolverDecisions = pgTable(
  "resolver_decisions",
  {
    id: text("id").primaryKey(),
    resolverRunId: text("resolver_run_id").notNull().references(() => resolverRuns.id, { onDelete: "cascade" }),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "cascade" }),
    entityId: text("entity_id").references(() => modelEntities.id, { onDelete: "set null" }),
    state: text("state").notNull(),
    method: text("method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    candidateEntityIds: jsonb("candidate_entity_ids").notNull().default([]),
    evidence: jsonb("evidence").notNull().default([]),
    blockers: jsonb("blockers").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_resolver_decision_run_observation").on(t.resolverRunId, t.observationId),
    index("idx_resolver_decision_state").on(t.state),
    index("idx_resolver_decision_entity").on(t.entityId),
    check("chk_resolver_decision_state", sql`${t.state} in ('linked', 'ambiguous', 'unresolved', 'rejected')`),
    check("chk_resolver_decision_method", sql`${t.method} in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')`),
    check("chk_resolver_decision_confidence", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ]
);

export const catalogGenerationSnapshots = pgTable(
  "catalog_generation_snapshots",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull().references(() => sourceSnapshots.id, { onDelete: "restrict" }),
    sourceId: text("source_id").notNull(),
    sourceState: jsonb("source_state").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_snapshot_unique").on(t.generationId, t.snapshotId),
    uniqueIndex("idx_catalog_generation_source_unique").on(t.generationId, t.sourceId),
    index("idx_catalog_generation_snapshot_snapshot").on(t.snapshotId),
    foreignKey({
      name: "fk_catalog_generation_snapshot_source",
      columns: [t.snapshotId, t.sourceId],
      foreignColumns: [sourceSnapshots.id, sourceSnapshots.sourceId],
    }).onDelete("restrict"),
  ]
);

export const catalogGenerationOrganizations = pgTable(
  "catalog_generation_organizations",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    canonicalName: text("canonical_name").notNull(),
    websiteUrl: text("website_url"),
    aliases: jsonb("aliases").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_catalog_generation_organization_unique").on(t.generationId, t.organizationId)]
);

export const catalogGenerationEntities = pgTable(
  "catalog_generation_entities",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "restrict" }),
    preferredName: text("preferred_name").notNull(),
    nameProvenance: jsonb("name_provenance").notNull().default({}),
    stableSlug: text("stable_slug").notNull(),
    organizationId: text("organization_id"),
    description: text("description"),
    contextWindow: integer("context_window"),
    maxOutput: integer("max_output"),
    supportsTools: boolean("supports_tools").notNull(),
    supportsVision: boolean("supports_vision").notNull(),
    supportsStreaming: boolean("supports_streaming").notNull(),
    referenceInputPrice: numeric("reference_input_price"),
    referenceOutputPrice: numeric("reference_output_price"),
    metadataSource: text("metadata_source").notNull(),
    metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    rawMetadata: jsonb("raw_metadata").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_entity_unique").on(t.generationId, t.entityId),
    uniqueIndex("idx_catalog_generation_slug_unique").on(t.generationId, t.stableSlug),
    index("idx_catalog_generation_entity_entity").on(t.entityId),
    check("chk_catalog_generation_entity_context", sql`${t.contextWindow} is null or ${t.contextWindow} >= 0`),
    check("chk_catalog_generation_entity_output", sql`${t.maxOutput} is null or ${t.maxOutput} >= 0`),
    check("chk_catalog_generation_entity_input_price", sql`${t.referenceInputPrice} is null or ${t.referenceInputPrice} >= 0`),
    check("chk_catalog_generation_entity_output_price", sql`${t.referenceOutputPrice} is null or ${t.referenceOutputPrice} >= 0`),
    check("chk_catalog_generation_entity_source", sql`${t.metadataSource} in ('openrouter', 'provider', 'benchmark')`),
    foreignKey({
      name: "fk_catalog_generation_entity_organization",
      columns: [t.generationId, t.organizationId],
      foreignColumns: [catalogGenerationOrganizations.generationId, catalogGenerationOrganizations.organizationId],
    }).onDelete("restrict"),
  ]
);

export const catalogGenerationObservationLinks = pgTable(
  "catalog_generation_observation_links",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "restrict" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_observation_unique").on(t.generationId, t.observationId),
    uniqueIndex("idx_catalog_generation_observation_entity_unique").on(t.generationId, t.observationId, t.entityId),
    index("idx_catalog_generation_observation_entity").on(t.generationId, t.entityId),
    check("chk_catalog_generation_link_method", sql`${t.method} in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')`),
    check("chk_catalog_generation_link_confidence", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    foreignKey({
      name: "fk_catalog_generation_link_snapshot",
      columns: [t.generationId, t.snapshotId],
      foreignColumns: [catalogGenerationSnapshots.generationId, catalogGenerationSnapshots.snapshotId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_catalog_generation_link_observation",
      columns: [t.observationId, t.snapshotId],
      foreignColumns: [modelObservations.id, modelObservations.snapshotId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_catalog_generation_link_entity",
      columns: [t.generationId, t.entityId],
      foreignColumns: [catalogGenerationEntities.generationId, catalogGenerationEntities.entityId],
    }).onDelete("cascade"),
  ]
);

export const catalogGenerationDecisions = pgTable(
  "catalog_generation_decisions",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "restrict" }),
    entityId: text("entity_id").references(() => modelEntities.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    method: text("method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    score: numeric("score").notNull(),
    margin: numeric("margin").notNull(),
    candidateEntityIds: jsonb("candidate_entity_ids").notNull().default([]),
    evidence: jsonb("evidence").notNull().default([]),
    blockers: jsonb("blockers").notNull().default([]),
    resolverVersion: text("resolver_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_decision_unique").on(t.generationId, t.observationId),
    index("idx_catalog_generation_decision_state").on(t.generationId, t.state),
    check("chk_catalog_generation_decision_state", sql`${t.state} in ('linked', 'ambiguous', 'unresolved', 'rejected')`),
    check("chk_catalog_generation_decision_method", sql`${t.method} in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')`),
    check("chk_catalog_generation_decision_confidence", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    foreignKey({
      name: "fk_catalog_generation_decision_snapshot",
      columns: [t.generationId, t.snapshotId],
      foreignColumns: [catalogGenerationSnapshots.generationId, catalogGenerationSnapshots.snapshotId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_catalog_generation_decision_observation",
      columns: [t.observationId, t.snapshotId],
      foreignColumns: [modelObservations.id, modelObservations.snapshotId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_catalog_generation_decision_entity",
      columns: [t.generationId, t.entityId],
      foreignColumns: [catalogGenerationEntities.generationId, catalogGenerationEntities.entityId],
    }).onDelete("restrict"),
  ]
);

export const catalogGenerationAliases = pgTable(
  "catalog_generation_aliases",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    alias: text("alias").notNull(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "restrict" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_alias_unique").on(t.generationId, t.sourceId, t.alias, t.entityId),
    foreignKey({
      name: "fk_catalog_generation_alias_link",
      columns: [t.generationId, t.observationId, t.entityId],
      foreignColumns: [catalogGenerationObservationLinks.generationId, catalogGenerationObservationLinks.observationId, catalogGenerationObservationLinks.entityId],
    }).onDelete("cascade"),
  ]
);

export const catalogGenerationProviderRoutes = pgTable(
  "catalog_generation_provider_routes",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    providerModelId: text("provider_model_id").notNull(),
    providerId: text("provider_id").notNull(),
    rawModelId: text("raw_model_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "restrict" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "restrict" }),
    inputPrice: numeric("input_price"),
    outputPrice: numeric("output_price"),
    contextWindow: integer("context_window"),
    maxOutput: integer("max_output"),
    supportsTools: boolean("supports_tools").notNull(),
    supportsVision: boolean("supports_vision").notNull(),
    supportsStreaming: boolean("supports_streaming").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_provider_model_unique").on(t.generationId, t.providerModelId),
    uniqueIndex("idx_catalog_generation_provider_raw_unique").on(t.generationId, t.providerId, t.rawModelId),
    index("idx_catalog_generation_provider_entity").on(t.generationId, t.entityId),
    check("chk_catalog_generation_route_input_price", sql`${t.inputPrice} is null or ${t.inputPrice} >= 0`),
    check("chk_catalog_generation_route_output_price", sql`${t.outputPrice} is null or ${t.outputPrice} >= 0`),
    check("chk_catalog_generation_route_context", sql`${t.contextWindow} is null or ${t.contextWindow} >= 0`),
    check("chk_catalog_generation_route_output", sql`${t.maxOutput} is null or ${t.maxOutput} >= 0`),
    foreignKey({
      name: "fk_catalog_generation_route_link",
      columns: [t.generationId, t.observationId, t.entityId],
      foreignColumns: [catalogGenerationObservationLinks.generationId, catalogGenerationObservationLinks.observationId, catalogGenerationObservationLinks.entityId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_catalog_generation_route_observation",
      columns: [t.observationId, t.snapshotId],
      foreignColumns: [modelObservations.id, modelObservations.snapshotId],
    }).onDelete("restrict"),
  ]
);

export const catalogGenerationBenchmarkLinks = pgTable(
  "catalog_generation_benchmark_links",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    benchmarkId: text("benchmark_id").notNull(),
    sourceModel: text("source_model").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    observationId: text("observation_id").notNull().references(() => modelObservations.id, { onDelete: "restrict" }),
    entityId: text("entity_id").notNull().references(() => modelEntities.id, { onDelete: "restrict" }),
    metrics: jsonb("metrics").notNull(),
    provenance: jsonb("provenance").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_benchmark_unique").on(t.generationId, t.benchmarkId, t.sourceModel),
    index("idx_catalog_generation_benchmark_entity").on(t.generationId, t.entityId),
    foreignKey({
      name: "fk_catalog_generation_benchmark_link",
      columns: [t.generationId, t.observationId, t.entityId],
      foreignColumns: [catalogGenerationObservationLinks.generationId, catalogGenerationObservationLinks.observationId, catalogGenerationObservationLinks.entityId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_catalog_generation_benchmark_observation",
      columns: [t.observationId, t.snapshotId],
      foreignColumns: [modelObservations.id, modelObservations.snapshotId],
    }).onDelete("restrict"),
  ]
);

export const catalogGenerationAssets = pgTable(
  "catalog_generation_assets",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull().references(() => catalogGenerations.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => catalogAssets.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").notNull(),
    kind: text("kind").notNull(),
    originUrl: text("origin_url").notNull(),
    license: text("license").notNull(),
    contentHash: text("content_hash").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    validationState: text("validation_state").notNull(),
    cachePath: text("cache_path"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_catalog_generation_asset_unique").on(t.generationId, t.assetId),
    check("chk_catalog_generation_asset_kind", sql`${t.kind} in ('icon', 'logo')`),
    check("chk_catalog_generation_asset_mime", sql`${t.mimeType} like 'image/%'`),
    check("chk_catalog_generation_asset_size", sql`${t.byteSize} >= 0`),
    foreignKey({
      name: "fk_catalog_generation_asset_organization",
      columns: [t.generationId, t.organizationId],
      foreignColumns: [catalogGenerationOrganizations.generationId, catalogGenerationOrganizations.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_catalog_generation_asset_owner",
      columns: [t.assetId, t.organizationId],
      foreignColumns: [catalogAssets.id, catalogAssets.organizationId],
    }).onDelete("restrict"),
  ]
);

// ── Model Groups ─────────────────────────────────────────────

export const modelGroups = pgTable(
  "model_groups",
  {
    id: text("id").primaryKey(), // grp_<nanoid(12)>
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_model_groups_user").on(t.userId),
    uniqueIndex("idx_model_groups_one_default")
      .on(t.userId)
      .where(sql`${t.isDefault} = true`),
  ]
);

export const modelGroupEntries = pgTable(
  "model_group_entries",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => modelGroups.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id").references(() => providerAccounts.id, { onDelete: "restrict" }),
    catalogEntityId: text("catalog_entity_id").references(() => modelEntities.id, { onDelete: "set null" }),
    providerModelKey: text("provider_model_key").references(() => providerModels.id, { onDelete: "set null" }),
    alias: text("alias"),
    enabled: boolean("enabled").default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_group_entry_route_unique")
      .on(t.groupId, t.providerModelKey, t.providerAccountId)
      .where(sql`${t.providerModelKey} is not null and ${t.providerAccountId} is not null`),
    uniqueIndex("idx_group_entry_alias_unique")
      .on(t.groupId, sql`lower(btrim(${t.alias}))`)
      .where(sql`${t.alias} is not null`),
    uniqueIndex("idx_group_entry_position_unique").on(t.groupId, t.position),
    index("idx_group_entries_group").on(t.groupId),
    index("idx_group_entries_provider_account").on(t.providerAccountId),
    check("chk_group_entry_position_nonnegative", sql`${t.position} >= 0`),
  ]
);

// ── Instances ─────────────────────────────────────────────────

export const instances = pgTable("instances", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").default("{}"),
  color: text("color").default("#3B82F6"),
  modelGroupId: text("model_group_id").references(() => modelGroups.id, { onDelete: "set null" }),
  origin: text("origin").notNull().default("local"), // 'local' | 'managed'
  state: text("state").notNull().default("active"), // 'active' | 'disabled' | 'archived'
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check("instances_origin_check", sql`${t.origin} in ('local', 'managed')`),
  check("instances_state_check", sql`${t.state} in ('active', 'disabled', 'archived')`),
]);

export const instanceModels = pgTable(
  "instance_models",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id")
      .references(() => providerAccounts.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").default(true),
    isDefault: boolean("is_default").default(false),
    priority: integer("priority").default(0),
    alias: text("alias"),
    source: text("source").default("custom"), // 'custom' | 'provider'
  },
  (t) => [
    uniqueIndex("idx_instance_model_provider").on(t.instanceId, t.modelId, t.providerId),
    index("idx_instance_models_instance").on(t.instanceId),
    index("idx_instance_models_provider_account").on(t.providerAccountId),
  ]
);

// ── API Keys ──────────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(),
    keyPreview: text("key_preview").notNull(),
    name: text("name").notNull(),
    allowedModels: jsonb("allowed_models").default(["*"]),
    fallbackProviderId: text("fallback_provider_id"),
    scopes: jsonb("scopes").default(["read", "write"]),
    purpose: text("purpose").notNull().default("local_operator"),
    lifecycle: text("lifecycle").notNull().default("active"),
    managedInstallationId: text("managed_installation_id"),
    generation: integer("generation").notNull().default(1),
    replacementOfKeyId: text("replacement_of_key_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsed: timestamp("last_used", { withTimezone: true }),
    requestCount: integer("request_count").default(0),
    revoked: boolean("revoked").default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_api_keys_user").on(t.userId),
    index("idx_api_keys_instance").on(t.instanceId),
    index("idx_api_keys_managed_installation").on(t.managedInstallationId),
    check(
      "api_keys_purpose_check",
      sql`${t.purpose} in ('local_operator', 'internal_test', 'managed_application')`
    ),
    check(
      "api_keys_lifecycle_check",
      sql`${t.lifecycle} in ('active', 'pending', 'retired')`
    ),
    check("api_keys_generation_check", sql`${t.generation} > 0`),
  ]
);

// ── Managed platform integration ─────────────────────────────

export const platformIntegrations = pgTable(
  "platform_integrations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    externalServerId: text("external_server_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expectedIssuer: text("expected_issuer").notNull(),
    expectedAudience: text("expected_audience").notNull(),
    expectedSubject: text("expected_subject").notNull(),
    state: text("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    lastReadyAt: timestamp("last_ready_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_platform_integrations_server").on(t.externalServerId),
    uniqueIndex("idx_platform_integrations_owner").on(t.ownerUserId),
    check("platform_integrations_state_check", sql`${t.state} in ('active', 'disabled')`),
  ]
);

export const managedAppInstallations = pgTable(
  "managed_app_installations",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => platformIntegrations.id, { onDelete: "restrict" }),
    externalInstallationId: text("external_installation_id").notNull(),
    appId: text("app_id").notNull(),
    displayName: text("display_name").notNull(),
    routingOwnerUserId: text("routing_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "restrict" }),
    activeApiKeyId: text("active_api_key_id"),
    pendingApiKeyId: text("pending_api_key_id"),
    state: text("state").notNull().default("provisioning"),
    appVersion: text("app_version"),
    adapterRevision: text("adapter_revision"),
    lastReconciliationResult: jsonb("last_reconciliation_result"),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    historicalGroupId: text("historical_group_id"),
    historicalGroupName: text("historical_group_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_managed_installation_external")
      .on(t.integrationId, t.externalInstallationId),
    uniqueIndex("idx_managed_installation_instance").on(t.instanceId),
    index("idx_managed_installation_routing_owner").on(t.routingOwnerUserId),
    foreignKey({
      columns: [t.activeApiKeyId],
      foreignColumns: [apiKeys.id],
      name: "managed_installation_active_key_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.pendingApiKeyId],
      foreignColumns: [apiKeys.id],
      name: "managed_installation_pending_key_fk",
    }).onDelete("restrict"),
    check(
      "managed_installation_distinct_keys_check",
      sql`${t.activeApiKeyId} is null or ${t.activeApiKeyId} <> ${t.pendingApiKeyId}`
    ),
    check(
      "managed_installation_state_check",
      sql`${t.state} in ('provisioning', 'active', 'rotating', 'disabled', 'archived', 'error')`
    ),
  ]
);

export const credentialDeliveries = pgTable(
  "credential_deliveries",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => platformIntegrations.id, { onDelete: "restrict" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => managedAppInstallations.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    mutationKeyHash: text("mutation_key_hash").notNull(),
    payloadEncrypted: text("payload_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_credential_delivery_key").on(t.apiKeyId),
    index("idx_credential_delivery_expiry").on(t.expiresAt),
  ]
);

export const managedKeyRotations = pgTable(
  "managed_key_rotations",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => managedAppInstallations.id, { onDelete: "cascade" }),
    previousKeyId: text("previous_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    pendingKeyId: text("pending_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => credentialDeliveries.id, { onDelete: "restrict" }),
    state: text("state").notNull().default("prepared"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    abortedAt: timestamp("aborted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_managed_rotation_pending_key").on(t.pendingKeyId),
    check(
      "managed_rotation_state_check",
      sql`${t.state} in ('prepared', 'committed', 'aborted')`
    ),
  ]
);

export const platformIdempotency = pgTable(
  "platform_idempotency",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => platformIntegrations.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull().default("completed"),
    resultStatus: integer("result_status"),
    resultBody: jsonb("result_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_platform_idempotency_key")
      .on(t.integrationId, t.action, t.idempotencyKeyHash),
    index("idx_platform_idempotency_expiry").on(t.expiresAt),
    check("platform_idempotency_state_check", sql`${t.state} in ('completed', 'failed')`),
  ]
);

export const platformAssertionReplays = pgTable(
  "platform_assertion_replays",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => platformIntegrations.id, { onDelete: "cascade" }),
    jtiHash: text("jti_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_platform_assertion_replay").on(t.integrationId, t.jtiHash),
    index("idx_platform_assertion_replay_expiry").on(t.expiresAt),
  ]
);

export const managementAudit = pgTable(
  "management_audit",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => platformIntegrations.id, { onDelete: "restrict" }),
    actorIssuer: text("actor_issuer").notNull(),
    actorSubject: text("actor_subject").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    oldState: jsonb("old_state"),
    newState: jsonb("new_state"),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    buildCommit: text("build_commit"),
    contractVersion: text("contract_version").notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_management_audit_created").on(t.createdAt),
    index("idx_management_audit_integration").on(t.integrationId),
    check("management_audit_outcome_check", sql`${t.outcome} in ('success', 'failure')`),
  ]
);

export const pointerSchemaVersions = pgTable("pointer_schema_versions", {
  version: integer("version").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Usage Logs ────────────────────────────────────────────────

export const usageLogs = pgTable(
  "usage_logs",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    userId: text("user_id").notNull().references(() => users.id),
    modelId: text("model_id").notNull(),
    catalogEntityId: text("catalog_entity_id").references(() => modelEntities.id, { onDelete: "set null" }),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id")
      .references(() => providerAccounts.id, { onDelete: "set null" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"), // prompt cache hits (OpenAI)
    reasoningTokens: integer("reasoning_tokens"), // tokens spent on reasoning/thinking
    cacheCreationTokens: integer("cache_creation_tokens"), // Anthropic: tokens to create cache
    cacheReadTokens: integer("cache_read_tokens"), // Anthropic: tokens read from cache
    costUsd: numeric("cost_usd"),
    costStatus: text("cost_status").notNull().default("unknown"), // 'known' | 'unknown'
    inputPriceSnapshot: numeric("input_price_snapshot"), // USD per million tokens at request time
    outputPriceSnapshot: numeric("output_price_snapshot"),
    priceSource: text("price_source"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"), // time to first byte/token
    generationMs: integer("generation_ms"), // first meaningful token to completion
    tokensPerSecond: numeric("tokens_per_second"),
    queueTimeMs: integer("queue_time_ms"), // server-side queue wait (Groq, Cerebras)
    promptTimeMs: integer("prompt_time_ms"), // server-side prompt processing (Groq, Cerebras)
    completionTimeMs: integer("completion_time_ms"), // server-side generation (Groq, Cerebras)
    processingMs: integer("processing_ms"), // server-side total (OpenAI openai-processing-ms header)
    statusCode: integer("status_code"),
    errorType: text("error_type"), // 'rate_limit' | 'auth' | 'timeout' | 'server' | 'client'
    errorMessage: text("error_message"), // truncated (max 500 chars)
    outcome: text("outcome").notNull().default("success"),
    instanceId: text("instance_id"), // denormalized for fast instance stats
    source: text("source").default("proxy"), // 'proxy' | 'test'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_usage_user").on(t.userId),
    index("idx_usage_created").on(t.createdAt),
    index("idx_usage_model").on(t.modelId),
    index("idx_usage_catalog_entity").on(t.catalogEntityId),
    index("idx_usage_provider").on(t.providerId),
    index("idx_usage_provider_account").on(t.providerAccountId),
    index("idx_usage_instance").on(t.instanceId),
    index("idx_usage_api_key").on(t.apiKeyId),
  ]
);

// ── System Settings ───────────────────────────────────────────

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Benchmark API credentials are deliberately separate from systemSettings:
// settings are readable through the admin API, while these values are write-only
// ciphertext and are decrypted only immediately before an upstream request.
export const benchmarkSourceCredentials = pgTable("benchmark_source_credentials", {
  sourceId: text("source_id").primaryKey(),
  secretEncrypted: text("secret_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
