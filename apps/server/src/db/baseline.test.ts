import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as schema from "./schema";

// Properties of the final schema that earlier per-migration tests guarded. The
// baseline is pg_dump output, so the expected text uses pg_dump's spelling.
const baselinePath = new URL("../../drizzle/0001_baseline.sql", import.meta.url);
const baseline = () => readFile(baselinePath, "utf8");

describe("Drizzle schema domains", () => {
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
});

describe("schema baseline", () => {
  test("keeps catalog generations consistent through composite foreign keys", async () => {
    const sql = await baseline();
    expect(sql).toContain("FOREIGN KEY (snapshot_id, source_id) REFERENCES source_snapshots(id, source_id)");
    expect(sql).toContain(
      "FOREIGN KEY (generation_id, snapshot_id) REFERENCES catalog_generation_snapshots(generation_id, snapshot_id)"
    );
    expect(sql).toContain(
      "FOREIGN KEY (generation_id, entity_id) REFERENCES catalog_generation_entities(generation_id, entity_id)"
    );
    expect(sql).toContain(
      "FOREIGN KEY (generation_id, observation_id, entity_id) REFERENCES catalog_generation_observation_links(generation_id, observation_id, entity_id)"
    );
    expect(sql).toContain(
      "FOREIGN KEY (parent_generation_id) REFERENCES catalog_generations(id) ON DELETE SET NULL"
    );
    expect(sql).toContain("CREATE UNIQUE INDEX idx_catalog_asset_id_organization ON catalog_assets");
    expect(sql).toContain(
      "FOREIGN KEY (asset_id, organization_id) REFERENCES catalog_assets(id, organization_id)"
    );
    expect(sql).toContain("CREATE UNIQUE INDEX idx_catalog_generation_provider_raw_unique");
    // Generation routes are snapshots: they never reference live provider rows.
    expect(sql).not.toMatch(/catalog_generation_provider_routes[^;]*REFERENCES (?:provider_models|providers)\(/);
  });

  test("enforces identity, provenance, asset and audit constraints", async () => {
    const sql = await baseline();
    expect(sql).toContain("CREATE UNIQUE INDEX idx_model_observation_native ON model_observations");
    expect(sql).toContain("model observation facts are immutable");
    expect(sql).toContain("CREATE TRIGGER trg_model_observation_immutable BEFORE UPDATE ON model_observations");
    expect(sql).toContain("CONSTRAINT chk_catalog_asset_mime CHECK ((mime_type ~~ 'image/%'::text))");
    expect(sql).toContain("CREATE UNIQUE INDEX idx_catalog_asset_one_active ON catalog_assets");
    expect(sql).toContain("CREATE UNIQUE INDEX idx_resolver_decision_run_observation ON resolver_decisions");
    expect(sql).toContain(
      "identity_claims_reviewed_by_user_id_users_id_fk FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL"
    );
  });

  test("seeds no model data", async () => {
    const sql = await baseline();
    expect(sql).not.toMatch(/^\s*(?:INSERT|COPY|UPDATE)\b/im);
    expect(sql).not.toMatch(/gpt|claude|gemini|qwen|kimi|minimax/i);
  });

  test("stores secrets only encrypted and outside PUBLIC grants", async () => {
    const sql = await baseline();
    expect(sql).toContain("secret_encrypted text NOT NULL");
    expect(sql).toContain("device_code_encrypted text NOT NULL");
    expect(sql).toContain("payload_encrypted text");
    expect(sql).toContain("REVOKE ALL ON TABLE benchmark_source_credentials FROM PUBLIC;");
    expect(sql).toContain("REVOKE ALL ON TABLE provider_oauth_device_flows FROM PUBLIC;");
    expect(sql).not.toMatch(/\b(?:access_token|refresh_token|plaintext|secret_value|private_key)\b/i);
    expect(sql).not.toMatch(/\bassertion text\b/);
  });

  test("allows each provider-native protocol", async () => {
    const sql = await baseline();
    expect(sql).toContain(
      "provider_models_native_format_check CHECK (((native_format IS NULL) OR (native_format = ANY (ARRAY['chat-completions'::text, 'messages'::text, 'responses'::text, 'google-generate-content'::text]))))"
    );
  });

  test("keeps usage history and attributes it to exact provider accounts", async () => {
    const sql = await baseline();
    expect(sql).toContain("FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL");
    expect(sql).toContain(
      "usage_logs_provider_account_id_provider_accounts_id_fk FOREIGN KEY (provider_account_id) REFERENCES provider_accounts(id) ON DELETE SET NULL"
    );
    expect(sql).toContain("instance_models_provider_account_id_provider_accounts_id_fk FOREIGN KEY (provider_account_id)");
  });

  test("keeps one default group and unique exact routes and aliases", async () => {
    const sql = await baseline();
    expect(sql).toContain("is_default boolean DEFAULT false NOT NULL");
    expect(sql).toContain(
      "CREATE UNIQUE INDEX idx_model_groups_one_default ON model_groups USING btree (user_id) WHERE (is_default = true);"
    );
    expect(sql).toContain(
      "CREATE UNIQUE INDEX idx_group_entry_route_unique ON model_group_entries USING btree (group_id, provider_model_key, provider_account_id)"
    );
    expect(sql).toContain(
      "CREATE UNIQUE INDEX idx_group_entry_alias_unique ON model_group_entries USING btree (group_id, lower(btrim(alias))) WHERE (alias IS NOT NULL);"
    );
    expect(sql).not.toContain("idx_group_entry_catalog_unique");
  });

  test("allows optional provider account nicknames without duplicates", async () => {
    const sql = await baseline();
    expect(sql).toContain(
      "CREATE UNIQUE INDEX idx_provider_accounts_user_nickname ON provider_accounts USING btree (user_id, nickname) WHERE (nickname IS NOT NULL);"
    );
  });

  test("constrains managed identities, keys and routing owners", async () => {
    const sql = await baseline();
    expect(sql).toContain("CONSTRAINT users_service_password_check CHECK");
    expect(sql).toContain("CONSTRAINT users_external_identity_check CHECK");
    expect(sql).toContain("CREATE UNIQUE INDEX idx_managed_key_one_active ON api_keys");
    expect(sql).toContain("routing_owner_user_id text NOT NULL");
    expect(sql).toContain(
      "FOREIGN KEY (routing_owner_user_id) REFERENCES users(id) ON DELETE RESTRICT"
    );
    expect(sql).toContain("CREATE INDEX idx_managed_installation_routing_owner ON managed_app_installations");
  });

  test("records upstream release timestamps on catalog entities", async () => {
    const sql = await baseline();
    expect(sql).toMatch(/CREATE TABLE catalog_generation_entities \([^;]*released_at timestamp with time zone/);
  });
});
