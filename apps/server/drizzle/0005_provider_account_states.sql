ALTER TABLE "provider_operational_states"
  ADD COLUMN IF NOT EXISTS "account_status" text DEFAULT 'never_synced' NOT NULL,
  ADD COLUMN IF NOT EXISTS "account_error" text;
