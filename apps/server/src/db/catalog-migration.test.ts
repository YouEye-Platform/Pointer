import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as schema from "./schema";

const migrationPath = new URL("../../drizzle/0006_catalog_foundation.sql", import.meta.url);
const reconciliationMigrationPath = new URL("../../drizzle/0007_catalog_reconciliation.sql", import.meta.url);
const dynamicNamesMigrationPath = new URL("../../drizzle/0008_dynamic_catalog_names.sql", import.meta.url);
const benchmarkCredentialsMigrationPath = new URL("../../drizzle/0012_benchmark_source_credentials.sql", import.meta.url);
const providerOAuthMigrationPath = new URL("../../drizzle/0013_provider_subscription_oauth.sql", import.meta.url);
const usageApiKeyMigrationPath = new URL("../../drizzle/0014_usage_api_key_set_null.sql", import.meta.url);
const modelGroupIdentityMigrationPath = new URL("../../drizzle/0015_model_group_catalog_identity.sql", import.meta.url);
const managedPlatformMigrationPath = new URL("../../drizzle/0016_managed_platform.sql", import.meta.url);
const googleGenerateContentMigrationPath = new URL("../../drizzle/0017_google_generate_content.sql", import.meta.url);
const providerAccountsMigrationPath = new URL("../../drizzle/0018_provider_accounts.sql", import.meta.url);
const publicContractPath = new URL(
  "../../../../packages/contracts/specs/catalog.v1.schema.json",
  import.meta.url
);

