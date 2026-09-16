DO $$
DECLARE
  current_delete_action "char";
BEGIN
  SELECT confdeltype
    INTO current_delete_action
    FROM pg_constraint
   WHERE conrelid = 'usage_logs'::regclass
     AND conname = 'usage_logs_api_key_id_api_keys_id_fk';

  IF current_delete_action IS DISTINCT FROM 'n' THEN
    IF current_delete_action IS NOT NULL THEN
      ALTER TABLE "usage_logs"
        DROP CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk";
    END IF;

    ALTER TABLE "usage_logs"
      ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk"
      FOREIGN KEY ("api_key_id")
      REFERENCES "api_keys"("id")
      ON DELETE SET NULL;
  END IF;
END $$;
