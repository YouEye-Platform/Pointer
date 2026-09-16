import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

const migrationPath = new URL("../../drizzle/0019_youeye_ai_parity.sql", import.meta.url);

describe("YouEye AI parity migration", () => {
  test("makes nicknames optional without allowing duplicate non-null names", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('ALTER COLUMN "nickname" DROP NOT NULL');
    expect(sql).toContain('WHERE "nickname" IS NOT NULL');
  });

  test("attributes direct routes and telemetry to an exact provider account", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain('ALTER TABLE "instance_models" ADD COLUMN "provider_account_id"');
    expect(sql).toContain('ALTER TABLE "usage_logs" ADD COLUMN "provider_account_id"');
    expect(sql).toContain('ON DELETE SET NULL');
  });
});
