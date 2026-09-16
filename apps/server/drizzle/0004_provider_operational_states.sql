CREATE TABLE IF NOT EXISTS "provider_operational_states" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_id" text NOT NULL REFERENCES "providers"("id") ON DELETE CASCADE,
  "balance" numeric,
  "balance_currency" text,
  "balance_status" text DEFAULT 'never_synced' NOT NULL,
  "balance_error" text,
  "balance_updated_at" timestamp with time zone,
  "rate_limit_data" jsonb,
  "rate_limit_updated_at" timestamp with time zone,
  "account_data" jsonb,
  "account_updated_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_provider_operational_user_provider" ON "provider_operational_states" ("user_id", "provider_id");
