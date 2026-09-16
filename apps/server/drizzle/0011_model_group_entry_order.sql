WITH ranked AS (
  SELECT
    "id",
    (
      row_number() OVER (
        PARTITION BY "group_id"
        ORDER BY "position" ASC NULLS LAST, "created_at" ASC, "id" ASC
      ) - 1
    )::integer AS "normalized_position"
  FROM "model_group_entries"
)
UPDATE "model_group_entries" AS entry
SET "position" = ranked."normalized_position"
FROM ranked
WHERE entry."id" = ranked."id"
  AND entry."position" IS DISTINCT FROM ranked."normalized_position";

ALTER TABLE "model_group_entries"
  ALTER COLUMN "position" SET DEFAULT 0,
  ALTER COLUMN "position" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_entry_position_unique"
  ON "model_group_entries" ("group_id", "position");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_group_entry_position_nonnegative'
      AND conrelid = 'model_group_entries'::regclass
  ) THEN
    ALTER TABLE "model_group_entries"
      ADD CONSTRAINT "chk_group_entry_position_nonnegative"
      CHECK ("position" >= 0);
  END IF;
END
$$;
