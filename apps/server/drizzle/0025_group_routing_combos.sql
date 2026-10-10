ALTER TABLE model_groups ADD COLUMN IF NOT EXISTS routing_combos jsonb NOT NULL DEFAULT '[]'::jsonb;
