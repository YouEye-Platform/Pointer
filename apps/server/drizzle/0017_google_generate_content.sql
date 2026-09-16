ALTER TABLE "provider_models"
  DROP CONSTRAINT IF EXISTS "provider_models_native_format_check";

ALTER TABLE "provider_models"
  ADD CONSTRAINT "provider_models_native_format_check"
  CHECK (
    "native_format" IS NULL
    OR "native_format" IN (
      'chat-completions',
      'messages',
      'responses',
      'google-generate-content'
    )
  );
