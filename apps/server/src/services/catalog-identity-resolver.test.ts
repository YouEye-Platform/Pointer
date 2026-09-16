import { describe, expect, test } from "bun:test";
import { IDENTITY_FIXTURES } from "./catalog-fixtures";
import {
  parseIdentityClaims,
  planIdentityRemap,
  resolveCatalogIdentities,
  type IdentityObservationInput,
} from "./catalog-identity-resolver";

const observation = (
  id: string,
  nativeId: string,
  kind: IdentityObservationInput["kind"] = "provider_model",
  organizationHint: string | null = null
): IdentityObservationInput => ({
  id,
  sourceId: kind === "reference_model" ? "openrouter" : kind === "provider_model" ? "provider:test" : "livebench",
  kind,
  nativeId,
  observedName: nativeId,
  organizationHint,
});

describe("catalog identity resolver", () => {
  test("parses structured identity claims without losing raw punctuation", () => {
    const claims = parseIdentityClaims(observation("one", "anthropic/claude-3.7-sonnet-thinking"));
    expect(claims).toMatchObject({
      rawNativeId: "anthropic/claude-3.7-sonnet-thinking",
      namespace: "anthropic",
      creator: "anthropic",
      family: "claude-sonnet",
      version: "3.7",
      variants: ["thinking"],
    });
    expect(parseIdentityClaims(observation("two", "qwen/qwen3-235b-a22b-fp8"))).toMatchObject({ size: "235b-a22b", quantization: "fp8" });
    expect(parseIdentityClaims(observation("three", "google/gemini-2.5-pro-preview-03-25"))).toMatchObject({ family: "gemini-pro", version: "2.5", date: "03-25", variants: ["preview"] });
  });

  test("converges exact cross-provider observations while preserving route-only free suffixes", () => {
    const input = [
      observation("reference-glm", "z-ai/glm-5.1", "reference_model", "z-ai"),
      observation("provider-glm", "glm-5.1", "provider_model", "z-ai"),
      observation("reference-deepseek", "deepseek/deepseek-r1", "reference_model", "deepseek"),
      observation("provider-deepseek", "deepseek/deepseek-r1:free", "provider_model", "deepseek"),
    ];
    const result = resolveCatalogIdentities({ observations: input });
    expect(result.decisions.find((item) => item.observationId === "provider-glm")?.entityId)
      .toBe(result.decisions.find((item) => item.observationId === "reference-glm")?.entityId);
    expect(result.decisions.find((item) => item.observationId === "provider-deepseek")?.entityId)
      .toBe(result.decisions.find((item) => item.observationId === "reference-deepseek")?.entityId);
  });

  test("keeps canonical identity stable when source-native aliases change", () => {
    const first = resolveCatalogIdentities({ observations: [
      observation("reference", "z-ai/glm-5.1", "reference_model", "z-ai"),
    ] });
    const renamed = resolveCatalogIdentities({ observations: [
      observation("reference", "zhipuai/glm_5.1", "reference_model", "z-ai"),
    ] });
    expect(renamed.entities[0]?.id).toBe(first.entities[0]?.id);
    expect(first.entities[0]?.id.startsWith("model/")).toBe(true);
    expect(first.decisions[0]?.evidence).not.toContain("authoritative-native-id:z-ai/glm-5.1");
  });

  test("reclaims deterministic IDs from unsupported stale historical claims", () => {
    for (const kind of ["reference_model", "provider_model"] as const) {
      const current = observation(`current-${kind}`, "vendor/model-2", kind, "vendor");
      const target = resolveCatalogIdentities({ observations: [current] }).entities[0];
      const stale = {
        ...target,
        claims: parseIdentityClaims(observation(`stale-${kind}`, "vendor/model-3", kind, "vendor")),
      };
      const reconciled = resolveCatalogIdentities({ observations: [current], existingEntities: [stale] });
      expect(reconciled.entities).toHaveLength(1);
      expect(reconciled.entities[0]).toMatchObject({ id: target.id, claims: { version: "2" } });
      expect(reconciled.decisions[0]).toMatchObject({ state: "linked", entityId: target.id });
    }
  });

  test("uses persisted creator aliases when an organization name changes", () => {
    const first = resolveCatalogIdentities({ observations: [
      observation("reference", "acme/model-2", "reference_model", "acme"),
    ] });
    const renamed = resolveCatalogIdentities({
      observations: [observation("reference", "renamed/model_2", "reference_model", "Acme AI")],
      creatorAliases: { "Acme AI": "acme" },
    });
    expect(renamed.entities[0]?.id).toBe(first.entities[0]?.id);
    expect(renamed.entities[0]?.organizationId).toBe("org/acme");
  });

  test("keeps thinking, turbo, preview/date, size, and quantization variants distinct", () => {
    const inputs = [
      ["claude-3.7-sonnet", "claude-3.7-sonnet-thinking"],
      ["glm-5-base", "glm-5-turbo"],
      ["gemini-2.5-pro", "gemini-2.5-pro-preview-03-25"],
      ["qwen3-32b", "qwen3-235b-a22b"],
      ["model-7b-fp8", "model-7b-bf16"],
    ];
    for (const [base, variant] of inputs) {
      const result = resolveCatalogIdentities({ observations: [
        observation(`${base}-reference`, base, "reference_model"),
        observation(`${variant}-provider`, variant),
      ] });
      const ids = result.decisions.map((item) => item.entityId).filter(Boolean);
      expect(new Set(ids).size).toBe(2);
    }
  });

  test("keeps provider-only modality, quantization, and negative reasoning variants distinct", () => {
    const inputs = [
      ["vendor/model-7b-fp8", "vendor/model-7b-bf16"],
      ["vendor/model-7b-vision", "vendor/model-7b-audio"],
      ["vendor/model-7b-thinking", "vendor/model-7b-no-thinking"],
      ["vendor/model-7b-reasoning", "vendor/model-7b-non-reasoning"],
    ];
    for (const [left, right] of inputs) {
      const result = resolveCatalogIdentities({ observations: [observation("left", left), observation("right", right)] });
      expect(new Set(result.decisions.map((item) => item.entityId)).size).toBe(2);
      expect(result.entities).toHaveLength(2);
    }
  });

  test("parses attached dotted versions generically without reclassifying family labels", () => {
    expect(parseIdentityClaims(observation("qwen", "qwen/qwen3.6-397b-a17b"))).toMatchObject({ family: "qwen", version: "3.6" });
    expect(parseIdentityClaims(observation("kimi", "moonshotai/kimi-k2.6"))).toMatchObject({ family: "kimi-k2", version: "2.6" });
    expect(parseIdentityClaims(observation("minimax", "minimax/minimax-m2.7"))).toMatchObject({ family: "minimax-m2", version: "2.7" });
    expect(parseIdentityClaims(observation("future", "future-labs/novax7.4-pro"))).toMatchObject({ family: "novax-pro", version: "7.4" });
    expect(parseIdentityClaims(observation("deepseek", "deepseek/deepseek-r1"))).toMatchObject({ family: "deepseek-r1", version: null });
  });

  test("keeps attached dotted releases distinct and groups cross-provider observations", () => {
    for (const releases of [
      ["qwen/qwen3.5", "qwen/qwen3.6"],
      ["moonshotai/kimi-k2.5", "moonshotai/kimi-k2.6"],
      ["minimax/minimax-m2.5", "minimax/minimax-m2.7"],
      ["future-labs/novax7.3-pro", "future-labs/novax7.4-pro"],
    ]) {
      const result = resolveCatalogIdentities({ observations: releases.map((nativeId, index) =>
        observation(`release-${index}`, nativeId, "reference_model")) });
      expect(new Set(result.decisions.map((item) => item.entityId)).size).toBe(2);
    }

    const grouped = resolveCatalogIdentities({ observations: [
      observation("reference", "moonshotai/kimi-k2.6", "reference_model", "moonshotai"),
      observation("provider", "together-ai/kimi-k2.6", "provider_model", "together-ai"),
    ] });
    expect(new Set(grouped.decisions.map((item) => item.entityId)).size).toBe(1);
  });

  test("does not merge explicit runtime variants into an otherwise matching base identity", () => {
    for (const suffix of ["turbo", "thinking", "fp8", "vision"]) {
      const result = resolveCatalogIdentities({ observations: [
        observation("reference", "vendor/model-2", "reference_model", "vendor"),
        observation("provider", `vendor/model-2-${suffix}`, "provider_model", "vendor"),
      ] });
      expect(new Set(result.decisions.map((item) => item.entityId)).size).toBe(2);
      expect(result.decisions.find((item) => item.observationId === "provider")?.blockers.length).toBeGreaterThan(0);
    }
  });

  test("uses structured identity boundaries when generating provider-only entity IDs", () => {
    const result = resolveCatalogIdentities({ observations: [
      observation("left", "a-b/c-2"),
      observation("right", "a/b-c-2"),
    ] });
    expect(new Set(result.decisions.map((item) => item.entityId)).size).toBe(2);
  });

  test("keeps underspecified labels ambiguous and unknown labels unresolved", () => {
    const result = resolveCatalogIdentities({ observations: [
      observation("glm-base", "z-ai/glm-5-base", "reference_model"),
      observation("glm-turbo", "z-ai/glm-5-turbo", "reference_model"),
      observation("glm-unknown", "GLM 5", "benchmark_model"),
      observation("unknown", "deepseek-next", "benchmark_model"),
    ] });
    expect(result.decisions.find((item) => item.observationId === "glm-unknown")).toMatchObject({ state: "ambiguous", entityId: null });
    expect(result.decisions.find((item) => item.observationId === "unknown")).toMatchObject({ state: "unresolved", entityId: null });
  });

  test("uses reviewed overrides, crosswalks, and approved aliases before scoring", () => {
    const reference = observation("reference", "vendor/model-2.0", "reference_model", "vendor");
    const aliases = [
      observation("prior", "unrelated-prior"),
      observation("crosswalk", "unrelated-crosswalk"),
      observation("alias", "Friendly Alias"),
    ];
    const target = resolveCatalogIdentities({ observations: [reference] }).entities[0];
    const result = resolveCatalogIdentities({
      observations: [reference, ...aliases],
      existingEntities: [target],
      reviewedOverrides: { prior: target.id },
      authoritativeCrosswalk: { "provider:test:unrelated-crosswalk": target.id },
      approvedAliases: { "friendly-alias": target.id },
    });
    expect(result.decisions.find((item) => item.observationId === "prior")?.method).toBe("reviewed_override");
    expect(result.decisions.find((item) => item.observationId === "crosswalk")?.method).toBe("crosswalk");
    expect(result.decisions.find((item) => item.observationId === "alias")?.method).toBe("approved_alias");
  });

  test("preserves explicit rejections without blocking a later approved override", () => {
    const reference = observation("reference", "vendor/model-2", "reference_model", "vendor");
    const target = resolveCatalogIdentities({ observations: [reference] }).entities[0];
    const provider = observation("provider", "vendor/model-2", "provider_model", "vendor");
    const rejected = resolveCatalogIdentities({
      observations: [reference, provider],
      existingEntities: [target],
      rejectedEntityIds: { provider: [target.id] },
    });
    expect(rejected.decisions.find((item) => item.observationId === "provider")).toMatchObject({
      state: "rejected",
      entityId: null,
      blockers: [`reviewed-rejection:${target.id}`],
    });

    const approved = resolveCatalogIdentities({
      observations: [reference, provider],
      existingEntities: [target],
      reviewedOverrides: { provider: target.id },
      rejectedEntityIds: { provider: [target.id] },
    });
    expect(approved.decisions.find((item) => item.observationId === "provider")).toMatchObject({
      state: "linked",
      method: "reviewed_override",
      entityId: target.id,
    });
  });

  test("does not turn ruled-out versions into false ambiguity", () => {
    const result = resolveCatalogIdentities({ observations: [
      observation("glm-45", "z-ai/glm-4.5", "reference_model", "z-ai"),
      observation("glm-46", "z-ai/glm-4.6", "reference_model", "z-ai"),
      observation("glm-53", "GLM-5.3", "benchmark_model"),
    ] });

    expect(result.decisions.find((item) => item.observationId === "glm-53")).toMatchObject({
      state: "linked",
      method: "native_id",
    });
    expect(result.decisions.find((item) => item.observationId === "glm-53")?.entityId)
      .not.toBe(result.decisions.find((item) => item.observationId === "glm-45")?.entityId);
  });

  test("applies only reviewed exact benchmark configuration aliases", () => {
    const reference = observation("kimi-reference", "moonshotai/kimi-k3", "reference_model", "moonshotai");
    const reviewed = { ...observation("kimi-max", "kimi-k3-max", "benchmark_model"), sourceId: "lmarena" };
    const nearMatch = { ...observation("kimi-maxi", "kimi-k3-maxi", "benchmark_model"), sourceId: "lmarena" };
    const result = resolveCatalogIdentities({ observations: [reference, reviewed, nearMatch] });
    const target = result.decisions.find((item) => item.observationId === reference.id)?.entityId;

    expect(result.decisions.find((item) => item.observationId === reviewed.id)).toMatchObject({
      state: "linked",
      method: "reviewed_override",
      entityId: target,
    });
    expect(result.decisions.find((item) => item.observationId === nearMatch.id)?.entityId).not.toBe(target);
  });

  test("produces the same result when a weak provider identity predates a reference identity", () => {
    const provider = observation("provider", "model-2");
    const historical = resolveCatalogIdentities({ observations: [provider] });
    const current = [
      observation("reference", "vendor/model-2", "reference_model", "vendor"),
      provider,
    ];
    const cold = resolveCatalogIdentities({ observations: current });
    const warm = resolveCatalogIdentities({ observations: current, existingEntities: historical.entities });
    expect(warm).toEqual(cold);
    expect(new Set(warm.decisions.map((item) => item.entityId))).toEqual(new Set([warm.entities[0].id]));
  });

  test("resolves reviewed provider-only targets and ignores random observation ID ordering", () => {
    const provider = observation("seed", "vendor/model-2");
    const seeded = resolveCatalogIdentities({ observations: [provider] });
    const target = seeded.entities[0];
    const reviewed = resolveCatalogIdentities({
      observations: [observation("reviewed", "unrelated-name")],
      existingEntities: [target],
      authoritativeCrosswalk: { "provider:test:unrelated-name": target.id },
    });
    expect(reviewed.decisions[0]).toMatchObject({ state: "linked", method: "crosswalk", entityId: target.id });

    const facts = [observation("z-random", "vendor/model-2"), observation("a-random", "Model 2", "benchmark_model")];
    const swappedIds = [{ ...facts[0], id: "a-random" }, { ...facts[1], id: "z-random" }];
    expect(resolveCatalogIdentities({ observations: swappedIds }).entities.map((entity) => entity.id))
      .toEqual(resolveCatalogIdentities({ observations: facts }).entities.map((entity) => entity.id));
  });

  test("is deterministic under every reviewed fixture permutation", () => {
    for (const fixture of IDENTITY_FIXTURES) {
      const records = fixture.observations.map((nativeId, index) => {
        const kind = fixture.classification === "distinct_variant"
          ? "reference_model"
          : fixture.classification === "same_entity"
            ? (index === 0 ? "reference_model" : "provider_model")
            : "benchmark_model";
        const organizationHint = fixture.classification === "same_entity"
          ? (fixture.family === "glm" ? "z-ai" : fixture.family)
          : null;
        return {
          ...observation(`${fixture.id}-${index}`, nativeId, kind, organizationHint),
          observedName: fixture.expectedNames[index] ?? (index === 0 ? fixture.expectedNames[0] : nativeId),
        };
      });
      const context = fixture.classification === "ambiguous"
        ? [
          observation(`${fixture.id}-base`, "z-ai/glm-5-base", "reference_model", "z-ai"),
          observation(`${fixture.id}-turbo`, "z-ai/glm-5-turbo", "reference_model", "z-ai"),
        ]
        : [];
      const forward = resolveCatalogIdentities({ observations: [...context, ...records] });
      const reverse = resolveCatalogIdentities({ observations: [...context, ...records].reverse() });
      expect(reverse).toEqual(forward);
      const subjectDecisions = records.map((record) => forward.decisions.find((item) => item.observationId === record.id)!);
      expect(subjectDecisions.map((item) => item.entityId)).toEqual(fixture.expectedEntityIds);
      const expectedIds = [...new Set(fixture.expectedEntityIds.filter((id): id is string => Boolean(id)))];
      expect(expectedIds.map((id) => forward.entities.find((entity) => entity.id === id)?.preferredName)).toEqual(fixture.expectedNames);
      expect(fixture.evidence.every((rationale) => rationale.trim().length > 0)).toBe(true);
      const resolverEvidence = subjectDecisions.flatMap((item) => [...item.evidence, ...item.blockers]);
      for (const fragment of fixture.expectedResolverEvidence) {
        expect(resolverEvidence.some((item) => item.includes(fragment))).toBe(true);
      }
      if (fixture.classification === "same_entity") {
        expect(new Set(subjectDecisions.map((item) => item.entityId)).size).toBe(1);
      }
      if (fixture.classification === "distinct_variant") {
        expect(new Set(subjectDecisions.map((item) => item.entityId)).size).toBe(fixture.observations.length);
      }
      if (fixture.classification === "ambiguous") expect(subjectDecisions.every((item) => item.state === "ambiguous")).toBe(true);
      if (fixture.classification === "unresolved") expect(subjectDecisions.every((item) => item.state === "unresolved")).toBe(true);
    }
  });

  test("normalization is idempotent and fuzzed separators cannot crash resolution", () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const separators = ["-", "_", ".", "/", " ", "::"];
    for (let index = 0; index < 500; index += 1) {
      const raw = Array.from({ length: 8 }, () => random() < 0.5
        ? String.fromCharCode(97 + Math.floor(random() * 26))
        : separators[Math.floor(random() * separators.length)]).join("");
      const first = parseIdentityClaims(observation(`fuzz-${index}`, raw));
      const second = parseIdentityClaims(observation(`fuzz-${index}-second`, first.normalized));
      expect(second.normalized).toBe(first.normalized);
      expect(() => resolveCatalogIdentities({ observations: [observation(`fuzz-${index}`, raw)] })).not.toThrow();
    }
  });

  test("produces deterministic merge, split, and remap plans", () => {
    const base = resolveCatalogIdentities({ observations: [
      observation("one", "vendor/model-1", "reference_model"),
      observation("two", "vendor/model-2", "reference_model"),
      observation("three", "vendor/model-3", "reference_model"),
    ] }).decisions;
    const third = base.find((item) => item.observationId === "three")!;
    const previous = [...base, { ...third, observationId: "four" }];
    const next = previous.map((item) => item.observationId === "one"
      ? { ...item, entityId: "merged" }
      : item.observationId === "two"
        ? { ...item, entityId: "merged" }
        : { ...item, entityId: item.observationId === "three" ? "split-a" : "split-b" });
    const remap = planIdentityRemap(previous, next);
    const originalByObservation = new Map(base.map((item) => [item.observationId, item.entityId!]));
    expect(remap.merges).toEqual([{ fromEntityIds: [originalByObservation.get("one")!, originalByObservation.get("two")!].sort(), toEntityId: "merged" }]);
    expect(remap.splits).toEqual([{ fromEntityId: originalByObservation.get("three")!, toEntityIds: ["split-a", "split-b"] }]);
    expect(remap.remaps).toHaveLength(4);
  });
});
