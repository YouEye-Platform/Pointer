ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS upstream_error_code text;
CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_logs (request_id);
