ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS failure_receipt jsonb;
