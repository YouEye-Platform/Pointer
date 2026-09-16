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
  | { kind: "legacy"; currentVersion: 0 }
  | { kind: "versioned"; currentVersion: number };

export function classifySchema(
  tableNames: Iterable<string>,
  versions: Iterable<number>,
  latestVersion: number
): SchemaState {
  const tables = new Set(tableNames);
  const recordedVersions = [...versions];
  const applicationTables = [...tables].filter(
    (name) => name !== "pointer_schema_versions" && name !== "__drizzle_migrations"
  );

  if (applicationTables.length === 0) {
    if (recordedVersions.length > 0) {
      throw new Error("Schema version records exist without Pointer application tables");
    }
    return { kind: "fresh", currentVersion: 0 };
  }

  const missing = REQUIRED_POINTER_TABLES.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    throw new Error(`Unsupported or ambiguous Pointer schema; missing: ${missing.join(", ")}`);
  }

  if (!tables.has("pointer_schema_versions")) {
    return { kind: "legacy", currentVersion: 0 };
  }

  if (recordedVersions.some((version) => !Number.isInteger(version) || version < 1)) {
    throw new Error("Pointer schema version records contain an invalid version");
  }

  const currentVersion = recordedVersions.length > 0 ? Math.max(...recordedVersions) : 0;
  if (currentVersion === 0) {
    throw new Error("Versioned Pointer schema has no recorded version");
  }
  if (currentVersion > latestVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this release (${latestVersion})`
    );
  }

  return { kind: "versioned", currentVersion };
}
