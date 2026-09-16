ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "cost_status" text DEFAULT 'unknown' NOT NULL;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "input_price_snapshot" numeric;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "output_price_snapshot" numeric;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "price_source" text;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "generation_ms" integer;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "tokens_per_second" numeric;
ALTER TABLE "usage_logs" ADD COLUMN IF NOT EXISTS "outcome" text DEFAULT 'success' NOT NULL;

-- Historical zero values cannot be distinguished from genuine free requests.
-- Preserve the original value but mark every pre-migration row as unknown.
UPDATE "usage_logs" SET "cost_status" = 'unknown' WHERE "price_source" IS NULL;
