import { db, schema } from "../src/db";
import { reconcileCatalog, stageSourceInventorySnapshot, type CatalogFailurePoint } from "../src/services/catalog-reconciliation";
import { assertCatalogPostgresTestDatabase } from "../src/services/catalog-postgres-test-safety";
import type { NormalizedReferenceModel, SourceSnapshot } from "../src/services/sources/types";

const boundary = process.argv[2];
if (!boundary || !["ingestion", "reconciliation", "validation", "activation"].includes(boundary)) {
  throw new Error("Expected ingestion, reconciliation, validation, or activation boundary");
}

assertCatalogPostgresTestDatabase();

if (boundary === "ingestion") {
  const completedAt = new Date("2026-07-17T12:00:00.000Z");
  const sourceId = "termination:ingestion";
  const reference: NormalizedReferenceModel = {
    id: "termination/transaction-boundary-model",
    canonicalSlug: "termination--transaction-boundary-model",
    displayName: "Transaction Boundary Model",
    creator: "termination",
    description: "Process termination transaction fixture",
    contextWindow: 1,
    maxOutput: 1,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: [],
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    cacheReadPricePerMillion: null,
    cacheWritePricePerMillion: null,
    raw: { fixture: true },
    provenance: {
      source: sourceId,
      sourceUrl: "https://termination.example.test/models",
      license: "test-only",
      fetchedAt: completedAt.toISOString(),
    },
  };
  const snapshot: SourceSnapshot<NormalizedReferenceModel> = {
    sourceId,
    records: [reference],
    provenance: reference.provenance,
  };
  await db.transaction(async (tx) => {
    await tx.insert(schema.sourceSyncStates).values({ sourceId, status: "syncing", lastAttemptAt: completedAt, updatedAt: completedAt });
    await stageSourceInventorySnapshot(tx, snapshot, completedAt, {
      onStaged: async () => {
        console.log(`READY:${boundary}`);
        await Bun.sleep(60_000);
      },
    });
  });
} else {
  const pauseAt: Record<Exclude<typeof boundary, "ingestion">, CatalogFailurePoint> = {
    reconciliation: "after_plan",
    validation: "before_activation",
    activation: "after_activation",
  };
  await reconcileCatalog({
    pauseAt: pauseAt[boundary],
    onPause: () => console.log(`READY:${boundary}`),
  });
}
