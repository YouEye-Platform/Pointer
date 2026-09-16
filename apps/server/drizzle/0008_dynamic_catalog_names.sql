ALTER TABLE "provider_models"
  ADD COLUMN IF NOT EXISTS "display_name" text;

UPDATE "provider_models"
SET "display_name" = NULLIF(COALESCE(
  "raw_metadata" ->> 'name',
  "raw_metadata" ->> 'display_name',
  "raw_metadata" ->> 'displayName'
), "provider_model_id")
WHERE "display_name" IS NULL;

ALTER TABLE "catalog_generation_entities"
  ADD COLUMN IF NOT EXISTS "name_provenance" jsonb NOT NULL DEFAULT '{}'::jsonb;
