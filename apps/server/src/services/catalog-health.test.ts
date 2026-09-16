import { describe, expect, test } from "bun:test";
import { catalogCorpusSchema, CATALOG_CONTRACT_VERSION, CATALOG_INVARIANTS } from "./catalog-contracts";
import { BROKEN_CATALOG_CORPUS_FIXTURE, IDENTITY_FIXTURES } from "./catalog-fixtures";
import { analyzeCatalogCorpus, assertCatalogInvariants, stableCatalogReport } from "./catalog-health";
import { friendlyModelName } from "./model-identity";

describe("catalog foundation", () => {
  test("validates a corpus whose domains are separated", () => {
    const parsed = catalogCorpusSchema.parse(BROKEN_CATALOG_CORPUS_FIXTURE);
    expect(parsed.entities[0]).not.toHaveProperty("providerModelId");
    expect(parsed.providerRoutes[0]).not.toHaveProperty("preferredName");
    expect(parsed.decisions[0]).toMatchObject({ observationId: expect.any(String), resolverVersion: expect.any(String) });
    expect(CATALOG_CONTRACT_VERSION).toBe("1");
    expect(CATALOG_INVARIANTS.length).toBeGreaterThanOrEqual(8);
  });

  test("produces deterministic findings for known current failures", () => {
    const report = analyzeCatalogCorpus(BROKEN_CATALOG_CORPUS_FIXTURE);
    expect(report.counts).toMatchObject({
      observations: 3,
      entities: 4,
      ambiguousDecisions: 1,
      orphanEntities: 2,
      missingOrganizations: 3,
      missingAssets: 4,
      iconFallbacks: 3,
      suspiciousNames: 2,
    });
    expect(report.findings.suspiciousNames).toEqual([
      { entityId: "benchmark/glm-5", name: "Glm 5", reasons: ["acronym_casing"] },
      { entityId: "provider/glm-5-1", name: "GLM 5 1", reasons: ["version_punctuation_lost"] },
    ]);
    expect(stableCatalogReport(report)).toBe(stableCatalogReport(analyzeCatalogCorpus(structuredClone(BROKEN_CATALOG_CORPUS_FIXTURE))));
  });

  test("turns invariants into machine-checkable violations", () => {
    expect(assertCatalogInvariants(BROKEN_CATALOG_CORPUS_FIXTURE)).toEqual([
      "2 active entities lack active observation support",
    ]);
  });

  test("records reviewed identity expectations across high-risk model families", () => {
    expect(new Set(IDENTITY_FIXTURES.map((fixture) => fixture.family))).toEqual(new Set(["glm", "claude", "gemini", "gpt", "qwen", "deepseek"]));
    expect(new Set(IDENTITY_FIXTURES.map((fixture) => fixture.classification))).toEqual(new Set(["same_entity", "distinct_variant", "ambiguous", "unresolved"]));
    for (const fixture of IDENTITY_FIXTURES) {
      expect(fixture.evidence.length).toBeGreaterThan(0);
      expect(fixture.expectedEntityIds).toHaveLength(fixture.observations.length);
    }
  });

  test("captures the legacy fallback naming regression without accepting it", () => {
    const glm = IDENTITY_FIXTURES.find((fixture) => fixture.id === "glm-5.1-cross-provider")!;
    expect(glm.expectedNames).toEqual(["GLM 5.1"]);
    expect(friendlyModelName("glm-5.1")).toBe("Glm 5 1");
    expect(friendlyModelName("glm-5.1")).not.toBe(glm.expectedNames[0]);
  });
});
