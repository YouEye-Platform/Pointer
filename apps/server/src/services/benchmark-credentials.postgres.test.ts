import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import {
  deleteBenchmarkCredential,
  getBenchmarkCredential,
  hasBenchmarkCredential,
  saveBenchmarkCredential,
} from "./benchmark-credentials";
import { assertCatalogPostgresTestDatabase } from "./catalog-postgres-test-safety";

const enabled = process.env.CATALOG_POSTGRES_TEST === "1";
const sourceId = "benchmark-credential-test";
const plaintext = "public-test-fixture-value";

describe.skipIf(!enabled)("benchmark credential PostgreSQL integration", () => {
  beforeAll(async () => {
    assertCatalogPostgresTestDatabase();
    await deleteBenchmarkCredential(sourceId);
  });

  afterAll(async () => {
    await deleteBenchmarkCredential(sourceId);
  });

  test("stores ciphertext, returns only explicit decrypted reads, and deletes cleanly", async () => {
    await saveBenchmarkCredential(sourceId, plaintext);
    expect(await hasBenchmarkCredential(sourceId)).toBe(true);
    expect(await getBenchmarkCredential(sourceId)).toBe(plaintext);

    const [stored] = await db.select().from(schema.benchmarkSourceCredentials)
      .where(eq(schema.benchmarkSourceCredentials.sourceId, sourceId));
    expect(stored.secretEncrypted).not.toBe(plaintext);
    expect(stored.secretEncrypted).not.toContain(plaintext);

    await deleteBenchmarkCredential(sourceId);
    expect(await hasBenchmarkCredential(sourceId)).toBe(false);
    expect(await getBenchmarkCredential(sourceId)).toBeNull();
  });
});
