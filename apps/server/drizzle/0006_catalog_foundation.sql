CREATE TABLE IF NOT EXISTS "catalog_generations" (
  "id" text PRIMARY KEY,
  "state" text DEFAULT 'building' NOT NULL CHECK ("state" IN ('building', 'ready', 'active', 'failed', 'retired')),
  "resolver_version" text NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "activated_at" timestamptz,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_catalog_generations_state" ON "catalog_generations" ("state");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_active" ON "catalog_generations" ((true)) WHERE "state" = 'active';

CREATE TABLE IF NOT EXISTS "source_snapshots" (
  "id" text PRIMARY KEY,
  "generation_id" text REFERENCES "catalog_generations"("id") ON DELETE SET NULL,
  "source_id" text NOT NULL REFERENCES "source_sync_states"("source_id") ON DELETE RESTRICT,
  "revision" text NOT NULL,
  "source_url" text NOT NULL,
  "license" text NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "record_count" integer NOT NULL CHECK ("record_count" >= 0),
  "content_hash" text NOT NULL,
  "state" text DEFAULT 'staged' NOT NULL CHECK ("state" IN ('staged', 'validated', 'active', 'failed', 'retired')),
  "active" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_snapshot_revision" ON "source_snapshots" ("source_id", "revision");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_snapshot_one_active" ON "source_snapshots" ("source_id") WHERE "active";
CREATE INDEX IF NOT EXISTS "idx_source_snapshot_generation" ON "source_snapshots" ("generation_id");
CREATE INDEX IF NOT EXISTS "idx_source_snapshot_active" ON "source_snapshots" ("source_id", "active");

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" text PRIMARY KEY,
  "canonical_name" text NOT NULL,
  "website_url" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_organizations_canonical_name" ON "organizations" ("canonical_name");
CREATE INDEX IF NOT EXISTS "idx_organizations_active" ON "organizations" ("active");

CREATE TABLE IF NOT EXISTS "organization_aliases" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "alias" text NOT NULL,
  "normalized_alias" text NOT NULL,
  "provenance" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_organization_alias_unique" ON "organization_aliases" ("organization_id", "normalized_alias");
CREATE INDEX IF NOT EXISTS "idx_organization_alias_normalized" ON "organization_aliases" ("normalized_alias");

CREATE TABLE IF NOT EXISTS "catalog_assets" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('icon', 'logo')),
  "origin_url" text NOT NULL,
  "license" text NOT NULL,
  "content_hash" text NOT NULL,
  "mime_type" text NOT NULL CHECK ("mime_type" LIKE 'image/%'),
  "byte_size" integer NOT NULL CHECK ("byte_size" >= 0),
  "width" integer CHECK ("width" IS NULL OR "width" > 0),
  "height" integer CHECK ("height" IS NULL OR "height" > 0),
  "validation_state" text DEFAULT 'pending' NOT NULL CHECK ("validation_state" IN ('pending', 'valid', 'invalid')),
  "validation_error" text,
  "cache_path" text,
  "fetched_at" timestamptz NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_asset_content" ON "catalog_assets" ("organization_id", "kind", "content_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_asset_one_active" ON "catalog_assets" ("organization_id", "kind") WHERE "active";
CREATE INDEX IF NOT EXISTS "idx_catalog_asset_active" ON "catalog_assets" ("organization_id", "kind", "active");

CREATE TABLE IF NOT EXISTS "model_entities" (
  "id" text PRIMARY KEY,
  "stable_slug" text NOT NULL,
  "preferred_name" text NOT NULL,
  "organization_id" text REFERENCES "organizations"("id") ON DELETE SET NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_entity_stable_slug" ON "model_entities" ("stable_slug");
CREATE INDEX IF NOT EXISTS "idx_model_entity_organization" ON "model_entities" ("organization_id");
CREATE INDEX IF NOT EXISTS "idx_model_entity_active" ON "model_entities" ("active");

CREATE TABLE IF NOT EXISTS "model_observations" (
  "id" text PRIMARY KEY,
  "snapshot_id" text NOT NULL REFERENCES "source_snapshots"("id") ON DELETE CASCADE,
  "source_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('reference_model', 'provider_model', 'benchmark_model')),
  "native_id" text NOT NULL,
  "raw_name" text,
  "namespace" text,
  "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_observation_native" ON "model_observations" ("source_id", "snapshot_id", "native_id");
CREATE INDEX IF NOT EXISTS "idx_model_observation_snapshot" ON "model_observations" ("snapshot_id");
CREATE INDEX IF NOT EXISTS "idx_model_observation_source_active" ON "model_observations" ("source_id", "active");
CREATE INDEX IF NOT EXISTS "idx_model_observation_native_lookup" ON "model_observations" ("source_id", "native_id");

CREATE OR REPLACE FUNCTION protect_model_observation_immutable_fields() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.snapshot_id, NEW.source_id, NEW.kind, NEW.native_id, NEW.raw_name, NEW.namespace, NEW.attributes, NEW.raw_payload, NEW.provenance, NEW.fetched_at)
     IS DISTINCT FROM
     ROW(OLD.snapshot_id, OLD.source_id, OLD.kind, OLD.native_id, OLD.raw_name, OLD.namespace, OLD.attributes, OLD.raw_payload, OLD.provenance, OLD.fetched_at) THEN
    RAISE EXCEPTION 'model observation facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "trg_model_observation_immutable" ON "model_observations";
CREATE TRIGGER "trg_model_observation_immutable" BEFORE UPDATE ON "model_observations"
FOR EACH ROW EXECUTE FUNCTION protect_model_observation_immutable_fields();

CREATE TABLE IF NOT EXISTS "observation_entity_links" (
  "id" text PRIMARY KEY,
  "observation_id" text NOT NULL REFERENCES "model_observations"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL REFERENCES "model_entities"("id") ON DELETE CASCADE,
  "method" text NOT NULL CHECK ("method" IN ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')),
  "confidence" numeric(5,4) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resolver_version" text NOT NULL,
  "decision_state" text DEFAULT 'linked' NOT NULL CHECK ("decision_state" IN ('linked', 'rejected')),
  "review_state" text DEFAULT 'unreviewed' NOT NULL CHECK ("review_state" IN ('unreviewed', 'approved', 'rejected')),
  "reviewed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "review_note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_observation_entity_link_observation" ON "observation_entity_links" ("observation_id");
CREATE INDEX IF NOT EXISTS "idx_observation_entity_link_entity" ON "observation_entity_links" ("entity_id");

CREATE TABLE IF NOT EXISTS "identity_claims" (
  "id" text PRIMARY KEY,
  "entity_id" text NOT NULL REFERENCES "model_entities"("id") ON DELETE CASCADE,
  "source_id" text,
  "claim_type" text NOT NULL CHECK ("claim_type" IN ('native_id', 'alias', 'name', 'crosswalk')),
  "value" text NOT NULL,
  "normalized_value" text NOT NULL,
  "provenance" jsonb,
  "state" text DEFAULT 'proposed' NOT NULL CHECK ("state" IN ('proposed', 'approved', 'rejected')),
  "reviewed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "review_note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_identity_claim_unique" ON "identity_claims" ("entity_id", COALESCE("source_id", ''), "claim_type", "normalized_value");
CREATE INDEX IF NOT EXISTS "idx_identity_claim_lookup" ON "identity_claims" ("claim_type", "normalized_value", "state");
CREATE INDEX IF NOT EXISTS "idx_identity_claim_entity" ON "identity_claims" ("entity_id");

CREATE TABLE IF NOT EXISTS "resolver_runs" (
  "id" text PRIMARY KEY,
  "generation_id" text REFERENCES "catalog_generations"("id") ON DELETE SET NULL,
  "resolver_version" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL CHECK ("status" IN ('running', 'completed', 'failed')),
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text
);
CREATE INDEX IF NOT EXISTS "idx_resolver_run_generation" ON "resolver_runs" ("generation_id");

CREATE TABLE IF NOT EXISTS "resolver_decisions" (
  "id" text PRIMARY KEY,
  "resolver_run_id" text NOT NULL REFERENCES "resolver_runs"("id") ON DELETE CASCADE,
  "observation_id" text NOT NULL REFERENCES "model_observations"("id") ON DELETE CASCADE,
  "entity_id" text REFERENCES "model_entities"("id") ON DELETE SET NULL,
  "state" text NOT NULL CHECK ("state" IN ('linked', 'ambiguous', 'unresolved', 'rejected')),
  "method" text NOT NULL CHECK ("method" IN ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')),
  "confidence" numeric(5,4) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "candidate_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_resolver_decision_run_observation" ON "resolver_decisions" ("resolver_run_id", "observation_id");
CREATE INDEX IF NOT EXISTS "idx_resolver_decision_state" ON "resolver_decisions" ("state");
CREATE INDEX IF NOT EXISTS "idx_resolver_decision_entity" ON "resolver_decisions" ("entity_id");

ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "catalog_observation_id" text REFERENCES "model_observations"("id") ON DELETE SET NULL;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "catalog_entity_id" text REFERENCES "model_entities"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_provider_models_catalog_observation" ON "provider_models" ("catalog_observation_id");
CREATE INDEX IF NOT EXISTS "idx_provider_models_catalog_entity" ON "provider_models" ("catalog_entity_id");

ALTER TABLE "benchmark_metrics" ADD COLUMN IF NOT EXISTS "catalog_observation_id" text REFERENCES "model_observations"("id") ON DELETE SET NULL;
ALTER TABLE "benchmark_metrics" ADD COLUMN IF NOT EXISTS "catalog_entity_id" text REFERENCES "model_entities"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_benchmark_catalog_observation" ON "benchmark_metrics" ("catalog_observation_id");
CREATE INDEX IF NOT EXISTS "idx_benchmark_catalog_entity" ON "benchmark_metrics" ("catalog_entity_id");
