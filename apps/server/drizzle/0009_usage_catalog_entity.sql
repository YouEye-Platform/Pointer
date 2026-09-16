ALTER TABLE "usage_logs"
  ADD COLUMN IF NOT EXISTS "catalog_entity_id" text REFERENCES "model_entities"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_usage_catalog_entity" ON "usage_logs" ("catalog_entity_id");

WITH unambiguous AS (
  SELECT
    usage.id AS usage_id,
    min(provider_model.catalog_entity_id) AS catalog_entity_id
  FROM usage_logs AS usage
  JOIN provider_models AS provider_model
    ON provider_model.provider_id = usage.provider_id
   AND (
     provider_model.model_id = usage.model_id
     OR provider_model.provider_model_id = usage.model_id
     OR provider_model.canonical_model_id = usage.model_id
   )
  WHERE usage.catalog_entity_id IS NULL
    AND provider_model.catalog_entity_id IS NOT NULL
  GROUP BY usage.id
  HAVING count(DISTINCT provider_model.catalog_entity_id) = 1
)
UPDATE usage_logs AS usage
SET catalog_entity_id = unambiguous.catalog_entity_id
FROM unambiguous
WHERE usage.id = unambiguous.usage_id;
