ALTER TABLE provider_accounts ADD COLUMN engine_provider text;
CREATE UNIQUE INDEX idx_provider_accounts_engine_provider
  ON provider_accounts (user_id, engine_provider)
  WHERE engine_provider IS NOT NULL;
