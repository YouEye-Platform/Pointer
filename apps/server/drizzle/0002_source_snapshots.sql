CREATE TABLE IF NOT EXISTS "source_sync_states" (
  "source_id" text PRIMARY KEY,
  "status" text DEFAULT 'never_synced' NOT NULL,
  "last_attempt_at" timestamptz,
  "last_success_at" timestamptz,
  "fetched_at" timestamptz,
  "record_count" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_message" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "source_records" (
  "id" text PRIMARY KEY,
  "source_id" text NOT NULL REFERENCES "source_sync_states"("source_id") ON DELETE CASCADE,
  "record_key" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_record_unique" ON "source_records" ("source_id", "record_key");
CREATE INDEX IF NOT EXISTS "idx_source_records_source" ON "source_records" ("source_id");
CREATE INDEX IF NOT EXISTS "idx_source_records_kind" ON "source_records" ("kind");
