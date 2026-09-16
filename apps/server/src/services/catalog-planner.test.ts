import { describe, expect, test } from "bun:test";
import { planCanonicalCatalog, type ProviderModelInput } from "./catalog-planner";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel, SourceProvenance } from "./sources/types";

const provenance: SourceProvenance = { source: "openrouter", sourceUrl: "https://openrouter.ai/api/v1/models", license: "public", fetchedAt: "2026-07-10T00:00:00Z" };
const reference: NormalizedReferenceModel = {
  id: "anthropic/claude-3.7-sonnet",
  canonicalSlug: null,
  displayName: "Claude 3.7 Sonnet",
  creator: "anthropic",
  description: "Reference description",
  contextWindow: 200000,
  maxOutput: 64000,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools"],
  inputPricePerMillion: 3,
  outputPricePerMillion: 15,
  cacheReadPricePerMillion: null,
  cacheWritePricePerMillion: null,
  raw: { id: "anthropic/claude-3.7-sonnet" },
  provenance,
};

const provider = (id: string, providerId: string, rawModelId: string): ProviderModelInput => ({
  id,
  providerId,
  providerName: providerId,
  rawModelId,
  existingModelId: rawModelId,
  inputPrice: null,
  outputPrice: null,
  contextWindow: null,
  maxOutput: null,
  supportsTools: false,
  supportsVision: false,
  supportsStreaming: true,
});

describe("canonical catalog planner", () => {
  test("unions multiple provider IDs under one reference canonical", () => {
    const plan = planCanonicalCatalog([reference], [
      provider("pm-1", "anthropic", "claude-3.7-sonnet"),
      provider("pm-2", "openrouter", "anthropic/claude-3.7-sonnet"),
    ], []);
    expect(plan.models).toHaveLength(1);
    expect(plan.providerMappings.map((mapping) => mapping.canonicalModelId)).toEqual([
      "anthropic/claude-3.7-sonnet",
      "anthropic/claude-3.7-sonnet",
    ]);
    expect(plan.models[0].name).toBe("Claude 3.7 Sonnet");
    expect(plan.models[0].referenceInputPrice).toBe(3);
  });

  test("keeps every provider-only model with a friendly stable identity", () => {
    const plan = planCanonicalCatalog([], [provider("pm-1", "acme", "acme_ultra-model-v2")], []);
    expect(plan.models[0]).toMatchObject({ id: "provider/acme-ultra-model-v2", name: "Acme Ultra Model V2", metadataSource: "provider" });
    expect(plan.providerMappings[0].canonicalModelId).toBe(plan.models[0].id);
  });

  test("prefers the provider's human-readable display name for provider-only models", () => {
    const model = {
      ...provider("pm-1", "acme", "acme_ultra-model-v2"),
      displayName: "Acme Ultra Model",
    };
    const plan = planCanonicalCatalog([], [model], []);
    expect(plan.models[0]).toMatchObject({
      id: "provider/acme-ultra-model-v2",
      name: "Acme Ultra Model",
      metadataSource: "provider",
    });
  });

  test("does not aggressively merge distinct provider-only variants", () => {
    const plan = planCanonicalCatalog([], [
      provider("pm-1", "deepinfra", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"),
      provider("pm-2", "deepinfra", "meta-llama/Meta-Llama-3.1-8B-Instruct"),
    ], []);
    expect(plan.models).toHaveLength(2);
    expect(new Set(plan.providerMappings.map((mapping) => mapping.canonicalModelId)).size).toBe(2);
  });

  test("keeps useful unmatched benchmark models navigable", () => {
    const benchmark: NormalizedBenchmarkRecord = {
      benchmarkId: "aider",
      sourceModel: "future-code-model",
      metrics: { passRate: 0.9 },
      raw: {},
      provenance: { ...provenance, source: "aider", license: "Apache-2.0" },
    };
    const plan = planCanonicalCatalog([], [], [benchmark]);
    expect(plan.models[0]).toMatchObject({ id: "benchmark/future-code-model", name: "Future Code Model", supportsStreaming: false });
    expect(plan.benchmarks[0].canonicalModelId).toBe("benchmark/future-code-model");
  });

  test("reference metadata takes precedence over provider raw names", () => {
    const plan = planCanonicalCatalog([reference], [provider("pm-1", "anthropic", "anthropic/claude-3.7-sonnet")], []);
    expect(plan.models[0]).toMatchObject({ name: "Claude 3.7 Sonnet", description: "Reference description", metadataSource: "openrouter" });
  });

  test("disambiguates duplicate upstream slugs using stable model IDs", () => {
    const second = { ...reference, id: "anthropic/claude-3.7-sonnet-20250219", canonicalSlug: "anthropic/shared-slug" };
    const first = { ...reference, canonicalSlug: "anthropic/shared-slug" };
    const plan = planCanonicalCatalog([first, second], [], []);
    expect(new Set(plan.models.map((model) => model.slug)).size).toBe(2);
    expect(plan.models.map((model) => model.slug).sort()).toEqual([
      "anthropic--claude-3.7-sonnet",
      "anthropic--claude-3.7-sonnet-20250219",
    ]);
  });
});
