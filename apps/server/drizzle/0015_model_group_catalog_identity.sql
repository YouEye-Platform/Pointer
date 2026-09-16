UPDATE "model_groups"
SET "is_default" = false
WHERE "is_default" IS NULL;

WITH ranked_defaults AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "user_id"
      ORDER BY "position" ASC NULLS LAST, "created_at" ASC, "id" ASC
    ) AS "rank"
  FROM "model_groups"
  WHERE "is_default" = true
)
UPDATE "model_groups" AS "group"
SET "is_default" = false
FROM ranked_defaults
WHERE "group"."id" = ranked_defaults."id"
  AND ranked_defaults."rank" > 1;

WITH users_without_default AS (
  SELECT "user_id"
  FROM "model_groups"
  GROUP BY "user_id"
  HAVING count(*) FILTER (WHERE "is_default" = true) = 0
),
ranked_groups AS (
  SELECT
    "group"."id",
    row_number() OVER (
      PARTITION BY "group"."user_id"
      ORDER BY "group"."position" ASC NULLS LAST, "group"."created_at" ASC, "group"."id" ASC
    ) AS "rank"
  FROM "model_groups" AS "group"
  INNER JOIN users_without_default
    ON users_without_default."user_id" = "group"."user_id"
)
UPDATE "model_groups" AS "group"
SET "is_default" = true
FROM ranked_groups
WHERE "group"."id" = ranked_groups."id"
  AND ranked_groups."rank" = 1;

ALTER TABLE "model_groups"
  ALTER COLUMN "is_default" SET DEFAULT false,
  ALTER COLUMN "is_default" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_model_groups_one_default"
  ON "model_groups" ("user_id")
  WHERE "is_default" = true;

ALTER TABLE "model_group_entries"
  ADD COLUMN IF NOT EXISTS "catalog_entity_id" text
    REFERENCES "model_entities"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "provider_model_key" text
    REFERENCES "provider_models"("id") ON DELETE SET NULL;

WITH candidate_matches AS (
  SELECT
    entry."id" AS "entry_id",
    provider_model."id" AS "provider_model_key",
    provider_model."catalog_entity_id",
    count(*) OVER (PARTITION BY entry."id") AS "candidate_count"
  FROM "model_group_entries" AS entry
  INNER JOIN "provider_models" AS provider_model
    ON provider_model."provider_id" = entry."provider_id"
   AND (
     provider_model."id" = entry."model_id"
     OR provider_model."model_id" = entry."model_id"
     OR provider_model."provider_model_id" = entry."model_id"
     OR provider_model."canonical_model_id" = entry."model_id"
     OR provider_model."catalog_entity_id" = entry."model_id"
   )
),
unambiguous AS (
  SELECT "entry_id", "provider_model_key", "catalog_entity_id"
  FROM candidate_matches
  WHERE "candidate_count" = 1
)
UPDATE "model_group_entries" AS entry
SET
  "provider_model_key" = unambiguous."provider_model_key",
  "catalog_entity_id" = unambiguous."catalog_entity_id"
FROM unambiguous
WHERE entry."id" = unambiguous."entry_id"
  AND entry."provider_model_key" IS NULL
  AND entry."catalog_entity_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "model_group_entries"
    WHERE "catalog_entity_id" IS NOT NULL
    GROUP BY "group_id", "catalog_entity_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'model group catalog identity migration found duplicate canonical memberships';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_entry_catalog_unique"
  ON "model_group_entries" ("group_id", "catalog_entity_id")
  WHERE "catalog_entity_id" IS NOT NULL;
