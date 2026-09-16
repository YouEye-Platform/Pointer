ALTER TABLE "catalog_generations"
  ADD COLUMN IF NOT EXISTS "parent_generation_id" text REFERENCES "catalog_generations"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_parent" ON "catalog_generations" ("parent_generation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_snapshot_id_source"
  ON "source_snapshots" ("id", "source_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_observation_id_snapshot"
  ON "model_observations" ("id", "snapshot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_asset_id_organization"
  ON "catalog_assets" ("id", "organization_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_snapshots" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "snapshot_id" text NOT NULL,
  "source_id" text NOT NULL,
  "source_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("snapshot_id", "source_id") REFERENCES "source_snapshots"("id", "source_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_snapshot_unique"
  ON "catalog_generation_snapshots" ("generation_id", "snapshot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_source_unique"
  ON "catalog_generation_snapshots" ("generation_id", "source_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_snapshot_snapshot"
  ON "catalog_generation_snapshots" ("snapshot_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_organizations" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "canonical_name" text NOT NULL,
  "website_url" text,
  "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_organization_unique"
  ON "catalog_generation_organizations" ("generation_id", "organization_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_entities" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL REFERENCES "model_entities"("id") ON DELETE RESTRICT,
  "preferred_name" text NOT NULL,
  "stable_slug" text NOT NULL,
  "organization_id" text,
  "description" text,
  "context_window" integer CHECK ("context_window" IS NULL OR "context_window" >= 0),
  "max_output" integer CHECK ("max_output" IS NULL OR "max_output" >= 0),
  "supports_tools" boolean NOT NULL,
  "supports_vision" boolean NOT NULL,
  "supports_streaming" boolean NOT NULL,
  "reference_input_price" numeric CHECK ("reference_input_price" IS NULL OR "reference_input_price" >= 0),
  "reference_output_price" numeric CHECK ("reference_output_price" IS NULL OR "reference_output_price" >= 0),
  "metadata_source" text NOT NULL CHECK ("metadata_source" IN ('openrouter', 'provider', 'benchmark')),
  "metadata_fetched_at" timestamptz,
  "raw_metadata" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "organization_id") REFERENCES "catalog_generation_organizations"("generation_id", "organization_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_entity_unique"
  ON "catalog_generation_entities" ("generation_id", "entity_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_slug_unique"
  ON "catalog_generation_entities" ("generation_id", "stable_slug");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_entity_entity"
  ON "catalog_generation_entities" ("entity_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_observation_links" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "snapshot_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "method" text NOT NULL CHECK ("method" IN ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')),
  "confidence" numeric(5,4) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "snapshot_id") REFERENCES "catalog_generation_snapshots"("generation_id", "snapshot_id") ON DELETE CASCADE,
  FOREIGN KEY ("observation_id", "snapshot_id") REFERENCES "model_observations"("id", "snapshot_id") ON DELETE RESTRICT,
  FOREIGN KEY ("generation_id", "entity_id") REFERENCES "catalog_generation_entities"("generation_id", "entity_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_observation_unique"
  ON "catalog_generation_observation_links" ("generation_id", "observation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_observation_entity_unique"
  ON "catalog_generation_observation_links" ("generation_id", "observation_id", "entity_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_observation_entity"
  ON "catalog_generation_observation_links" ("generation_id", "entity_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_decisions" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "snapshot_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "entity_id" text,
  "state" text NOT NULL CHECK ("state" IN ('linked', 'ambiguous', 'unresolved', 'rejected')),
  "method" text NOT NULL CHECK ("method" IN ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')),
  "confidence" numeric(5,4) NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "score" numeric NOT NULL,
  "margin" numeric NOT NULL,
  "candidate_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resolver_version" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "snapshot_id") REFERENCES "catalog_generation_snapshots"("generation_id", "snapshot_id") ON DELETE CASCADE,
  FOREIGN KEY ("observation_id", "snapshot_id") REFERENCES "model_observations"("id", "snapshot_id") ON DELETE RESTRICT,
  FOREIGN KEY ("generation_id", "entity_id") REFERENCES "catalog_generation_entities"("generation_id", "entity_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_decision_unique"
  ON "catalog_generation_decisions" ("generation_id", "observation_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_decision_state"
  ON "catalog_generation_decisions" ("generation_id", "state");

CREATE TABLE IF NOT EXISTS "catalog_generation_aliases" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "source_id" text NOT NULL,
  "alias" text NOT NULL,
  "observation_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "observation_id", "entity_id") REFERENCES "catalog_generation_observation_links"("generation_id", "observation_id", "entity_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_alias_unique"
  ON "catalog_generation_aliases" ("generation_id", "source_id", "alias", "entity_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_provider_routes" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "provider_model_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "raw_model_id" text NOT NULL,
  "snapshot_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "input_price" numeric CHECK ("input_price" IS NULL OR "input_price" >= 0),
  "output_price" numeric CHECK ("output_price" IS NULL OR "output_price" >= 0),
  "context_window" integer CHECK ("context_window" IS NULL OR "context_window" >= 0),
  "max_output" integer CHECK ("max_output" IS NULL OR "max_output" >= 0),
  "supports_tools" boolean NOT NULL,
  "supports_vision" boolean NOT NULL,
  "supports_streaming" boolean NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "observation_id", "entity_id") REFERENCES "catalog_generation_observation_links"("generation_id", "observation_id", "entity_id") ON DELETE CASCADE,
  FOREIGN KEY ("observation_id", "snapshot_id") REFERENCES "model_observations"("id", "snapshot_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_provider_model_unique"
  ON "catalog_generation_provider_routes" ("generation_id", "provider_model_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_provider_raw_unique"
  ON "catalog_generation_provider_routes" ("generation_id", "provider_id", "raw_model_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_provider_entity"
  ON "catalog_generation_provider_routes" ("generation_id", "entity_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_benchmark_links" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "benchmark_id" text NOT NULL,
  "source_model" text NOT NULL,
  "snapshot_id" text NOT NULL,
  "observation_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "metrics" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "observation_id", "entity_id") REFERENCES "catalog_generation_observation_links"("generation_id", "observation_id", "entity_id") ON DELETE CASCADE,
  FOREIGN KEY ("observation_id", "snapshot_id") REFERENCES "model_observations"("id", "snapshot_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_benchmark_unique"
  ON "catalog_generation_benchmark_links" ("generation_id", "benchmark_id", "source_model");
CREATE INDEX IF NOT EXISTS "idx_catalog_generation_benchmark_entity"
  ON "catalog_generation_benchmark_links" ("generation_id", "entity_id");

CREATE TABLE IF NOT EXISTS "catalog_generation_assets" (
  "id" text PRIMARY KEY,
  "generation_id" text NOT NULL REFERENCES "catalog_generations"("id") ON DELETE CASCADE,
  "asset_id" text NOT NULL REFERENCES "catalog_assets"("id") ON DELETE RESTRICT,
  "organization_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('icon', 'logo')),
  "origin_url" text NOT NULL,
  "license" text NOT NULL,
  "content_hash" text NOT NULL,
  "mime_type" text NOT NULL CHECK ("mime_type" LIKE 'image/%'),
  "byte_size" integer NOT NULL CHECK ("byte_size" >= 0),
  "width" integer,
  "height" integer,
  "validation_state" text NOT NULL,
  "cache_path" text,
  "fetched_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY ("generation_id", "organization_id") REFERENCES "catalog_generation_organizations"("generation_id", "organization_id") ON DELETE RESTRICT,
  FOREIGN KEY ("asset_id", "organization_id") REFERENCES "catalog_assets"("id", "organization_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catalog_generation_asset_unique"
  ON "catalog_generation_assets" ("generation_id", "asset_id");
