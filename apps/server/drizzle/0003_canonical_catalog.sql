ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "canonical_slug" text;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "creator" text;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "creator_icon_key" text;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "reference_input_price" numeric;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "reference_output_price" numeric;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "metadata_source" text;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "metadata_fetched_at" timestamptz;
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "raw_metadata" jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS "model_catalog_canonical_slug_unique" ON "model_catalog" ("canonical_slug");

ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "canonical_model_id" text REFERENCES "model_catalog"("model_id") ON DELETE SET NULL;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "supports_vision" boolean DEFAULT false;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "price_source" text;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "price_fetched_at" timestamptz;
ALTER TABLE "provider_models" ADD COLUMN IF NOT EXISTS "raw_metadata" jsonb;

CREATE TABLE IF NOT EXISTS "model_aliases" (
  "id" text PRIMARY KEY,
  "canonical_model_id" text NOT NULL REFERENCES "model_catalog"("model_id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "alias" text NOT NULL,
  "normalized_light" text NOT NULL,
  "normalized_aggressive" text NOT NULL,
  "is_explicit" boolean DEFAULT false NOT NULL,
  "provenance" jsonb,
  "fetched_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_alias_source_alias" ON "model_aliases" ("source", "alias");
CREATE INDEX IF NOT EXISTS "idx_model_alias_canonical" ON "model_aliases" ("canonical_model_id");
CREATE INDEX IF NOT EXISTS "idx_model_alias_light" ON "model_aliases" ("normalized_light");
CREATE INDEX IF NOT EXISTS "idx_model_alias_aggressive" ON "model_aliases" ("normalized_aggressive");

CREATE TABLE IF NOT EXISTS "benchmark_metrics" (
  "id" text PRIMARY KEY,
  "canonical_model_id" text REFERENCES "model_catalog"("model_id") ON DELETE SET NULL,
  "benchmark_id" text NOT NULL,
  "source_model" text NOT NULL,
  "metrics" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_benchmark_source_model" ON "benchmark_metrics" ("benchmark_id", "source_model");
CREATE INDEX IF NOT EXISTS "idx_benchmark_canonical" ON "benchmark_metrics" ("canonical_model_id");
