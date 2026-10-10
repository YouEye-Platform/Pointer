ALTER TABLE provider_accounts ADD COLUMN wire_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;
