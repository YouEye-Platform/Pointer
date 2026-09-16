CREATE TABLE IF NOT EXISTS "benchmark_source_credentials" (
  "source_id" text PRIMARY KEY NOT NULL,
  "secret_encrypted" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

REVOKE ALL ON TABLE "benchmark_source_credentials" FROM PUBLIC;
