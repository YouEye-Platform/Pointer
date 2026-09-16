import { describe, expect, test } from "bun:test";
import { buildTestModelTargets, type TestModelTargetRow } from "./test-model-targets";

function target(overrides: Partial<TestModelTargetRow> = {}): TestModelTargetRow {
  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    providerAccountId: "acc_openrouter_personal",
    providerAccountNickname: "Personal",
    providerStatus: "active",
    providerManifestPath: "providers.d/openrouter.yaml",
    modelId: "openai/gpt-5",
    providerModelId: "openai/gpt-5",
    canonicalModelId: "openai/gpt-5",
    canonicalName: "GPT-5",
    ...overrides,
  };
}

describe("test model targets", () => {
  test("groups a canonical model across providers while preserving raw route IDs", () => {
    const result = buildTestModelTargets([
      target(),
      target({
        providerId: "openai",
        providerName: "OpenAI",
        providerManifestPath: "providers.d/openai.yaml",
        providerModelId: "gpt-5-2025-08-07",
      }),
    ]);

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.providers).toEqual([
      expect.objectContaining({ providerId: "openai", rawModelId: "gpt-5-2025-08-07" }),
      expect.objectContaining({ providerId: "openrouter", rawModelId: "openai/gpt-5" }),
    ]);
    expect(result.providers).toEqual([
      expect.objectContaining({ id: "openai", modelCount: 1 }),
      expect.objectContaining({ id: "openrouter", modelCount: 1 }),
    ]);
  });

  test("keeps provider-only models separate and excludes inactive providers", () => {
    const result = buildTestModelTargets([
      target({ canonicalModelId: null, canonicalName: null, providerModelId: "local-model" }),
      target({
        providerId: "custom-provider",
        providerName: "Custom Provider",
        providerManifestPath: null,
        canonicalModelId: null,
        canonicalName: null,
        providerModelId: "local-model",
      }),
      target({ providerId: "disabled", providerStatus: "disabled" }),
    ]);

    expect(result.models.map((model) => model.id)).toEqual([
      "provider:custom-provider:local-model",
      "provider:openrouter:local-model",
    ]);
    expect(result.providers.map((provider) => provider.id)).toEqual(["custom-provider", "openrouter"]);
  });

  test("deduplicates rows caused by multiple credentials", () => {
    const row = target();
    const result = buildTestModelTargets([row, row]);

    expect(result.models[0]?.providers).toHaveLength(1);
    expect(result.providers[0]?.modelCount).toBe(1);
  });

  test("keeps separate accounts for the same provider as exact test routes", () => {
    const result = buildTestModelTargets([
      target(),
      target({ providerAccountId: "acc_openrouter_work", providerAccountNickname: "Work" }),
    ]);

    expect(result.models[0]?.providers).toHaveLength(2);
    expect(result.models[0]?.providers.map((item) => item.providerAccountNickname)).toEqual([
      "Personal",
      "Work",
    ]);
  });

  test("uses the catalog Recommended order before alphabetical fallback", () => {
    const result = buildTestModelTargets([
      target({ catalogEntityId: "catalog/zulu", canonicalModelId: "zulu", canonicalName: "Zulu" }),
      target({ catalogEntityId: "catalog/alpha", canonicalModelId: "alpha", canonicalName: "Alpha" }),
      target({ catalogEntityId: "catalog/other", canonicalModelId: "other", canonicalName: "Other" }),
    ], ["catalog/zulu", "catalog/alpha"]);

    expect(result.models.map((model) => model.id)).toEqual([
      "catalog/zulu",
      "catalog/alpha",
      "catalog/other",
    ]);
  });
});
