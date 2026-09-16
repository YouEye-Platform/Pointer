ALTER TABLE "provider_models"
  ADD COLUMN IF NOT EXISTS "native_format" text,
  ADD COLUMN IF NOT EXISTS "native_endpoint" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_models_native_format_check'
  ) THEN
    ALTER TABLE "provider_models"
      ADD CONSTRAINT "provider_models_native_format_check"
      CHECK (
        "native_format" IS NULL
        OR "native_format" IN ('chat-completions', 'messages', 'responses')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_models_native_endpoint_check'
  ) THEN
    ALTER TABLE "provider_models"
      ADD CONSTRAINT "provider_models_native_endpoint_check"
      CHECK (
        "native_endpoint" IS NULL
        OR ("native_endpoint" LIKE '/%' AND "native_endpoint" NOT LIKE '//%')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "provider_oauth_device_flows" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_id" text NOT NULL REFERENCES "providers"("id") ON DELETE CASCADE,
  "device_code_encrypted" text NOT NULL,
  "user_code" text NOT NULL,
  "verification_uri" text NOT NULL,
  "verification_uri_complete" text,
  "interval_seconds" integer NOT NULL DEFAULT 5,
  "next_poll_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_oauth_device_status_check"
    CHECK ("status" IN ('pending', 'denied', 'expired'))
);

CREATE INDEX IF NOT EXISTS "idx_provider_oauth_device_user_provider"
  ON "provider_oauth_device_flows" ("user_id", "provider_id");

CREATE INDEX IF NOT EXISTS "idx_provider_oauth_device_expires"
  ON "provider_oauth_device_flows" ("expires_at");

REVOKE ALL ON TABLE "provider_oauth_device_flows" FROM PUBLIC;
