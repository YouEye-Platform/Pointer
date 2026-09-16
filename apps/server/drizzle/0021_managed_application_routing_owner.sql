ALTER TABLE "managed_app_installations"
  ADD COLUMN "routing_owner_user_id" text;

UPDATE "managed_app_installations" AS installation
   SET "routing_owner_user_id" = instance."user_id"
  FROM "instances" AS instance
 WHERE instance."id" = installation."instance_id"
   AND installation."routing_owner_user_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "managed_app_installations"
     WHERE "routing_owner_user_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'managed installation routing owner backfill is incomplete';
  END IF;
END $$;

ALTER TABLE "managed_app_installations"
  ALTER COLUMN "routing_owner_user_id" SET NOT NULL,
  ADD CONSTRAINT "managed_app_installations_routing_owner_user_id_users_id_fk"
    FOREIGN KEY ("routing_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

CREATE INDEX "idx_managed_installation_routing_owner"
  ON "managed_app_installations" ("routing_owner_user_id");
