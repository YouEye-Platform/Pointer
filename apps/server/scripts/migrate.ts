import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { classifySchema } from "./migration-state";
import { createPostgresClient } from "../src/db/postgres-client";
import { LATEST_POINTER_SCHEMA_VERSION } from "../src/db/latest-schema.mjs";

const migrationDirectory = process.env.POINTER_MIGRATIONS_DIR
  ? new URL(`file://${process.env.POINTER_MIGRATIONS_DIR.replace(/\/$/, "")}/`)
  : new URL("../drizzle/", import.meta.url);
const migrationPattern = /^(\d{4})_[a-z0-9_]+\.sql$/;

function usage(): never {
  throw new Error(
    "usage: bun run scripts/migrate.ts --expect-database <database> [--check]"
  );
}

function parseArguments(args: string[]) {
  let expectedDatabase = "";
  let checkOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      checkOnly = true;
      continue;
    }
    if (argument === "--expect-database") {
      expectedDatabase = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    usage();
  }

  if (!/^[A-Za-z0-9_-]+$/.test(expectedDatabase)) usage();
  return { expectedDatabase, checkOnly };
}

function databaseNameFromUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error("DATABASE_URL must identify exactly one database");
  }
  return databaseName;
}

async function inventory(
  sql: postgres.Sql | postgres.TransactionSql
): Promise<{ tables: string[]; versions: number[] }> {
  const tableRows = await sql<{ table_name: string }[]>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_type = 'BASE TABLE'
  `;
  const tables = tableRows.map((row) => row.table_name);
  if (!tables.includes("pointer_schema_versions")) return { tables, versions: [] };

  const versionRows = await sql<{ version: number }[]>`
    SELECT version FROM pointer_schema_versions ORDER BY version
  `;
  return { tables, versions: versionRows.map((row) => row.version) };
}

const { expectedDatabase, checkOnly } = parseArguments(Bun.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (databaseNameFromUrl(databaseUrl) !== expectedDatabase) {
  throw new Error("Expected database name does not match DATABASE_URL");
}

const migrationFiles = (await readdir(migrationDirectory))
  .map((name) => {
    const match = migrationPattern.exec(name);
    return match ? { name, version: Number(match[1]) } : null;
  })
  .filter((entry): entry is { name: string; version: number } => entry !== null)
  .sort((a, b) => a.version - b.version);

// Migrations are numbered 1..N without gaps. 0001_baseline.sql creates the whole
// schema of a fresh database; the next schema change is 0002_<name>.sql.
if (
  migrationFiles.length === 0 ||
  migrationFiles.some((migration, index) => migration.version !== index + 1) ||
  migrationFiles.at(-1)?.version !== LATEST_POINTER_SCHEMA_VERSION
) {
  throw new Error("Release migration set does not match the required schema version");
}
const latestVersion = LATEST_POINTER_SCHEMA_VERSION;

const client = createPostgresClient(databaseUrl, 1);

try {
  const [{ database_name: actualDatabase }] = await client<{ database_name: string }[]>`
    SELECT current_database() AS database_name
  `;
  if (actualDatabase !== expectedDatabase) {
    throw new Error("Connected database does not match --expect-database");
  }

  if (checkOnly) {
    const current = await inventory(client);
    const state = classifySchema(current.tables, current.versions, latestVersion);
    console.log(
      `Pointer schema check: state=${state.kind} current=${state.currentVersion} release=${latestVersion}`
    );
  } else {
    await client.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('pointer-schema-migration'))`;
      await transaction`SET LOCAL client_min_messages = warning`;
      const current = await inventory(transaction);
      const state = classifySchema(current.tables, current.versions, latestVersion);
      if (state.kind === "versioned" && state.currentVersion === latestVersion) {
        console.log(`Pointer schema is current at version ${latestVersion}`);
        return;
      }

      const [{ can_create: canCreate }] = await transaction<{ can_create: boolean }[]>`
        SELECT has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create
      `;
      if (!canCreate) {
        throw new Error(
          "Migration role lacks CREATE on the Pointer schema; use the database owner or a dedicated migration role"
        );
      }

      const selected = migrationFiles.filter(
        (migration) => migration.version > state.currentVersion
      );
      for (const migration of selected) {
        const migrationSql = await readFile(
          new URL(migration.name, migrationDirectory),
          "utf8"
        );
        await transaction.unsafe(migrationSql);
        console.log(`Applied ${migration.name}`);
      }

      const versionTable = await transaction<{ present: boolean }[]>`
        SELECT to_regclass(current_schema() || '.pointer_schema_versions') IS NOT NULL AS present
      `;
      if (!versionTable[0]?.present) {
        throw new Error("Migration set did not create pointer_schema_versions");
      }
      for (const migration of selected) {
        await transaction`
          INSERT INTO pointer_schema_versions (version)
          VALUES (${migration.version})
          ON CONFLICT (version) DO NOTHING
        `;
      }

      const finalInventory = await inventory(transaction);
      const finalState = classifySchema(
        finalInventory.tables,
        finalInventory.versions,
        latestVersion
      );
      if (finalState.currentVersion !== latestVersion) {
        throw new Error("Migration completed without reaching the release schema version");
      }
      console.log(`Pointer schema migrated to version ${latestVersion}`);
    });
  }
} finally {
  await client.end();
}
