ALTER TABLE "catalog_generation_entities"
  ADD COLUMN "released_at" timestamp with time zone;

DROP INDEX IF EXISTS "idx_group_entry_unique";
DROP INDEX IF EXISTS "idx_group_entry_catalog_unique";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "model_group_entries"
     WHERE "provider_model_key" IS NOT NULL
       AND "provider_account_id" IS NOT NULL
     GROUP BY "group_id", "provider_model_key", "provider_account_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'model group route migration found duplicate exact routes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "model_group_entries"
     WHERE "alias" IS NOT NULL
     GROUP BY "group_id", lower(btrim("alias"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'model group route migration found duplicate public aliases';
  END IF;
END $$;

CREATE UNIQUE INDEX "idx_group_entry_route_unique"
  ON "model_group_entries" USING btree
  ("group_id", "provider_model_key", "provider_account_id")
  WHERE "provider_model_key" IS NOT NULL AND "provider_account_id" IS NOT NULL;

CREATE UNIQUE INDEX "idx_group_entry_alias_unique"
  ON "model_group_entries" USING btree ("group_id", lower(btrim("alias")))
  WHERE "alias" IS NOT NULL;

