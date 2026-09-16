import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationPath = new URL(
  "../../drizzle/0021_managed_application_routing_owner.sql",
  import.meta.url
);

describe("managed application routing-owner migration", () => {
  test("backfills exact instance ownership before enforcing a restrictive owner foreign key", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain('ADD COLUMN "routing_owner_user_id" text');
    expect(sql).toContain('SET "routing_owner_user_id" = instance."user_id"');
    expect(sql).toContain('ALTER COLUMN "routing_owner_user_id" SET NOT NULL');
    expect(sql).toContain('REFERENCES "users"("id") ON DELETE RESTRICT');
    expect(sql).toContain('CREATE INDEX "idx_managed_installation_routing_owner"');
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i);
  });
});
