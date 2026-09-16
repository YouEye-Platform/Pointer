CREATE TABLE "provider_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_id" text NOT NULL REFERENCES "providers"("id") ON DELETE RESTRICT,
  "nickname" text NOT NULL,
  "base_url" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_accounts_status_check" CHECK ("status" in ('active', 'disabled', 'error'))
);

CREATE UNIQUE INDEX "idx_provider_accounts_user_nickname"
  ON "provider_accounts" USING btree ("user_id", "nickname");
CREATE INDEX "idx_provider_accounts_user_provider"
  ON "provider_accounts" USING btree ("user_id", "provider_id");

ALTER TABLE "provider_keys" ADD COLUMN "provider_account_id" text;

INSERT INTO "provider_accounts" ("id", "user_id", "provider_id", "nickname", "created_at", "updated_at")
SELECT
  'acc_' || substr(md5("id"), 1, 20),
  "user_id",
  "provider_id",
  COALESCE(NULLIF(trim("label"), ''), 'Default') || ' · ' || "id",
  "created_at",
  "created_at"
FROM "provider_keys";

UPDATE "provider_keys"
SET "provider_account_id" = 'acc_' || substr(md5("id"), 1, 20)
WHERE "provider_account_id" IS NULL;

ALTER TABLE "provider_keys"
  ADD CONSTRAINT "provider_keys_provider_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "idx_provider_keys_account"
  ON "provider_keys" USING btree ("provider_account_id")
  WHERE "provider_account_id" IS NOT NULL;

ALTER TABLE "provider_oauth_device_flows" ADD COLUMN "provider_account_id" text;
ALTER TABLE "provider_oauth_device_flows"
  ADD CONSTRAINT "provider_oauth_device_flows_provider_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE CASCADE;
CREATE INDEX "idx_provider_oauth_device_account"
  ON "provider_oauth_device_flows" USING btree ("provider_account_id");

ALTER TABLE "model_group_entries" ADD COLUMN "provider_account_id" text;
UPDATE "model_group_entries" AS e
SET "provider_account_id" = (
  SELECT a."id"
  FROM "provider_accounts" a
  INNER JOIN "model_groups" g ON g."user_id" = a."user_id"
  WHERE g."id" = e."group_id" AND a."provider_id" = e."provider_id"
  ORDER BY a."created_at", a."id"
  LIMIT 1
);
ALTER TABLE "model_group_entries"
  ADD CONSTRAINT "model_group_entries_provider_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT;
CREATE INDEX "idx_group_entries_provider_account"
  ON "model_group_entries" USING btree ("provider_account_id");

CREATE TABLE "provider_account_models" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_account_id" text NOT NULL REFERENCES "provider_accounts"("id") ON DELETE CASCADE,
  "provider_model_id" text NOT NULL REFERENCES "provider_models"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "idx_provider_account_models_unique"
  ON "provider_account_models" USING btree ("provider_account_id", "provider_model_id");
CREATE INDEX "idx_provider_account_models_model"
  ON "provider_account_models" USING btree ("provider_model_id");

INSERT INTO "provider_account_models" ("id", "provider_account_id", "provider_model_id")
SELECT
  'pam_' || substr(md5(a."id" || ':' || m."id"), 1, 20),
  a."id",
  m."id"
FROM "provider_accounts" a
INNER JOIN "provider_models" m ON m."provider_id" = a."provider_id";
