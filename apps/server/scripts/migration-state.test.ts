import { describe, expect, test } from "bun:test";
import { classifySchema, REQUIRED_POINTER_TABLES } from "./migration-state";

describe("migration schema classification", () => {
  test("classifies an empty database as fresh", () => {
    expect(classifySchema([], [], 16)).toEqual({ kind: "fresh", currentVersion: 0 });
  });

  test("classifies the supported pre-version schema as legacy", () => {
    expect(classifySchema(REQUIRED_POINTER_TABLES, [], 16)).toEqual({
      kind: "legacy",
      currentVersion: 0,
    });
  });

  test("uses the highest recorded schema version", () => {
    expect(
      classifySchema([...REQUIRED_POINTER_TABLES, "pointer_schema_versions"], [1, 12, 16], 16)
    ).toEqual({ kind: "versioned", currentVersion: 16 });
  });

  test("refuses incomplete and future schemas", () => {
    expect(() => classifySchema(["users", "providers"], [], 16)).toThrow(
      "Unsupported or ambiguous Pointer schema"
    );
    expect(() =>
      classifySchema([...REQUIRED_POINTER_TABLES, "pointer_schema_versions"], [17], 16)
    ).toThrow("newer than this release");
  });
});
