import { describe, expect, test } from "bun:test";
import { unambiguousTelemetryModelIds } from "./catalog-telemetry-identity-core";

describe("catalog telemetry identities", () => {
  test("expands an entity to its distinct compatible telemetry IDs", () => {
    expect(unambiguousTelemetryModelIds("model/current", [
      { value: "provider/raw", entityId: "model/current" },
      { value: "legacy/canonical", entityId: "model/current" },
      { value: "provider/raw", entityId: "model/current" },
    ])).toEqual(["model/current", "legacy/canonical", "provider/raw"]);
  });

  test("excludes identifiers associated with more than one entity", () => {
    expect(unambiguousTelemetryModelIds("model/current", [
      { value: "shared-name", entityId: "model/current" },
      { value: "shared-name", entityId: "model/variant" },
      { value: "safe-name", entityId: "model/current" },
    ])).toEqual(["model/current", "safe-name"]);
  });

  test("always preserves exact entity matching", () => {
    expect(unambiguousTelemetryModelIds("model/current", [])).toEqual(["model/current"]);
  });
});
