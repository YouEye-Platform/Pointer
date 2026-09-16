ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "kind" text,
  ADD COLUMN IF NOT EXISTS "external_issuer" text,
  ADD COLUMN IF NOT EXISTS "external_subject" text,
  ADD COLUMN IF NOT EXISTS "state" text;

UPDATE "users" SET "kind" = 'local' WHERE "kind" IS NULL;
UPDATE "users" SET "state" = 'active' WHERE "state" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "kind" SET DEFAULT 'local',
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "state" SET DEFAULT 'active',
  ALTER COLUMN "state" SET NOT NULL,
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "password_hash" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_kind_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_kind_check"
      CHECK ("kind" IN ('local', 'service', 'external'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_role_check"
      CHECK ("role" IN ('admin', 'user'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_state_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_state_check"
      CHECK ("state" IN ('active', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_local_credentials_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_local_credentials_check"
      CHECK ("kind" <> 'local' OR ("email" IS NOT NULL AND "password_hash" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_service_password_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_service_password_check"
      CHECK ("kind" <> 'service' OR "password_hash" IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_external_identity_check') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_external_identity_check"
      CHECK (
        ("kind" = 'external' AND "external_issuer" IS NOT NULL AND "external_subject" IS NOT NULL)
        OR
        ("kind" <> 'external' AND "external_issuer" IS NULL AND "external_subject" IS NULL)
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_external_identity"
  ON "users" ("external_issuer", "external_subject")
  WHERE "external_issuer" IS NOT NULL AND "external_subject" IS NOT NULL;

ALTER TABLE "instances"
  ADD COLUMN IF NOT EXISTS "origin" text,
  ADD COLUMN IF NOT EXISTS "state" text,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

UPDATE "instances" SET "origin" = 'local' WHERE "origin" IS NULL;
UPDATE "instances" SET "state" = 'active' WHERE "state" IS NULL;

ALTER TABLE "instances"
  ALTER COLUMN "origin" SET DEFAULT 'local',
  ALTER COLUMN "origin" SET NOT NULL,
  ALTER COLUMN "state" SET DEFAULT 'active',
  ALTER COLUMN "state" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instances_origin_check') THEN
    ALTER TABLE "instances" ADD CONSTRAINT "instances_origin_check"
      CHECK ("origin" IN ('local', 'managed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instances_state_check') THEN
    ALTER TABLE "instances" ADD CONSTRAINT "instances_state_check"
      CHECK ("state" IN ('active', 'disabled', 'archived'));
  END IF;
END
$$;

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "purpose" text,
  ADD COLUMN IF NOT EXISTS "lifecycle" text,
  ADD COLUMN IF NOT EXISTS "managed_installation_id" text,
  ADD COLUMN IF NOT EXISTS "generation" integer,
  ADD COLUMN IF NOT EXISTS "replacement_of_key_id" text,
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;

UPDATE "api_keys" SET "purpose" = 'local_operator' WHERE "purpose" IS NULL;
UPDATE "api_keys" SET "lifecycle" = CASE WHEN "revoked" THEN 'retired' ELSE 'active' END
WHERE "lifecycle" IS NULL;
UPDATE "api_keys" SET "generation" = 1 WHERE "generation" IS NULL;

ALTER TABLE "api_keys"
  ALTER COLUMN "purpose" SET DEFAULT 'local_operator',
  ALTER COLUMN "purpose" SET NOT NULL,
  ALTER COLUMN "lifecycle" SET DEFAULT 'active',
  ALTER COLUMN "lifecycle" SET NOT NULL,
  ALTER COLUMN "generation" SET DEFAULT 1,
  ALTER COLUMN "generation" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_purpose_check') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_purpose_check"
      CHECK ("purpose" IN ('local_operator', 'internal_test', 'managed_application'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_lifecycle_check') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_lifecycle_check"
      CHECK ("lifecycle" IN ('active', 'pending', 'retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_generation_check') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_generation_check"
      CHECK ("generation" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_replacement_fk') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_replacement_fk"
      FOREIGN KEY ("replacement_of_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idx_api_keys_managed_installation"
  ON "api_keys" ("managed_installation_id");

CREATE TABLE IF NOT EXISTS "platform_integrations" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "external_server_id" text NOT NULL UNIQUE,
  "owner_user_id" text NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
  "expected_issuer" text NOT NULL,
  "expected_audience" text NOT NULL,
  "expected_subject" text NOT NULL,
  "state" text NOT NULL DEFAULT 'active'
    CHECK ("state" IN ('active', 'disabled')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_authenticated_at" timestamptz,
  "last_ready_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "managed_app_installations" (
  "id" text PRIMARY KEY,
  "integration_id" text NOT NULL REFERENCES "platform_integrations"("id") ON DELETE RESTRICT,
  "external_installation_id" text NOT NULL,
  "app_id" text NOT NULL,
  "display_name" text NOT NULL,
  "instance_id" text NOT NULL UNIQUE REFERENCES "instances"("id") ON DELETE RESTRICT,
  "active_api_key_id" text REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "pending_api_key_id" text REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'provisioning'
    CHECK ("state" IN ('provisioning', 'active', 'rotating', 'disabled', 'archived', 'error')),
  "app_version" text,
  "adapter_revision" text,
  "last_reconciliation_result" jsonb,
  "last_reconciled_at" timestamptz,
  "historical_group_id" text,
  "historical_group_name" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  UNIQUE ("integration_id", "external_installation_id"),
  CHECK ("active_api_key_id" IS NULL OR "active_api_key_id" <> "pending_api_key_id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_managed_installation_fk') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_managed_installation_fk"
      FOREIGN KEY ("managed_installation_id") REFERENCES "managed_app_installations"("id")
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_managed_key_one_active"
  ON "api_keys" ("managed_installation_id")
  WHERE "managed_installation_id" IS NOT NULL
    AND "purpose" = 'managed_application'
    AND "lifecycle" = 'active'
    AND "revoked" = false;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_managed_key_one_pending"
  ON "api_keys" ("managed_installation_id")
  WHERE "managed_installation_id" IS NOT NULL
    AND "purpose" = 'managed_application'
    AND "lifecycle" = 'pending'
    AND "revoked" = false;

CREATE TABLE IF NOT EXISTS "credential_deliveries" (
  "id" text PRIMARY KEY,
  "integration_id" text NOT NULL REFERENCES "platform_integrations"("id") ON DELETE RESTRICT,
  "installation_id" text NOT NULL REFERENCES "managed_app_installations"("id") ON DELETE CASCADE,
  "api_key_id" text NOT NULL UNIQUE REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "mutation_key_hash" text NOT NULL,
  "payload_encrypted" text,
  "expires_at" timestamptz NOT NULL,
  "acknowledged_at" timestamptz,
  "purged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_credential_delivery_expiry"
  ON "credential_deliveries" ("expires_at");

CREATE TABLE IF NOT EXISTS "managed_key_rotations" (
  "id" text PRIMARY KEY,
  "installation_id" text NOT NULL REFERENCES "managed_app_installations"("id") ON DELETE CASCADE,
  "previous_key_id" text NOT NULL REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "pending_key_id" text NOT NULL UNIQUE REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "delivery_id" text NOT NULL REFERENCES "credential_deliveries"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'prepared'
    CHECK ("state" IN ('prepared', 'committed', 'aborted')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "committed_at" timestamptz,
  "aborted_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_managed_rotation_one_prepared"
  ON "managed_key_rotations" ("installation_id")
  WHERE "state" = 'prepared';

CREATE TABLE IF NOT EXISTS "platform_idempotency" (
  "id" text PRIMARY KEY,
  "integration_id" text NOT NULL REFERENCES "platform_integrations"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'completed'
    CHECK ("state" IN ('completed', 'failed')),
  "result_status" integer,
  "result_body" jsonb,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("integration_id", "action", "idempotency_key_hash")
);

CREATE INDEX IF NOT EXISTS "idx_platform_idempotency_expiry"
  ON "platform_idempotency" ("expires_at");

CREATE TABLE IF NOT EXISTS "platform_assertion_replays" (
  "id" text PRIMARY KEY,
  "integration_id" text NOT NULL REFERENCES "platform_integrations"("id") ON DELETE CASCADE,
  "jti_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("integration_id", "jti_hash")
);

CREATE INDEX IF NOT EXISTS "idx_platform_assertion_replay_expiry"
  ON "platform_assertion_replays" ("expires_at");

CREATE TABLE IF NOT EXISTS "management_audit" (
  "id" text PRIMARY KEY,
  "request_id" text NOT NULL,
  "integration_id" text NOT NULL REFERENCES "platform_integrations"("id") ON DELETE RESTRICT,
  "actor_issuer" text NOT NULL,
  "actor_subject" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "old_state" jsonb,
  "new_state" jsonb,
  "outcome" text NOT NULL CHECK ("outcome" IN ('success', 'failure')),
  "error_code" text,
  "build_commit" text,
  "contract_version" text NOT NULL DEFAULT '1',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_management_audit_created"
  ON "management_audit" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_management_audit_integration"
  ON "management_audit" ("integration_id");

CREATE TABLE IF NOT EXISTS "pointer_schema_versions" (
  "version" integer PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "pointer_schema_versions" ("version") VALUES (16)
ON CONFLICT ("version") DO NOTHING;
