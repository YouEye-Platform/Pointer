import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { assertCatalogPostgresTestDatabase } from "./catalog-postgres-test-safety";

const integrationTest = process.env.CATALOG_POSTGRES_TEST === "1" ? test : test.skip;

const waitForReady = async (stream: ReadableStream<Uint8Array>, boundary: string) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const timeout = setTimeout(() => reader.cancel("termination fixture timeout"), 10_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Termination fixture exited before ${boundary}`);
      output += decoder.decode(value, { stream: true });
      if (output.includes(`READY:${boundary}`)) return;
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
};

describe("catalog transaction process termination", () => {
  integrationTest("keeps the prior pointer at every killed process boundary", async () => {
    assertCatalogPostgresTestDatabase();
    const [before] = await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)
      .where(eq(schema.catalogGenerations.state, "active")).limit(1);
    expect(before).toBeDefined();
    for (const boundary of ["ingestion", "reconciliation", "validation", "activation"] as const) {
      const generationsBefore = await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations);
      const snapshotsBefore = await db.select({ id: schema.sourceSnapshots.id }).from(schema.sourceSnapshots);
      const child = Bun.spawn([process.execPath, "run", "scripts/catalog-termination-fixture.ts", boundary], {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForReady(child.stdout, boundary);
      child.kill("SIGKILL");
      await child.exited;
      const [active] = await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)
        .where(eq(schema.catalogGenerations.state, "active")).limit(1);
      expect(active?.id).toBe(before.id);
      expect((await db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)).map((row) => row.id).sort())
        .toEqual(generationsBefore.map((row) => row.id).sort());
      expect((await db.select({ id: schema.sourceSnapshots.id }).from(schema.sourceSnapshots)).map((row) => row.id).sort())
        .toEqual(snapshotsBefore.map((row) => row.id).sort());
      expect(await db.select().from(schema.catalogGenerations).where(inArray(schema.catalogGenerations.state, ["building", "ready"]))).toHaveLength(0);
      expect(await db.select().from(schema.sourceSyncStates).where(eq(schema.sourceSyncStates.sourceId, "termination:ingestion"))).toHaveLength(0);
    }
  }, 30_000);
});