describe("catalog additive migration", () => {
  test("publishes the exact V1 list and detail catalog response shapes", async () => {
    const contract = JSON.parse(await readFile(publicContractPath, "utf8")) as {
      oneOf: Array<{ $ref: string }>;
      $defs: Record<string, unknown>;
    };
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toContain('"":');
    expect(contract.oneOf.map((entry) => entry.$ref)).toEqual([
      "#/$defs/corpus",
      "#/$defs/apiListResponse",
      "#/$defs/apiDetailResponse",
    ]);
    const defs = contract.$defs as Record<string, {
      required?: string[];
      allOf?: Array<{ $ref?: string; required?: string[] }>;
    }>;
    expect(defs.apiEnvelope?.required).toEqual([
      "contractVersion", "snapshotId", "generatedAt", "benchmarkDescriptors", "ranking", "sources",
    ]);
    expect(defs.apiListResponse?.allOf?.[0]).toEqual({ $ref: "#/$defs/apiEnvelope" });
    expect(defs.apiListResponse?.allOf?.[1]?.required).toEqual([
      "items", "page", "pageSize", "total", "facets",
    ]);
    expect(defs.apiDetailResponse?.allOf).toEqual([
      { $ref: "#/$defs/apiEnvelope" },
      { $ref: "#/$defs/apiItemFields" },
    ]);
    const itemFields = contract.$defs.apiItemFields as any;
    expect(itemFields.properties.providers.items.required).toContain("providerModelKey");
    expect(itemFields.properties.providers.items.required).toContain("available");
    expect(itemFields.properties.providers.items.additionalProperties).toBe(false);
    const listFields = (contract.$defs.apiListResponse as any).allOf[1].properties;
    expect(listFields.facets.required).toEqual(["creators", "providers"]);
    expect(listFields.facets.properties.providers.items.required).toEqual(["id", "name", "available"]);
    expect(serialized).not.toContain('"credentialUsable"');
    expect(serialized).not.toContain('"instances"');
  });

  test("defines every catalog domain in Drizzle", () => {
    expect(schema).toMatchObject({
      catalogGenerations: expect.any(Object),
      sourceSnapshots: expect.any(Object),
      modelObservations: expect.any(Object),
      modelEntities: expect.any(Object),
      observationEntityLinks: expect.any(Object),
      identityClaims: expect.any(Object),
      organizations: expect.any(Object),
      organizationAliases: expect.any(Object),
      catalogAssets: expect.any(Object),
      resolverRuns: expect.any(Object),
      resolverDecisions: expect.any(Object),
      catalogGenerationSnapshots: expect.any(Object),
      catalogGenerationOrganizations: expect.any(Object),
      catalogGenerationEntities: expect.any(Object),
      catalogGenerationObservationLinks: expect.any(Object),
      catalogGenerationDecisions: expect.any(Object),
      catalogGenerationAliases: expect.any(Object),
      catalogGenerationProviderRoutes: expect.any(Object),
      catalogGenerationBenchmarkLinks: expect.any(Object),
      catalogGenerationAssets: expect.any(Object),
    });
  });

  test("defines managed integration, lifecycle, delivery, idempotency, and audit domains", () => {
    expect(schema).toMatchObject({
      platformIntegrations: expect.any(Object),
      managedAppInstallations: expect.any(Object),
      credentialDeliveries: expect.any(Object),
      managedKeyRotations: expect.any(Object),
      platformIdempotency: expect.any(Object),
      platformAssertionReplays: expect.any(Object),
      managementAudit: expect.any(Object),
      pointerSchemaVersions: expect.any(Object),
    });
  });

  test("keeps reconciliation storage additive and generation-scoped", async () => {
    const sql = await readFile(reconciliationMigrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+COLUMN)\b/i);
    expect(sql).toContain('FOREIGN KEY ("snapshot_id", "source_id") REFERENCES "source_snapshots"');
    expect(sql).toContain('"source_state" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
    expect(sql).toContain('FOREIGN KEY ("generation_id", "snapshot_id") REFERENCES "catalog_generation_snapshots"');
    expect(sql).toContain('FOREIGN KEY ("generation_id", "entity_id") REFERENCES "catalog_generation_entities"');
    expect(sql).toContain('FOREIGN KEY ("generation_id", "observation_id", "entity_id") REFERENCES "catalog_generation_observation_links"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "parent_generation_id" text REFERENCES "catalog_generations"("id") ON DELETE SET NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_asset_id_organization"');
    expect(sql).toContain('FOREIGN KEY ("asset_id", "organization_id") REFERENCES "catalog_assets"("id", "organization_id")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_provider_raw_unique"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "catalog_generation_decisions"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "catalog_generation_organizations"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "catalog_generation_assets"');
    expect(sql).not.toContain('"provider_model_id" text NOT NULL REFERENCES "provider_models"');
    expect(sql).not.toContain('"provider_id" text NOT NULL REFERENCES "providers"');
  });

  test("contains only additive schema changes", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+COLUMN)\b/i);
    expect(sql).toContain('ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "catalog_observation_id"');
    expect(sql).toContain('ALTER TABLE "benchmark_metrics" ADD COLUMN IF NOT EXISTS "catalog_entity_id"');
    expect(sql).not.toContain('CREATE OR REPLACE VIEW');
  });

  test("adds dynamic source name claims without seeded model corrections", async () => {
    const sql = await readFile(dynamicNamesMigrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+COLUMN)\b/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "display_name" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "name_provenance" jsonb NOT NULL');
    expect(sql).not.toMatch(/gpt|claude|gemini|qwen|kimi|minimax/i);
  });

  test("adds an isolated ciphertext-only benchmark credential table", async () => {
    const sql = await readFile(benchmarkCredentialsMigrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "benchmark_source_credentials"');
    expect(sql).toContain('"secret_encrypted" text NOT NULL');
    expect(sql).toContain('REVOKE ALL ON TABLE "benchmark_source_credentials" FROM PUBLIC');
    expect(sql).not.toMatch(/\b(?:api_key|plaintext|secret_value)\b/i);
  });

  test("adds encrypted device flows and constrained per-model protocols", async () => {
    const sql = await readFile(providerOAuthMigrationPath, "utf8");
    expect(sql).not.toMatch(
      /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+COLUMN)\b/i
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "provider_oauth_device_flows"');
    expect(sql).toContain('"device_code_encrypted" text NOT NULL');
    expect(sql).not.toContain('"access_token"');
    expect(sql).not.toContain('"refresh_token"');
    expect(sql).toContain("IN ('chat-completions', 'messages', 'responses')");
    expect(sql).toContain('REVOKE ALL ON TABLE "provider_oauth_device_flows" FROM PUBLIC');
  });

  test("expands the provider-native protocol constraint without changing data", async () => {
    const sql = await readFile(googleGenerateContentMigrationPath, "utf8");
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "provider_models_native_format_check"');
    expect(sql).toContain("'chat-completions'");
    expect(sql).toContain("'messages'");
    expect(sql).toContain("'responses'");
    expect(sql).toContain("'google-generate-content'");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|UPDATE|INSERT)\b/i);
  });

  test("adds account-scoped credentials, OAuth flows, and exact group routes", async () => {
    const sql = await readFile(providerAccountsMigrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "provider_accounts"');
    expect(sql).toContain('CREATE TABLE "provider_account_models"');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_provider_accounts_user_nickname"');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_provider_account_models_unique"');
    expect(sql).toContain('ALTER TABLE "provider_keys" ADD COLUMN "provider_account_id"');
    expect(sql).toContain("|| ' · ' || \"id\"");
    expect(sql).toContain('ALTER TABLE "provider_oauth_device_flows" ADD COLUMN "provider_account_id"');
    expect(sql).toContain('ALTER TABLE "model_group_entries" ADD COLUMN "provider_account_id"');
    expect(sql).not.toMatch(/\b(?:api_key_encrypted|access_token|refresh_token|password_hash)\b/i);
  });

  test("retains usage history when an API key is deleted", async () => {
    const sql = await readFile(usageApiKeyMigrationPath, "utf8");
    expect(sql).toContain("'usage_logs'::regclass");
    expect(sql).toContain("'usage_logs_api_key_id_api_keys_id_fk'");
    expect(sql).toContain("current_delete_action IS DISTINCT FROM 'n'");
    expect(sql).toContain('FOREIGN KEY ("api_key_id")');
    expect(sql).toContain('REFERENCES "api_keys"("id")');
    expect(sql).toContain("ON DELETE SET NULL");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i);
  });

  test("normalizes one default group and adds conservative exact group identities", async () => {
    const sql = await readFile(modelGroupIdentityMigrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|RENAME\s+COLUMN)\b/i);
    expect(sql).toContain('ALTER COLUMN "is_default" SET NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_groups_one_default"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "catalog_entity_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "provider_model_key"');
    expect(sql).toContain('"candidate_count" = 1');
    expect(sql).toContain('provider_model."provider_id" = entry."provider_id"');
    expect(sql).toContain("model group catalog identity migration found duplicate canonical memberships");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_entry_catalog_unique"');
    expect(sql).not.toMatch(/\b(?:api_key_encrypted|access_token|refresh_token|password_hash)\b/i);
  });

  test("adds managed ownership and recoverable credential lifecycle without synthetic passwords", async () => {
    const sql = await readFile(managedPlatformMigrationPath, "utf8");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i);
    expect(sql).toContain('UPDATE "users" SET "kind" = \'local\'');
    expect(sql).toContain('ALTER COLUMN "email" DROP NOT NULL');
    expect(sql).toContain('"users_service_password_check"');
    expect(sql).toContain('"users_external_identity_check"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "platform_integrations"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "managed_app_installations"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credential_deliveries"');
    expect(sql).toContain('"payload_encrypted" text');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "platform_idempotency"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "management_audit"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_managed_key_one_active"');
    expect(sql).not.toContain('"assertion" text');
    expect(sql).not.toContain('"private_key"');
    expect(sql).not.toMatch(/synthetic.*password/i);
  });

  test("enforces identity, provenance, asset and audit constraints", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_observation_native"');
    expect(sql).toContain("model observation facts are immutable");
    expect(sql).toContain("CHECK (\"mime_type\" LIKE 'image/%')");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_asset_one_active"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_resolver_decision_run_observation"');
    expect(sql).toContain('"reviewed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL');
  });
});
