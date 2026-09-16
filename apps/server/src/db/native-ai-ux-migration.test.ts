import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationPath = new URL("../../drizzle/0020_native_ai_ux.sql", import.meta.url);

describe("native AI UX schema migration", () => {
  test("allows repeated canonical models while keeping exact routes and aliases unique", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('DROP INDEX IF EXISTS "idx_group_entry_catalog_unique"');
    expect(sql).toContain('DROP INDEX IF EXISTS "idx_group_entry_unique"');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_group_entry_route_unique"');
    expect(sql).toContain('"provider_model_key", "provider_account_id"');
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_group_entry_alias_unique"');
    expect(sql).toContain('lower(btrim("alias"))');
  });

  test("adds a first-class upstream release timestamp", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('ADD COLUMN "released_at" timestamp with time zone');
  });
});
