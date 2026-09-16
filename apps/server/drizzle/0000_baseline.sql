-- Fresh-database baseline generated from src/db/schema.ts.
-- Indexes intentionally precede foreign keys because several composite
-- references depend on unique indexes rather than UNIQUE constraints.
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_preview" text NOT NULL,
	"name" text NOT NULL,
	"allowed_models" jsonb DEFAULT '["*"]'::jsonb,
	"fallback_provider_id" text,
	"scopes" jsonb DEFAULT '["read","write"]'::jsonb,
	"purpose" text DEFAULT 'local_operator' NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"managed_installation_id" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"replacement_of_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone,
	"request_count" integer DEFAULT 0,
	"revoked" boolean DEFAULT false,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_purpose_check" CHECK ("api_keys"."purpose" in ('local_operator', 'internal_test', 'managed_application')),
	CONSTRAINT "api_keys_lifecycle_check" CHECK ("api_keys"."lifecycle" in ('active', 'pending', 'retired')),
	CONSTRAINT "api_keys_generation_check" CHECK ("api_keys"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "benchmark_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_model_id" text,
	"catalog_observation_id" text,
	"catalog_entity_id" text,
	"benchmark_id" text NOT NULL,
	"source_model" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_source_credentials" (
	"source_id" text PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin_url" text NOT NULL,
	"license" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"validation_state" text DEFAULT 'pending' NOT NULL,
	"validation_error" text,
	"cache_path" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_asset_kind" CHECK ("catalog_assets"."kind" in ('icon', 'logo')),
	CONSTRAINT "chk_catalog_asset_mime" CHECK ("catalog_assets"."mime_type" like 'image/%'),
	CONSTRAINT "chk_catalog_asset_validation" CHECK ("catalog_assets"."validation_state" in ('pending', 'valid', 'invalid')),
	CONSTRAINT "chk_catalog_asset_size" CHECK ("catalog_assets"."byte_size" >= 0),
	CONSTRAINT "chk_catalog_asset_width" CHECK ("catalog_assets"."width" is null or "catalog_assets"."width" > 0),
	CONSTRAINT "chk_catalog_asset_height" CHECK ("catalog_assets"."height" is null or "catalog_assets"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"source_id" text NOT NULL,
	"alias" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin_url" text NOT NULL,
	"license" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"validation_state" text NOT NULL,
	"cache_path" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_asset_kind" CHECK ("catalog_generation_assets"."kind" in ('icon', 'logo')),
	CONSTRAINT "chk_catalog_generation_asset_mime" CHECK ("catalog_generation_assets"."mime_type" like 'image/%'),
	CONSTRAINT "chk_catalog_generation_asset_size" CHECK ("catalog_generation_assets"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_benchmark_links" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"benchmark_id" text NOT NULL,
	"source_model" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text,
	"state" text NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"score" numeric NOT NULL,
	"margin" numeric NOT NULL,
	"candidate_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolver_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_decision_state" CHECK ("catalog_generation_decisions"."state" in ('linked', 'ambiguous', 'unresolved', 'rejected')),
	CONSTRAINT "chk_catalog_generation_decision_method" CHECK ("catalog_generation_decisions"."method" in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')),
	CONSTRAINT "chk_catalog_generation_decision_confidence" CHECK ("catalog_generation_decisions"."confidence" >= 0 and "catalog_generation_decisions"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"preferred_name" text NOT NULL,
	"name_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stable_slug" text NOT NULL,
	"organization_id" text,
	"description" text,
	"context_window" integer,
	"max_output" integer,
	"supports_tools" boolean NOT NULL,
	"supports_vision" boolean NOT NULL,
	"supports_streaming" boolean NOT NULL,
	"reference_input_price" numeric,
	"reference_output_price" numeric,
	"metadata_source" text NOT NULL,
	"metadata_fetched_at" timestamp with time zone,
	"raw_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_entity_context" CHECK ("catalog_generation_entities"."context_window" is null or "catalog_generation_entities"."context_window" >= 0),
	CONSTRAINT "chk_catalog_generation_entity_output" CHECK ("catalog_generation_entities"."max_output" is null or "catalog_generation_entities"."max_output" >= 0),
	CONSTRAINT "chk_catalog_generation_entity_input_price" CHECK ("catalog_generation_entities"."reference_input_price" is null or "catalog_generation_entities"."reference_input_price" >= 0),
	CONSTRAINT "chk_catalog_generation_entity_output_price" CHECK ("catalog_generation_entities"."reference_output_price" is null or "catalog_generation_entities"."reference_output_price" >= 0),
	CONSTRAINT "chk_catalog_generation_entity_source" CHECK ("catalog_generation_entities"."metadata_source" in ('openrouter', 'provider', 'benchmark'))
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_observation_links" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_link_method" CHECK ("catalog_generation_observation_links"."method" in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')),
	CONSTRAINT "chk_catalog_generation_link_confidence" CHECK ("catalog_generation_observation_links"."confidence" >= 0 and "catalog_generation_observation_links"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"website_url" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_provider_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"raw_model_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"input_price" numeric,
	"output_price" numeric,
	"context_window" integer,
	"max_output" integer,
	"supports_tools" boolean NOT NULL,
	"supports_vision" boolean NOT NULL,
	"supports_streaming" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_route_input_price" CHECK ("catalog_generation_provider_routes"."input_price" is null or "catalog_generation_provider_routes"."input_price" >= 0),
	CONSTRAINT "chk_catalog_generation_route_output_price" CHECK ("catalog_generation_provider_routes"."output_price" is null or "catalog_generation_provider_routes"."output_price" >= 0),
	CONSTRAINT "chk_catalog_generation_route_context" CHECK ("catalog_generation_provider_routes"."context_window" is null or "catalog_generation_provider_routes"."context_window" >= 0),
	CONSTRAINT "chk_catalog_generation_route_output" CHECK ("catalog_generation_provider_routes"."max_output" is null or "catalog_generation_provider_routes"."max_output" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_generation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_generation_id" text,
	"state" text DEFAULT 'building' NOT NULL,
	"resolver_version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_catalog_generation_state" CHECK ("catalog_generations"."state" in ('building', 'ready', 'active', 'failed', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "credential_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"mutation_key_hash" text NOT NULL,
	"payload_encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"source_id" text,
	"claim_type" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"provenance" jsonb,
	"state" text DEFAULT 'proposed' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_identity_claim_type" CHECK ("identity_claims"."claim_type" in ('native_id', 'alias', 'name', 'crosswalk')),
	CONSTRAINT "chk_identity_claim_state" CHECK ("identity_claims"."state" in ('proposed', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "instance_models" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"priority" integer DEFAULT 0,
	"alias" text,
	"source" text DEFAULT 'custom'
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT '{}',
	"color" text DEFAULT '#3B82F6',
	"model_group_id" text,
	"origin" text DEFAULT 'local' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_origin_check" CHECK ("instances"."origin" in ('local', 'managed')),
	CONSTRAINT "instances_state_check" CHECK ("instances"."state" in ('active', 'disabled', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "managed_app_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"app_id" text NOT NULL,
	"display_name" text NOT NULL,
	"instance_id" text NOT NULL,
	"active_api_key_id" text,
	"pending_api_key_id" text,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"app_version" text,
	"adapter_revision" text,
	"last_reconciliation_result" jsonb,
	"last_reconciled_at" timestamp with time zone,
	"historical_group_id" text,
	"historical_group_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "managed_installation_distinct_keys_check" CHECK ("managed_app_installations"."active_api_key_id" is null or "managed_app_installations"."active_api_key_id" <> "managed_app_installations"."pending_api_key_id"),
	CONSTRAINT "managed_installation_state_check" CHECK ("managed_app_installations"."state" in ('provisioning', 'active', 'rotating', 'disabled', 'archived', 'error'))
);
--> statement-breakpoint
CREATE TABLE "managed_key_rotations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"previous_key_id" text NOT NULL,
	"pending_key_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	CONSTRAINT "managed_rotation_state_check" CHECK ("managed_key_rotations"."state" in ('prepared', 'committed', 'aborted'))
);
--> statement-breakpoint
CREATE TABLE "management_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"actor_issuer" text NOT NULL,
	"actor_subject" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"old_state" jsonb,
	"new_state" jsonb,
	"outcome" text NOT NULL,
	"error_code" text,
	"build_commit" text,
	"contract_version" text DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_audit_outcome_check" CHECK ("management_audit"."outcome" in ('success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_model_id" text NOT NULL,
	"source" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_light" text NOT NULL,
	"normalized_aggressive" text NOT NULL,
	"is_explicit" boolean DEFAULT false NOT NULL,
	"provenance" jsonb,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"model_id" text PRIMARY KEY NOT NULL,
	"canonical_slug" text,
	"name" text NOT NULL,
	"creator" text,
	"creator_icon_key" text,
	"description" text,
	"context_window" integer,
	"max_output" integer,
	"is_reasoning" boolean DEFAULT false,
	"supports_vision" boolean DEFAULT false,
	"supports_tools" boolean DEFAULT false,
	"supports_streaming" boolean DEFAULT true,
	"arena_elo" integer,
	"coding_score" numeric,
	"quality_score" numeric,
	"logo_url" text,
	"release_date" date,
	"reference_input_price" numeric,
	"reference_output_price" numeric,
	"metadata_source" text,
	"metadata_fetched_at" timestamp with time zone,
	"raw_metadata" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_canonical_slug_unique" UNIQUE("canonical_slug")
);
--> statement-breakpoint
CREATE TABLE "model_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"stable_slug" text NOT NULL,
	"preferred_name" text NOT NULL,
	"organization_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_group_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"catalog_entity_id" text,
	"provider_model_key" text,
	"alias" text,
	"enabled" boolean DEFAULT true,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_group_entry_position_nonnegative" CHECK ("model_group_entries"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"native_id" text NOT NULL,
	"raw_name" text,
	"namespace" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_model_observation_kind" CHECK ("model_observations"."kind" in ('reference_model', 'provider_model', 'benchmark_model'))
);
--> statement-breakpoint
CREATE TABLE "observation_entity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolver_version" text NOT NULL,
	"decision_state" text DEFAULT 'linked' NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_observation_link_confidence" CHECK ("observation_entity_links"."confidence" >= 0 and "observation_entity_links"."confidence" <= 1),
	CONSTRAINT "chk_observation_link_method" CHECK ("observation_entity_links"."method" in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override')),
	CONSTRAINT "chk_observation_link_decision" CHECK ("observation_entity_links"."decision_state" in ('linked', 'rejected')),
	CONSTRAINT "chk_observation_link_review" CHECK ("observation_entity_links"."review_state" in ('unreviewed', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "organization_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_name" text NOT NULL,
	"website_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_assertion_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"jti_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_idempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'completed' NOT NULL,
	"result_status" integer,
	"result_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_idempotency_state_check" CHECK ("platform_idempotency"."state" in ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "platform_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"external_server_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"expected_issuer" text NOT NULL,
	"expected_audience" text NOT NULL,
	"expected_subject" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"last_ready_at" timestamp with time zone,
	CONSTRAINT "platform_integrations_state_check" CHECK ("platform_integrations"."state" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "pointer_schema_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_key_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key_id" text NOT NULL,
	"shared_with_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"admin_key_encrypted" text,
	"label" text,
	"is_shared" boolean DEFAULT false,
	"shared_models" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"canonical_model_id" text,
	"catalog_observation_id" text,
	"catalog_entity_id" text,
	"provider_model_id" text NOT NULL,
	"input_price" numeric,
	"output_price" numeric,
	"context_window" integer,
	"max_output" integer,
	"supports_streaming" boolean DEFAULT true,
	"supports_tools" boolean DEFAULT false,
	"supports_vision" boolean DEFAULT false,
	"native_format" text,
	"native_endpoint" text,
	"price_source" text,
	"price_fetched_at" timestamp with time zone,
	"raw_metadata" jsonb,
	CONSTRAINT "provider_models_native_format_check" CHECK ("provider_models"."native_format" is null or "provider_models"."native_format" in ('chat-completions', 'messages', 'responses')),
	CONSTRAINT "provider_models_native_endpoint_check" CHECK ("provider_models"."native_endpoint" is null or ("provider_models"."native_endpoint" like '/%' and "provider_models"."native_endpoint" not like '//%'))
);
--> statement-breakpoint
CREATE TABLE "provider_oauth_device_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"device_code_encrypted" text NOT NULL,
	"user_code" text NOT NULL,
	"verification_uri" text NOT NULL,
	"verification_uri_complete" text,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_oauth_device_status_check" CHECK ("provider_oauth_device_flows"."status" in ('pending', 'denied', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "provider_operational_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"balance" numeric,
	"balance_currency" text,
	"balance_status" text DEFAULT 'never_synced' NOT NULL,
	"balance_error" text,
	"balance_updated_at" timestamp with time zone,
	"rate_limit_data" jsonb,
	"rate_limit_updated_at" timestamp with time zone,
	"account_data" jsonb,
	"account_status" text DEFAULT 'never_synced' NOT NULL,
	"account_error" text,
	"account_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"auth_type" text DEFAULT 'bearer',
	"auth_header" text,
	"models_endpoint" text,
	"balance_endpoint" text,
	"balance_parser" jsonb,
	"balance_poll_interval" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"current_balance" numeric,
	"balance_updated_at" timestamp with time zone,
	"is_builtin" boolean DEFAULT false,
	"manifest_path" text,
	"extra_headers" jsonb,
	"handler_id" text,
	"handler_config" jsonb,
	"rate_limit_data" jsonb,
	"rate_limit_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolver_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"resolver_run_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"entity_id" text,
	"state" text NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"candidate_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_resolver_decision_state" CHECK ("resolver_decisions"."state" in ('linked', 'ambiguous', 'unresolved', 'rejected')),
	CONSTRAINT "chk_resolver_decision_method" CHECK ("resolver_decisions"."method" in ('native_id', 'crosswalk', 'approved_alias', 'structured_match', 'reviewed_override', 'none')),
	CONSTRAINT "chk_resolver_decision_confidence" CHECK ("resolver_decisions"."confidence" >= 0 and "resolver_decisions"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "resolver_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text,
	"resolver_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "chk_resolver_run_status" CHECK ("resolver_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"record_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text,
	"source_id" text NOT NULL,
	"revision" text NOT NULL,
	"source_url" text NOT NULL,
	"license" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"record_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_source_snapshot_state" CHECK ("source_snapshots"."state" in ('staged', 'validated', 'active', 'failed', 'retired')),
	CONSTRAINT "chk_source_snapshot_record_count" CHECK ("source_snapshots"."record_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_sync_states" (
	"source_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'never_synced' NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"record_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text,
	"user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"catalog_entity_id" text,
	"provider_id" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"cache_creation_tokens" integer,
	"cache_read_tokens" integer,
	"cost_usd" numeric,
	"cost_status" text DEFAULT 'unknown' NOT NULL,
	"input_price_snapshot" numeric,
	"output_price_snapshot" numeric,
	"price_source" text,
	"latency_ms" integer,
	"ttfb_ms" integer,
	"generation_ms" integer,
	"tokens_per_second" numeric,
	"queue_time_ms" integer,
	"prompt_time_ms" integer,
	"completion_time_ms" integer,
	"processing_ms" integer,
	"status_code" integer,
	"error_type" text,
	"error_message" text,
	"outcome" text DEFAULT 'success' NOT NULL,
	"instance_id" text,
	"source" text DEFAULT 'proxy',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'local' NOT NULL,
	"email" text,
	"name" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'user' NOT NULL,
	"external_issuer" text,
	"external_subject" text,
	"state" text DEFAULT 'active' NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('local', 'service', 'external')),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'user')),
	CONSTRAINT "users_state_check" CHECK ("users"."state" in ('active', 'disabled')),
	CONSTRAINT "users_local_credentials_check" CHECK (("users"."kind" <> 'local') or ("users"."email" is not null and "users"."password_hash" is not null)),
	CONSTRAINT "users_service_password_check" CHECK (("users"."kind" <> 'service') or "users"."password_hash" is null),
	CONSTRAINT "users_external_identity_check" CHECK (("users"."kind" = 'external' and "users"."external_issuer" is not null and "users"."external_subject" is not null)
      or ("users"."kind" <> 'external' and "users"."external_issuer" is null and "users"."external_subject" is null))
);
--> statement-breakpoint
CREATE INDEX "idx_api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_instance" ON "api_keys" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_managed_installation" ON "api_keys" USING btree ("managed_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_benchmark_source_model" ON "benchmark_metrics" USING btree ("benchmark_id","source_model");--> statement-breakpoint
CREATE INDEX "idx_benchmark_canonical" ON "benchmark_metrics" USING btree ("canonical_model_id");--> statement-breakpoint
CREATE INDEX "idx_benchmark_catalog_observation" ON "benchmark_metrics" USING btree ("catalog_observation_id");--> statement-breakpoint
CREATE INDEX "idx_benchmark_catalog_entity" ON "benchmark_metrics" USING btree ("catalog_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_asset_id_organization" ON "catalog_assets" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_asset_content" ON "catalog_assets" USING btree ("organization_id","kind","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_asset_one_active" ON "catalog_assets" USING btree ("organization_id","kind") WHERE "catalog_assets"."active";--> statement-breakpoint
CREATE INDEX "idx_catalog_asset_active" ON "catalog_assets" USING btree ("organization_id","kind","active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_alias_unique" ON "catalog_generation_aliases" USING btree ("generation_id","source_id","alias","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_asset_unique" ON "catalog_generation_assets" USING btree ("generation_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_benchmark_unique" ON "catalog_generation_benchmark_links" USING btree ("generation_id","benchmark_id","source_model");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_benchmark_entity" ON "catalog_generation_benchmark_links" USING btree ("generation_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_decision_unique" ON "catalog_generation_decisions" USING btree ("generation_id","observation_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_decision_state" ON "catalog_generation_decisions" USING btree ("generation_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_entity_unique" ON "catalog_generation_entities" USING btree ("generation_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_slug_unique" ON "catalog_generation_entities" USING btree ("generation_id","stable_slug");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_entity_entity" ON "catalog_generation_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_observation_unique" ON "catalog_generation_observation_links" USING btree ("generation_id","observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_observation_entity_unique" ON "catalog_generation_observation_links" USING btree ("generation_id","observation_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_observation_entity" ON "catalog_generation_observation_links" USING btree ("generation_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_organization_unique" ON "catalog_generation_organizations" USING btree ("generation_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_provider_model_unique" ON "catalog_generation_provider_routes" USING btree ("generation_id","provider_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_provider_raw_unique" ON "catalog_generation_provider_routes" USING btree ("generation_id","provider_id","raw_model_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_provider_entity" ON "catalog_generation_provider_routes" USING btree ("generation_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_snapshot_unique" ON "catalog_generation_snapshots" USING btree ("generation_id","snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_source_unique" ON "catalog_generation_snapshots" USING btree ("generation_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_snapshot_snapshot" ON "catalog_generation_snapshots" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_generations_state" ON "catalog_generations" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_catalog_generation_parent" ON "catalog_generations" USING btree ("parent_generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_generation_active" ON "catalog_generations" USING btree ((true)) WHERE "catalog_generations"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credential_delivery_key" ON "credential_deliveries" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_credential_delivery_expiry" ON "credential_deliveries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_identity_claim_lookup" ON "identity_claims" USING btree ("claim_type","normalized_value","state");--> statement-breakpoint
CREATE INDEX "idx_identity_claim_entity" ON "identity_claims" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_claim_unique" ON "identity_claims" USING btree ("entity_id",coalesce("source_id", ''),"claim_type","normalized_value");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_instance_model_provider" ON "instance_models" USING btree ("instance_id","model_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_instance_models_instance" ON "instance_models" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_installation_external" ON "managed_app_installations" USING btree ("integration_id","external_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_installation_instance" ON "managed_app_installations" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_rotation_pending_key" ON "managed_key_rotations" USING btree ("pending_key_id");--> statement-breakpoint
CREATE INDEX "idx_management_audit_created" ON "management_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_management_audit_integration" ON "management_audit" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_alias_source_alias" ON "model_aliases" USING btree ("source","alias");--> statement-breakpoint
CREATE INDEX "idx_model_alias_canonical" ON "model_aliases" USING btree ("canonical_model_id");--> statement-breakpoint
CREATE INDEX "idx_model_alias_light" ON "model_aliases" USING btree ("normalized_light");--> statement-breakpoint
CREATE INDEX "idx_model_alias_aggressive" ON "model_aliases" USING btree ("normalized_aggressive");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_entity_stable_slug" ON "model_entities" USING btree ("stable_slug");--> statement-breakpoint
CREATE INDEX "idx_model_entity_organization" ON "model_entities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_model_entity_active" ON "model_entities" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_entry_unique" ON "model_group_entries" USING btree ("group_id","model_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_entry_catalog_unique" ON "model_group_entries" USING btree ("group_id","catalog_entity_id") WHERE "model_group_entries"."catalog_entity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_entry_position_unique" ON "model_group_entries" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "idx_group_entries_group" ON "model_group_entries" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_model_groups_user" ON "model_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_groups_one_default" ON "model_groups" USING btree ("user_id") WHERE "model_groups"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_observation_native" ON "model_observations" USING btree ("source_id","snapshot_id","native_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_observation_id_snapshot" ON "model_observations" USING btree ("id","snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_model_observation_snapshot" ON "model_observations" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_model_observation_source_active" ON "model_observations" USING btree ("source_id","active");--> statement-breakpoint
CREATE INDEX "idx_model_observation_native_lookup" ON "model_observations" USING btree ("source_id","native_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_observation_entity_link_observation" ON "observation_entity_links" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "idx_observation_entity_link_entity" ON "observation_entity_links" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_organization_alias_unique" ON "organization_aliases" USING btree ("organization_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "idx_organization_alias_normalized" ON "organization_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_organizations_canonical_name" ON "organizations" USING btree ("canonical_name");--> statement-breakpoint
CREATE INDEX "idx_organizations_active" ON "organizations" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_assertion_replay" ON "platform_assertion_replays" USING btree ("integration_id","jti_hash");--> statement-breakpoint
CREATE INDEX "idx_platform_assertion_replay_expiry" ON "platform_assertion_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_idempotency_key" ON "platform_idempotency" USING btree ("integration_id","action","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "idx_platform_idempotency_expiry" ON "platform_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_integrations_server" ON "platform_integrations" USING btree ("external_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_integrations_owner" ON "platform_integrations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_share_unique" ON "provider_key_shares" USING btree ("provider_key_id","shared_with_user_id");--> statement-breakpoint
CREATE INDEX "idx_provider_keys_user" ON "provider_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_provider_keys_provider" ON "provider_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_model_unique" ON "provider_models" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "idx_provider_models_model" ON "provider_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "idx_provider_models_catalog_observation" ON "provider_models" USING btree ("catalog_observation_id");--> statement-breakpoint
CREATE INDEX "idx_provider_models_catalog_entity" ON "provider_models" USING btree ("catalog_entity_id");--> statement-breakpoint
CREATE INDEX "idx_provider_oauth_device_user_provider" ON "provider_oauth_device_flows" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_provider_oauth_device_expires" ON "provider_oauth_device_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_operational_user_provider" ON "provider_operational_states" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resolver_decision_run_observation" ON "resolver_decisions" USING btree ("resolver_run_id","observation_id");--> statement-breakpoint
CREATE INDEX "idx_resolver_decision_state" ON "resolver_decisions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_resolver_decision_entity" ON "resolver_decisions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_resolver_run_generation" ON "resolver_runs" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_record_unique" ON "source_records" USING btree ("source_id","record_key");--> statement-breakpoint
CREATE INDEX "idx_source_records_source" ON "source_records" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_source_records_kind" ON "source_records" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_snapshot_revision" ON "source_snapshots" USING btree ("source_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_snapshot_id_source" ON "source_snapshots" USING btree ("id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_snapshot_one_active" ON "source_snapshots" USING btree ("source_id") WHERE "source_snapshots"."active";--> statement-breakpoint
CREATE INDEX "idx_source_snapshot_generation" ON "source_snapshots" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "idx_source_snapshot_active" ON "source_snapshots" USING btree ("source_id","active");--> statement-breakpoint
CREATE INDEX "idx_usage_user" ON "usage_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_created" ON "usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_model" ON "usage_logs" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "idx_usage_catalog_entity" ON "usage_logs" USING btree ("catalog_entity_id");--> statement-breakpoint
CREATE INDEX "idx_usage_provider" ON "usage_logs" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_usage_instance" ON "usage_logs" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_usage_api_key" ON "usage_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_external_identity" ON "users" USING btree ("external_issuer","external_subject") WHERE "users"."external_issuer" is not null and "users"."external_subject" is not null;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_metrics" ADD CONSTRAINT "benchmark_metrics_canonical_model_id_model_catalog_model_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."model_catalog"("model_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_metrics" ADD CONSTRAINT "benchmark_metrics_catalog_observation_id_model_observations_id_fk" FOREIGN KEY ("catalog_observation_id") REFERENCES "public"."model_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_metrics" ADD CONSTRAINT "benchmark_metrics_catalog_entity_id_model_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."model_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_assets" ADD CONSTRAINT "catalog_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_aliases" ADD CONSTRAINT "catalog_generation_aliases_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_aliases" ADD CONSTRAINT "catalog_generation_aliases_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_aliases" ADD CONSTRAINT "catalog_generation_aliases_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_aliases" ADD CONSTRAINT "fk_catalog_generation_alias_link" FOREIGN KEY ("generation_id","observation_id","entity_id") REFERENCES "public"."catalog_generation_observation_links"("generation_id","observation_id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_assets" ADD CONSTRAINT "catalog_generation_assets_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_assets" ADD CONSTRAINT "catalog_generation_assets_asset_id_catalog_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."catalog_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_assets" ADD CONSTRAINT "fk_catalog_generation_asset_organization" FOREIGN KEY ("generation_id","organization_id") REFERENCES "public"."catalog_generation_organizations"("generation_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_assets" ADD CONSTRAINT "fk_catalog_generation_asset_owner" FOREIGN KEY ("asset_id","organization_id") REFERENCES "public"."catalog_assets"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_benchmark_links" ADD CONSTRAINT "catalog_generation_benchmark_links_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_benchmark_links" ADD CONSTRAINT "catalog_generation_benchmark_links_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_benchmark_links" ADD CONSTRAINT "catalog_generation_benchmark_links_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_benchmark_links" ADD CONSTRAINT "fk_catalog_generation_benchmark_link" FOREIGN KEY ("generation_id","observation_id","entity_id") REFERENCES "public"."catalog_generation_observation_links"("generation_id","observation_id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_benchmark_links" ADD CONSTRAINT "fk_catalog_generation_benchmark_observation" FOREIGN KEY ("observation_id","snapshot_id") REFERENCES "public"."model_observations"("id","snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "catalog_generation_decisions_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "catalog_generation_decisions_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "catalog_generation_decisions_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "fk_catalog_generation_decision_snapshot" FOREIGN KEY ("generation_id","snapshot_id") REFERENCES "public"."catalog_generation_snapshots"("generation_id","snapshot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "fk_catalog_generation_decision_observation" FOREIGN KEY ("observation_id","snapshot_id") REFERENCES "public"."model_observations"("id","snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_decisions" ADD CONSTRAINT "fk_catalog_generation_decision_entity" FOREIGN KEY ("generation_id","entity_id") REFERENCES "public"."catalog_generation_entities"("generation_id","entity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_entities" ADD CONSTRAINT "catalog_generation_entities_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_entities" ADD CONSTRAINT "catalog_generation_entities_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_entities" ADD CONSTRAINT "fk_catalog_generation_entity_organization" FOREIGN KEY ("generation_id","organization_id") REFERENCES "public"."catalog_generation_organizations"("generation_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "catalog_generation_observation_links_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "catalog_generation_observation_links_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "catalog_generation_observation_links_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "fk_catalog_generation_link_snapshot" FOREIGN KEY ("generation_id","snapshot_id") REFERENCES "public"."catalog_generation_snapshots"("generation_id","snapshot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "fk_catalog_generation_link_observation" FOREIGN KEY ("observation_id","snapshot_id") REFERENCES "public"."model_observations"("id","snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_observation_links" ADD CONSTRAINT "fk_catalog_generation_link_entity" FOREIGN KEY ("generation_id","entity_id") REFERENCES "public"."catalog_generation_entities"("generation_id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_organizations" ADD CONSTRAINT "catalog_generation_organizations_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_organizations" ADD CONSTRAINT "catalog_generation_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_provider_routes" ADD CONSTRAINT "catalog_generation_provider_routes_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_provider_routes" ADD CONSTRAINT "catalog_generation_provider_routes_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_provider_routes" ADD CONSTRAINT "catalog_generation_provider_routes_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_provider_routes" ADD CONSTRAINT "fk_catalog_generation_route_link" FOREIGN KEY ("generation_id","observation_id","entity_id") REFERENCES "public"."catalog_generation_observation_links"("generation_id","observation_id","entity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_provider_routes" ADD CONSTRAINT "fk_catalog_generation_route_observation" FOREIGN KEY ("observation_id","snapshot_id") REFERENCES "public"."model_observations"("id","snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_snapshots" ADD CONSTRAINT "catalog_generation_snapshots_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_snapshots" ADD CONSTRAINT "catalog_generation_snapshots_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generation_snapshots" ADD CONSTRAINT "fk_catalog_generation_snapshot_source" FOREIGN KEY ("snapshot_id","source_id") REFERENCES "public"."source_snapshots"("id","source_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_generations" ADD CONSTRAINT "fk_catalog_generation_parent" FOREIGN KEY ("parent_generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_deliveries" ADD CONSTRAINT "credential_deliveries_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_deliveries" ADD CONSTRAINT "credential_deliveries_installation_id_managed_app_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."managed_app_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_deliveries" ADD CONSTRAINT "credential_deliveries_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_models" ADD CONSTRAINT "instance_models_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_model_group_id_model_groups_id_fk" FOREIGN KEY ("model_group_id") REFERENCES "public"."model_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_app_installations" ADD CONSTRAINT "managed_app_installations_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_app_installations" ADD CONSTRAINT "managed_app_installations_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_app_installations" ADD CONSTRAINT "managed_installation_active_key_fk" FOREIGN KEY ("active_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_app_installations" ADD CONSTRAINT "managed_installation_pending_key_fk" FOREIGN KEY ("pending_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_key_rotations" ADD CONSTRAINT "managed_key_rotations_installation_id_managed_app_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."managed_app_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_key_rotations" ADD CONSTRAINT "managed_key_rotations_previous_key_id_api_keys_id_fk" FOREIGN KEY ("previous_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_key_rotations" ADD CONSTRAINT "managed_key_rotations_pending_key_id_api_keys_id_fk" FOREIGN KEY ("pending_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_key_rotations" ADD CONSTRAINT "managed_key_rotations_delivery_id_credential_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."credential_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_audit" ADD CONSTRAINT "management_audit_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_canonical_model_id_model_catalog_model_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."model_catalog"("model_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_entities" ADD CONSTRAINT "model_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_group_entries" ADD CONSTRAINT "model_group_entries_group_id_model_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."model_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_group_entries" ADD CONSTRAINT "model_group_entries_catalog_entity_id_model_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."model_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_group_entries" ADD CONSTRAINT "model_group_entries_provider_model_key_provider_models_id_fk" FOREIGN KEY ("provider_model_key") REFERENCES "public"."provider_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_groups" ADD CONSTRAINT "model_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_observations" ADD CONSTRAINT "model_observations_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_entity_links" ADD CONSTRAINT "observation_entity_links_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_entity_links" ADD CONSTRAINT "observation_entity_links_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_entity_links" ADD CONSTRAINT "observation_entity_links_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_assertion_replays" ADD CONSTRAINT "platform_assertion_replays_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_idempotency" ADD CONSTRAINT "platform_idempotency_integration_id_platform_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."platform_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_key_shares" ADD CONSTRAINT "provider_key_shares_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_key_shares" ADD CONSTRAINT "provider_key_shares_shared_with_user_id_users_id_fk" FOREIGN KEY ("shared_with_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_canonical_model_id_model_catalog_model_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."model_catalog"("model_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_catalog_observation_id_model_observations_id_fk" FOREIGN KEY ("catalog_observation_id") REFERENCES "public"."model_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_catalog_entity_id_model_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."model_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_device_flows" ADD CONSTRAINT "provider_oauth_device_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_oauth_device_flows" ADD CONSTRAINT "provider_oauth_device_flows_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operational_states" ADD CONSTRAINT "provider_operational_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operational_states" ADD CONSTRAINT "provider_operational_states_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolver_decisions" ADD CONSTRAINT "resolver_decisions_resolver_run_id_resolver_runs_id_fk" FOREIGN KEY ("resolver_run_id") REFERENCES "public"."resolver_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolver_decisions" ADD CONSTRAINT "resolver_decisions_observation_id_model_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."model_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolver_decisions" ADD CONSTRAINT "resolver_decisions_entity_id_model_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."model_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolver_runs" ADD CONSTRAINT "resolver_runs_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_source_id_source_sync_states_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_sync_states"("source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_generation_id_catalog_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."catalog_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_id_source_sync_states_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source_sync_states"("source_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_catalog_entity_id_model_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."model_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
