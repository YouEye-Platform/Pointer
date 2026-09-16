ALTER TABLE "provider_accounts" ALTER COLUMN "nickname" DROP NOT NULL;

DROP INDEX "idx_provider_accounts_user_nickname";
CREATE UNIQUE INDEX "idx_provider_accounts_user_nickname"
  ON "provider_accounts" USING btree ("user_id", "nickname")
  WHERE "nickname" IS NOT NULL;

ALTER TABLE "instance_models" ADD COLUMN "provider_account_id" text;
ALTER TABLE "instance_models"
  ADD CONSTRAINT "instance_models_provider_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT;
CREATE INDEX "idx_instance_models_provider_account"
  ON "instance_models" USING btree ("provider_account_id");

ALTER TABLE "usage_logs" ADD COLUMN "provider_account_id" text;
ALTER TABLE "usage_logs"
  ADD CONSTRAINT "usage_logs_provider_account_id_provider_accounts_id_fk"
  FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE SET NULL;
CREATE INDEX "idx_usage_provider_account"
  ON "usage_logs" USING btree ("provider_account_id");
