-- Endpoint semantic overrides are distinct from wire extensions (customTools, grammar).
ALTER TABLE provider_accounts ADD COLUMN capability_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Keep discovered evidence per endpoint account instead of sharing it across custom endpoints.
ALTER TABLE provider_account_models ADD COLUMN raw_metadata jsonb;
ALTER TABLE provider_account_models ADD COLUMN discovered_at timestamptz;
-- Prior discovery defaulted missing tools metadata to false. Preserve explicit negatives
-- and positive columns; routing also reconciles raw evidence and manifest fallbacks.
UPDATE provider_models SET supports_tools = NULL
WHERE supports_tools = false AND jsonb_typeof(raw_metadata) = 'object'
AND NOT (raw_metadata ?| ARRAY['supports_tool_use','supportsTools','supports_tools'])
AND NOT COALESCE((jsonb_typeof(raw_metadata->'capabilities') = 'object'
         AND (raw_metadata->'capabilities') ?| ARRAY['tools','tool_use','function_calling']), false);
