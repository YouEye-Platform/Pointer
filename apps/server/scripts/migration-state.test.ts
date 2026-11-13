import { describe, expect, test } from "bun:test";
import { classifySchema, REQUIRED_POINTER_TABLES } from "./migration-state";

const versionedTables = [...REQUIRED_POINTER_TABLES, "pointer_schema_versions"];

describe("migration schema classification", () => {
  test("classifies an empty database as fresh", () => {
    expect(classifySchema([], [], 1)).toEqual({ kind: "fresh", currentVersion: 0 });
  });

  test("uses the highest recorded schema version", () => {
    expect(classifySchema(versionedTables, [1], 1)).toEqual({
      kind: "versioned",
      currentVersion: 1,
    });
    expect(classifySchema(versionedTables, [2, 1], 3)).toEqual({
      kind: "versioned",
      currentVersion: 2,
    });
  });

  test("refuses application tables without a version table", () => {
    expect(() => classifySchema(REQUIRED_POINTER_TABLES, [], 1)).toThrow(
      "without pointer_schema_versions"
    );
  });

  test("refuses incomplete, gapped and future schemas", () => {
    expect(() => classifySchema(["users", "providers", "pointer_schema_versions"], [1], 1)).toThrow(
      "Unsupported or ambiguous Pointer schema"
    );
    expect(() => classifySchema(versionedTables, [], 1)).toThrow("no recorded version");
    expect(() => classifySchema(versionedTables, [1, 3], 3)).toThrow("contiguous");
    expect(() => classifySchema(versionedTables, [0, 1], 1)).toThrow("contiguous");
    expect(() =>
      classifySchema(
        versionedTables,
        Array.from({ length: 27 }, (_, index) => index + 1),
        1
      )
    ).toThrow("newer than this release");
  });

  test("refuses version records without application tables", () => {
    expect(() => classifySchema(["pointer_schema_versions"], [1], 1)).toThrow(
      "without Pointer application tables"
    );
  });
});
