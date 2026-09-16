import { readFile } from "node:fs/promises";
import { createPostgresClient } from "../src/db/postgres-client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationUrls = [
  new URL("../drizzle/0006_catalog_foundation.sql", import.meta.url),
  new URL("../drizzle/0007_catalog_reconciliation.sql", import.meta.url),
  new URL("../drizzle/0008_dynamic_catalog_names.sql", import.meta.url),
  new URL("../drizzle/0009_usage_catalog_entity.sql", import.meta.url),
  new URL("../drizzle/0010_remove_pre_release_legacy_views.sql", import.meta.url),
  new URL("../drizzle/0011_model_group_entry_order.sql", import.meta.url),
  new URL("../drizzle/0012_benchmark_source_credentials.sql", import.meta.url),
  new URL("../drizzle/0013_provider_subscription_oauth.sql", import.meta.url),
  new URL("../drizzle/0014_usage_api_key_set_null.sql", import.meta.url),
  new URL("../drizzle/0015_model_group_catalog_identity.sql", import.meta.url),
  new URL("../drizzle/0016_managed_platform.sql", import.meta.url),
];
const migrations = await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")));
const client = createPostgresClient(databaseUrl, 1);

try {
  await client.begin(async (tx) => {
    for (const migration of migrations) await tx.unsafe(migration);
  });
  console.log("Catalog schema integrity objects applied");
} finally {
  await client.end();
}
