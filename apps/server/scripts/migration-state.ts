export const REQUIRED_POINTER_TABLES = [
  "api_keys",
  "instances",
  "model_group_entries",
  "model_groups",
  "provider_keys",
  "provider_models",
  "providers",
  "usage_logs",
  "users",
] as const;

export type SchemaState =
  | { kind: "fresh"; currentVersion: 0 }
  | { kind: "versioned"; currentVersion: number };

// A Pointer database is either empty or was created by scripts/migrate.ts, which
// records every applied migration (1..N) in pointer_schema_versions. Anything
// else is refused.
export function classifySchema(
  tableNames: Iterable<string>,
  versions: Iterable<number>,
  latestVersion: number
): SchemaState {
  const tables = new Set(tableNames);
  const recordedVersions = [...versions].sort((a, b) => a - b);
  const applicationTables = [...tables].filter((name) => name !== "pointer_schema_versions");

  if (applicationTables.length === 0) {
    if (recordedVersions.length > 0) {
      throw new Error("Schema version records exist without Pointer application tables");
    }
    return { kind: "fresh", currentVersion: 0 };
  }

  if (!tables.has("pointer_schema_versions")) {
    throw new Error(
      "Unsupported Pointer schema: tables exist without pointer_schema_versions; start from an empty database"
    );
  }

  const missing = REQUIRED_POINTER_TABLES.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    throw new Error(`Unsupported or ambiguous Pointer schema; missing: ${missing.join(", ")}`);
  }

  if (recordedVersions.length === 0) {
    throw new Error("Versioned Pointer schema has no recorded version");
  }
  if (recordedVersions.some((version, index) => version !== index + 1)) {
    throw new Error("Pointer schema version records are not the contiguous sequence 1..N");
  }

  const currentVersion = recordedVersions.length;
  if (currentVersion > latestVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this release (${latestVersion}); ` +
        "Pointer does not downgrade databases, and a database from a pre-release Pointer " +
        "(before the version 1 baseline) needs a fresh Pointer install"
    );
  }

  return { kind: "versioned", currentVersion };
}
