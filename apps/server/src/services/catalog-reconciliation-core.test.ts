import { describe, expect, test } from "bun:test";
import {
  buildCatalogGenerationPlan,
  catalogContentHash,
  catalogGenerationContentHash,
  catalogInventoryHash,
  catalogSnapshotRevision,
  deriveCreatorAliases,
  planCompatibilityRedirects,
  planCatalogGarbageCollection,
  validateCatalogGenerationPlan,
  type ReconciliationObservation,
  type ReconciliationSnapshot,
} from "./catalog-reconciliation-core";

const fetchedAt = new Date("2026-07-17T00:00:00.000Z");
const provenance = {
  source: "openrouter",
  sourceUrl: "https://openrouter.ai/api/v1/models",
  license: "public",
  fetchedAt: fetchedAt.toISOString(),
};
const sourceState = {
  health: "healthy" as const,
  lastAttemptAt: fetchedAt.toISOString(),
  lastSuccessAt: fetchedAt.toISOString(),
  recordCount: 1,
  errorCode: null,
  errorMessage: null,
};
const snapshots: ReconciliationSnapshot[] = [
  { id: "snap-reference", sourceId: "openrouter", fetchedAt, sourceState },
  { id: "snap-provider", sourceId: "provider:anthropic", fetchedAt, sourceState },
  { id: "snap-benchmark", sourceId: "aider", fetchedAt, sourceState },
];
const referencePayload = {
  id: "anthropic/claude-3.7-sonnet",
  canonicalSlug: "anthropic/claude-3.7-sonnet",
  displayName: "Claude 3.7 Sonnet",
  creator: "Anthropic",
  description: null,
  contextWindow: 200_000,
  maxOutput: 64_000,
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
const providerPayload = {
  id: "provider-model-row",
  providerId: "anthropic",
  providerName: "Anthropic",
  rawModelId: "claude-3.7-sonnet",
  existingModelId: "claude-3.7-sonnet",
  inputPrice: "3",
  outputPrice: "15",
  contextWindow: 200_000,
  maxOutput: 64_000,
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
};
const benchmarkPayload = {
  benchmarkId: "aider" as const,
  sourceModel: "Claude 3.7 Sonnet",
  metrics: { passRate: 0.72 },
  raw: {},
  provenance: { ...provenance, source: "aider", sourceUrl: "https://aider.chat/docs/leaderboards/", license: "Apache-2.0" },
};
const observations: ReconciliationObservation[] = [
  { id: "obs-reference", snapshotId: "snap-reference", sourceId: "openrouter", kind: "reference_model", nativeId: referencePayload.id, rawName: referencePayload.displayName, organizationHint: referencePayload.creator, payload: referencePayload },
  { id: "obs-provider", snapshotId: "snap-provider", sourceId: "provider:anthropic", kind: "provider_model", nativeId: providerPayload.rawModelId, rawName: providerPayload.rawModelId, organizationHint: "anthropic", payload: providerPayload },
  { id: "obs-benchmark", snapshotId: "snap-benchmark", sourceId: "aider", kind: "benchmark_model", nativeId: "aider:Claude 3.7 Sonnet", rawName: benchmarkPayload.sourceModel, organizationHint: null, payload: benchmarkPayload },
];

describe("catalog reconciliation core", () => {
  test("builds an identical active view regardless of ingestion order", () => {
    const first = buildCatalogGenerationPlan({ snapshots, observations });
    const second = buildCatalogGenerationPlan({ snapshots: [...snapshots].reverse(), observations: [...observations].reverse() });
    expect(second).toEqual(first);
    expect(first.entities).toHaveLength(1);
    expect(first.entities[0].id.startsWith("model/")).toBe(true);
    expect(first.routes).toEqual([expect.objectContaining({ rawModelId: "claude-3.7-sonnet", entityId: first.entities[0].id })]);
    expect(first.benchmarks).toEqual([expect.objectContaining({ benchmarkId: "aider", entityId: first.entities[0].id })]);
  });

  test("selects a source display claim and removes only a proven creator prefix", () => {
    const nameSnapshots: ReconciliationSnapshot[] = [
      { ...snapshots[0], id: "snap-gpt-reference" },
      { ...snapshots[1], id: "snap-gpt-provider", sourceId: "provider:openai" },
    ];
    const nameObservations: ReconciliationObservation[] = [
      {
        id: "obs-gpt-reference",
        snapshotId: nameSnapshots[0].id,
        sourceId: nameSnapshots[0].sourceId,
        kind: "reference_model",
        nativeId: "openai/gpt-5.6-sol",
        rawName: "OpenAI: GPT-5.6 Sol",
        organizationHint: "OpenAI",
        payload: { ...referencePayload, id: "openai/gpt-5.6-sol", canonicalSlug: "openai/gpt-5.6-sol", displayName: "OpenAI: GPT-5.6 Sol", creator: "OpenAI" },
      },
      {
        id: "obs-gpt-provider",
        snapshotId: nameSnapshots[1].id,
        sourceId: nameSnapshots[1].sourceId,
        kind: "provider_model",
        nativeId: "gpt-5.6-sol",
        rawName: "gpt-5.6-sol",
        organizationHint: null,
        payload: { ...providerPayload, id: "provider-gpt", providerId: "openai", providerName: "OpenAI", rawModelId: "gpt-5.6-sol", displayName: "gpt-5.6-sol", existingModelId: "gpt-5.6-sol" },
      },
    ];
    const plan = buildCatalogGenerationPlan({ snapshots: nameSnapshots, observations: nameObservations });
    expect(plan.entities).toHaveLength(1);
    expect(plan.organizations[0].canonicalName).toBe("OpenAI");
    expect(plan.entities[0]).toMatchObject({
      preferredName: "GPT-5.6 Sol",
      nameProvenance: {
        sourceId: "openrouter",
        originalValue: "OpenAI: GPT-5.6 Sol",
        creatorPrefixRemoved: "OpenAI",
      },
    });
    expect(plan.nameClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: plan.entities[0].id, value: "OpenAI: GPT-5.6 Sol", selected: true }),
      expect.objectContaining({ entityId: plan.entities[0].id, value: "gpt-5.6-sol", selected: false }),
    ]));

    const punctuatedCreator = buildCatalogGenerationPlan({
      snapshots: [nameSnapshots[0]],
      observations: [{
        ...nameObservations[0],
        id: "obs-aion-reference",
        nativeId: "aion-labs/aion-3.0",
        rawName: "AionLabs: Aion-3.0",
        organizationHint: "aion-labs",
        payload: { ...referencePayload, id: "aion-labs/aion-3.0", displayName: "AionLabs: Aion-3.0", creator: "aion-labs" },
      }],
    });
    expect(punctuatedCreator.entities[0].preferredName).toBe("Aion-3.0");
    expect(punctuatedCreator.organizations[0].canonicalName).toBe("AionLabs");

    const collidingCreator = buildCatalogGenerationPlan({
      snapshots: [nameSnapshots[0]],
      observations: [{
        ...nameObservations[0],
        id: "obs-meta-reference",
        nativeId: "meta-llama/llama-4",
        rawName: "Meta: Llama 4",
        organizationHint: "meta-llama",
        payload: { ...referencePayload, id: "meta-llama/llama-4", displayName: "Meta: Llama 4", creator: "meta-llama" },
      }],
      existingOrganizations: [
        { id: "org/meta", canonicalName: "Meta", websiteUrl: null, aliases: [] },
        { id: "org/meta-llama", canonicalName: "meta-llama", websiteUrl: null, aliases: [] },
      ],
    });
    expect(collidingCreator.entities[0].preferredName).toBe("Llama 4");
    expect(collidingCreator.organizations[0].canonicalName).toBe("meta-llama");
  });

  test("uses provider display claims and preserves unknown fallback punctuation", () => {
    const providerSnapshot = { ...snapshots[1], id: "snap-future", sourceId: "provider:future" };
    const makeProvider = (id: string, rawModelId: string, displayName: string | null): ReconciliationObservation => ({
      id,
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId: rawModelId,
      rawName: displayName || rawModelId,
      organizationHint: rawModelId.includes("/") ? rawModelId.slice(0, rawModelId.indexOf("/")) : null,
      payload: { ...providerPayload, id, providerId: "future", providerName: "Future", rawModelId, displayName, existingModelId: rawModelId },
    });
    const claimed = buildCatalogGenerationPlan({
      snapshots: [providerSnapshot],
      observations: [makeProvider("obs-future-claim", "future-labs/novax7.4-pro", "NovaX 7.4 Pro")],
    });
    expect(claimed.entities[0].preferredName).toBe("NovaX 7.4 Pro");
    expect(claimed.entities[0].nameProvenance.sourceKind).toBe("provider_model");

    const fallback = buildCatalogGenerationPlan({
      snapshots: [providerSnapshot],
      observations: [makeProvider("obs-future-fallback", "accounts/future/models/NovaX7.4-Pro", null)],
    });
    expect(fallback.entities[0].preferredName).toBe("NovaX7.4-Pro");
  });

  test("formats multi-part source claims without model-specific naming rules", () => {
    const providerSnapshot = { ...snapshots[1], id: "snap-future-names", sourceId: "provider:future" };
    const makeProvider = (id: string, displayName: string): ReconciliationObservation => ({
      id,
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId: "future-labs/novax7.4-pro",
      rawName: displayName,
      organizationHint: null,
      payload: {
        ...providerPayload,
        id,
        providerId: "future",
        providerName: "Future",
        rawModelId: "future-labs/novax7.4-pro",
        displayName,
        existingModelId: "future-labs/novax7.4-pro",
      },
    });
    const cases = [
      ["GPT-5.6-Sol", "GPT-5.6 Sol"],
      ["ACME-7.4-Pro", "ACME-7.4 Pro"],
      ["NovaX-V7.4-Turbo", "NovaX V7.4 Turbo"],
      ["MiniMax-M2.7-Turbo", "MiniMax M2.7 Turbo"],
      ["Qwen3.6-35B-A3B", "Qwen3.6 35B A3B"],
      ["Aion-3.0", "Aion-3.0"],
      ["GPT-4o (2024-05-13)", "GPT-4o (2024-05-13)"],
      ["GPT-4o-mini Search Preview", "GPT-4o mini Search Preview"],
      ["DeepSeek R1 + claude-3-5-sonnet-20241022", "DeepSeek R1 + claude-3-5-sonnet-20241022"],
      ["gpt-oss-120b", "gpt-oss-120b"],
      ["gpt-oss-120b-Turbo", "gpt-oss-120b-Turbo"],
      ["Qwen2.5.1-Coder-7B-GGUF:Q8_0-32k", "Qwen2.5.1-Coder-7B-GGUF:Q8_0-32k"],
    ] as const;

    for (const [sourceName, expectedName] of cases) {
      const plan = buildCatalogGenerationPlan({
        snapshots: [providerSnapshot],
        observations: [makeProvider(`obs-${sourceName}`, sourceName)],
      });
      expect(plan.entities[0].preferredName).toBe(expectedName);
      expect(plan.entities[0].nameProvenance.originalValue).toBe(sourceName);
    }
  });

  test("retains stable slugs for existing entity IDs", () => {
    const entityId = buildCatalogGenerationPlan({ snapshots, observations }).entities[0].id;
    const plan = buildCatalogGenerationPlan({
      snapshots,
      observations,
      existingEntities: [{ id: entityId, stableSlug: "models/claude-stable" }],
    });
    expect(plan.entities[0].stableSlug).toBe("models/claude-stable");
  });

  test("retains deep-link redirects when reference evidence replaces a weak provider identity", () => {
    const providerSnapshot = { id: "snap-provider-weak", sourceId: "provider:vendor", fetchedAt, sourceState };
    const weakProvider: ReconciliationObservation = {
      id: "obs-provider-weak",
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId: "model-2",
      rawName: "model-2",
      organizationHint: null,
      payload: { ...providerPayload, id: "provider-weak", providerId: "vendor", providerName: "Vendor", rawModelId: "model-2", existingModelId: "model-2" },
    };
    const first = buildCatalogGenerationPlan({ snapshots: [providerSnapshot], observations: [weakProvider] });
    const historical = first.entities[0];
    const referenceSnapshot = { id: "snap-reference-vendor", sourceId: "openrouter", fetchedAt, sourceState };
    const vendorReference: ReconciliationObservation = {
      id: "obs-reference-vendor",
      snapshotId: referenceSnapshot.id,
      sourceId: referenceSnapshot.sourceId,
      kind: "reference_model",
      nativeId: "vendor/model-2",
      rawName: "Model 2",
      organizationHint: "vendor",
      payload: { ...referencePayload, id: "vendor/model-2", canonicalSlug: "vendor--model-2", displayName: "Model 2", creator: "vendor" },
    };
    const currentInput = { snapshots: [providerSnapshot, referenceSnapshot], observations: [weakProvider, vendorReference] };
    const cold = buildCatalogGenerationPlan(currentInput);
    const warm = buildCatalogGenerationPlan({
      ...currentInput,
      existingEntities: [{
        id: historical.id,
        stableSlug: historical.stableSlug,
        preferredName: historical.preferredName,
        organizationId: historical.organizationId,
        identityNativeId: weakProvider.nativeId,
        identityObservedName: weakProvider.rawName,
        identityOrganizationHint: weakProvider.organizationHint,
      }],
      previousLinks: { [weakProvider.id]: historical.id },
    });
    expect(warm.entities.map((entity) => entity.id)).toEqual(cold.entities.map((entity) => entity.id));
    expect(warm.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "pointer:entity-redirect", alias: historical.id, entityId: cold.entities[0].id }),
      expect.objectContaining({ sourceId: "pointer:entity-redirect", alias: historical.stableSlug, entityId: cold.entities[0].id }),
    ]));
  });

  test("groups provider infrastructure IDs by declared catalogue identity and preserves exact routes", () => {
    const referenceSnapshot: ReconciliationSnapshot = {
      id: "snap-kimi-reference",
      sourceId: "openrouter",
      fetchedAt,
      sourceState,
    };
    const providerSnapshot: ReconciliationSnapshot = {
      id: "snap-kimi-fireworks",
      sourceId: "provider:fireworks",
      fetchedAt,
      sourceState,
    };
    const reference: ReconciliationObservation = {
      id: "obs-kimi-reference",
      snapshotId: referenceSnapshot.id,
      sourceId: referenceSnapshot.sourceId,
      kind: "reference_model",
      nativeId: "moonshotai/kimi-k3",
      rawName: "MoonshotAI: Kimi K3",
      organizationHint: "MoonshotAI",
      payload: {
        ...referencePayload,
        id: "moonshotai/kimi-k3",
        canonicalSlug: "moonshotai/kimi-k3",
        displayName: "MoonshotAI: Kimi K3",
        creator: "MoonshotAI",
      },
    };
    const fireworks: ReconciliationObservation = {
      id: "obs-kimi-fireworks",
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId: "accounts/fireworks/models/kimi-k3",
      rawName: "Kimi K3",
      organizationHint: "accounts",
      payload: {
        ...providerPayload,
        id: "provider-kimi-fireworks",
        providerId: "fireworks",
        providerName: "Fireworks AI",
        rawModelId: "accounts/fireworks/models/kimi-k3",
        catalogIdentity: "moonshotai/Kimi-K3",
        displayName: "Kimi K3",
        existingModelId: "accounts/fireworks/models/kimi-k3",
      },
    };
    const first = buildCatalogGenerationPlan({
      snapshots: [providerSnapshot],
      observations: [{ ...fireworks, payload: { ...fireworks.payload as object, catalogIdentity: null } }],
    });
    const historical = first.entities[0];
    const plan = buildCatalogGenerationPlan({
      snapshots: [referenceSnapshot, providerSnapshot],
      observations: [reference, fireworks],
      existingEntities: [{
        id: historical.id,
        stableSlug: historical.stableSlug,
        preferredName: historical.preferredName,
        organizationId: historical.organizationId,
        identityNativeId: fireworks.nativeId,
        identityObservedName: fireworks.rawName,
        identityOrganizationHint: fireworks.organizationHint,
      }],
      previousLinks: { [fireworks.id]: historical.id },
    });

    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]).toMatchObject({
      preferredName: "Kimi K3",
      organizationId: "org/moonshotai",
    });
    expect(plan.routes).toEqual([
      expect.objectContaining({
        providerId: "fireworks",
        rawModelId: "accounts/fireworks/models/kimi-k3",
        entityId: plan.entities[0].id,
      }),
    ]);
    expect(plan.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "provider:fireworks",
        alias: "moonshotai/Kimi-K3",
        entityId: plan.entities[0].id,
      }),
      expect.objectContaining({
        sourceId: "pointer:entity-redirect",
        alias: historical.id,
        entityId: plan.entities[0].id,
      }),
    ]));
  });

  test("keeps an uncorroborated declared identity as an alias without suppressing the provider route", () => {
    const referenceSnapshot: ReconciliationSnapshot = {
      id: "snap-glm-references",
      sourceId: "openrouter",
      fetchedAt,
      sourceState,
    };
    const providerSnapshot: ReconciliationSnapshot = {
      id: "snap-glm-fireworks",
      sourceId: "provider:fireworks",
      fetchedAt,
      sourceState,
    };
    const references: ReconciliationObservation[] = [
      ["obs-glm-5", "z-ai/glm-5", "GLM 5"],
      ["obs-glm-5-turbo", "z-ai/glm-5-turbo", "GLM 5 Turbo"],
    ].map(([id, nativeId, displayName]) => ({
      id,
      snapshotId: referenceSnapshot.id,
      sourceId: referenceSnapshot.sourceId,
      kind: "reference_model",
      nativeId,
      rawName: displayName,
      organizationHint: "z-ai",
      payload: {
        ...referencePayload,
        id: nativeId,
        canonicalSlug: nativeId,
        displayName,
        creator: "z-ai",
      },
    }));
    const fireworks: ReconciliationObservation = {
      id: "obs-glm-fireworks",
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId: "accounts/fireworks/models/glm-5p1",
      rawName: "GLM 5.1",
      organizationHint: "accounts",
      payload: {
        ...providerPayload,
        id: "provider-glm-fireworks",
        providerId: "fireworks",
        providerName: "Fireworks AI",
        rawModelId: "accounts/fireworks/models/glm-5p1",
        catalogIdentity: "zai-org/GLM-5.1-FP8",
        displayName: "GLM 5.1",
        existingModelId: "accounts/fireworks/models/glm-5p1",
      },
    };
    const plan = buildCatalogGenerationPlan({
      snapshots: [referenceSnapshot, providerSnapshot],
      observations: [...references, fireworks],
    });

    expect(plan.decisions.find((item) => item.observationId === fireworks.id)).toMatchObject({
      state: "linked",
      method: "native_id",
    });
    expect(plan.routes).toContainEqual(expect.objectContaining({
      providerId: "fireworks",
      rawModelId: fireworks.nativeId,
    }));
    expect(plan.aliases).toContainEqual(expect.objectContaining({
      sourceId: "provider:fireworks",
      alias: "zai-org/GLM-5.1-FP8",
    }));
  });

  test("lets an explicit organization alias repair a historical creator self-name", () => {
    const aliases = deriveCreatorAliases([
      { id: "org/acme", canonicalName: "Acme", aliases: ["Acme AI"] },
      { id: "org/acme-ai", canonicalName: "Acme AI", aliases: [] },
    ]);
    expect(aliases["acme-ai"]).toBe("acme");
  });

  test("keeps aliases on the retained side of a partial split", () => {
    const redirects = planCompatibilityRedirects({
      currentEntities: [{ id: "model/a", stableSlug: "models/a" }, { id: "model/b", stableSlug: "models/b" }],
      historicalEntities: [{ id: "model/a", stableSlug: "models/a" }, { id: "model/b", stableSlug: "models/b" }],
      currentRemaps: [{ previousEntityId: "model/a", entityId: "model/b" }],
      historicalAliases: [{ alias: "models/legacy-a", entityId: "model/a" }],
    });
    expect(redirects).toContainEqual({ alias: "models/legacy-a", entityId: "model/a" });
  });

  test("preserves intermediate published IDs when reconciling after rollback", () => {
    const redirects = planCompatibilityRedirects({
      currentEntities: [{ id: "model/c", stableSlug: "models/c" }],
      historicalEntities: [
        { id: "model/a", stableSlug: "models/a" },
        { id: "model/b", stableSlug: "models/b" },
        { id: "model/c", stableSlug: "models/c" },
      ],
      currentRemaps: [{ previousEntityId: "model/a", entityId: "model/c" }],
      historicalAliases: [{ alias: "model/a", entityId: "model/b" }],
    });
    expect(redirects).toEqual(expect.arrayContaining([
      { alias: "model/a", entityId: "model/c" },
      { alias: "models/a", entityId: "model/c" },
      { alias: "model/b", entityId: "model/c" },
      { alias: "models/b", entityId: "model/c" },
    ]));

    const immediatelyAfterRollback = planCompatibilityRedirects({
      currentEntities: [{ id: "model/a", stableSlug: "models/a" }],
      historicalEntities: [
        { id: "model/a", stableSlug: "models/a" },
        { id: "model/b", stableSlug: "models/b" },
        { id: "model/c", stableSlug: "models/c" },
      ],
      currentRemaps: [],
      historicalAliases: [
        { alias: "model/a", entityId: "model/b" },
        { alias: "model/b", entityId: "model/c" },
      ],
    });
    expect(immediatelyAfterRollback).toEqual(expect.arrayContaining([
      { alias: "model/b", entityId: "model/a" },
      { alias: "models/b", entityId: "model/a" },
      { alias: "model/c", entityId: "model/a" },
      { alias: "models/c", entityId: "model/a" },
    ]));
  });

  test("retains ambiguous display aliases without aborting the generation", () => {
    const providerSnapshot = { id: "snap-provider-shared", sourceId: "provider:vendor", fetchedAt, sourceState };
    const shared = ["vendor/model-1", "vendor/model-2"].map((nativeId, index): ReconciliationObservation => ({
      id: `obs-shared-${index}`,
      snapshotId: providerSnapshot.id,
      sourceId: providerSnapshot.sourceId,
      kind: "provider_model",
      nativeId,
      rawName: "Shared Model",
      organizationHint: "vendor",
      payload: { ...providerPayload, id: `provider-shared-${index}`, providerId: "vendor", providerName: "Vendor", rawModelId: nativeId, existingModelId: nativeId },
    }));
    const plan = buildCatalogGenerationPlan({ snapshots: [providerSnapshot], observations: shared });
    const ambiguousAliases = plan.aliases.filter((alias) => alias.alias === "Shared Model");
    expect(ambiguousAliases).toHaveLength(2);
    expect(new Set(ambiguousAliases.map((alias) => alias.entityId)).size).toBe(2);
  });

  test("removing an upstream provider-only observation removes its active ghost", () => {
    const extraSnapshot = { id: "snap-extra", sourceId: "provider:acme", fetchedAt, sourceState };
    const extraObservation: ReconciliationObservation = {
      id: "obs-extra",
      snapshotId: extraSnapshot.id,
      sourceId: extraSnapshot.sourceId,
      kind: "provider_model",
      nativeId: "acme/model-old",
      rawName: "Acme Model Old",
      organizationHint: "acme",
      payload: { ...providerPayload, id: "provider-model-old", providerId: "acme", providerName: "Acme", rawModelId: "acme/model-old", existingModelId: "acme/model-old" },
    };
    const before = buildCatalogGenerationPlan({ snapshots: [...snapshots, extraSnapshot], observations: [...observations, extraObservation] });
    const after = buildCatalogGenerationPlan({ snapshots, observations, existingEntities: before.entities.map(({ id, stableSlug }) => ({ id, stableSlug })) });
    expect(before.routes.some((route) => route.providerId === "acme")).toBe(true);
    expect(after.routes.some((route) => route.providerId === "acme")).toBe(false);
    expect(after.entities.some((entity) => entity.id.includes("model-old"))).toBe(false);
  });

  test("rejects empty, malformed, and cross-snapshot generations before activation", () => {
    expect(() => buildCatalogGenerationPlan({ snapshots: [], observations: [] })).toThrow("no validated snapshots");
    expect(buildCatalogGenerationPlan(
      { snapshots: [], observations: [] },
      { allowEmptyCatalog: true }
    )).toMatchObject({ snapshots: [], entities: [], routes: [], benchmarks: [], links: [] });
    expect(() => buildCatalogGenerationPlan({ snapshots, observations: [{ ...observations[0], payload: {} }] })).toThrow();
    const plan = buildCatalogGenerationPlan({ snapshots, observations });
    expect(() => validateCatalogGenerationPlan(plan, [{ ...observations[0], snapshotId: "unselected" }, ...observations.slice(1)])).toThrow("outside the selected snapshots");
  });

  test("detects route, link, benchmark, and slug uniqueness violations", () => {
    const plan = buildCatalogGenerationPlan({ snapshots, observations });
    expect(() => validateCatalogGenerationPlan({ ...plan, routes: [...plan.routes, plan.routes[0]] }, observations)).toThrow("Duplicate provider model route");
    expect(() => validateCatalogGenerationPlan({ ...plan, links: [...plan.links, plan.links[0]] }, observations)).toThrow("Duplicate observation link");
    expect(() => validateCatalogGenerationPlan({ ...plan, benchmarks: [...plan.benchmarks, plan.benchmarks[0]] }, observations)).toThrow("Duplicate benchmark link");
    expect(() => validateCatalogGenerationPlan({ ...plan, entities: [...plan.entities, { ...plan.entities[0], id: "different" }] }, observations)).toThrow("Duplicate entity slug");
  });

  test("hashes inventory content independently from ordering and fetch freshness", () => {
    expect(catalogContentHash({ b: 2, a: 1 })).toBe(catalogContentHash({ a: 1, b: 2 }));
    expect(catalogInventoryHash([{ id: "b" }, { id: "a" }])).toBe(catalogInventoryHash([{ id: "a" }, { id: "b" }]));
    const refreshed = { ...referencePayload, provenance: { ...provenance, fetchedAt: "2026-07-18T00:00:00.000Z" } };
    expect(catalogInventoryHash([refreshed])).toBe(catalogInventoryHash([referencePayload]));
    expect(catalogSnapshotRevision(fetchedAt, [referencePayload])).not.toBe(
      catalogSnapshotRevision(new Date("2026-07-18T00:00:00.000Z"), [refreshed]),
    );
  });

  test("generation identity ignores live source health but changes with catalog facts", () => {
    const plan = buildCatalogGenerationPlan({ snapshots, observations });
    const stalePlan = {
      ...plan,
      snapshots: plan.snapshots.map((snapshot) => ({
        ...snapshot,
        sourceState: { ...snapshot.sourceState, health: "stale" as const, errorCode: "timeout" },
      })),
    };
    expect(catalogGenerationContentHash(stalePlan)).toBe(catalogGenerationContentHash(plan));
    expect(catalogGenerationContentHash({
      ...plan,
      entities: plan.entities.map((entity, index) => index === 0 ? { ...entity, preferredName: ` Updated` } : entity),
    })).not.toBe(catalogGenerationContentHash(plan));
  });

  test("garbage collection excludes recent and protected history", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const old = new Date("2026-05-01T00:00:00Z");
    const recent = new Date("2026-07-10T00:00:00Z");
    const plan = planCatalogGarbageCollection([
      { id: "old-retired", createdAt: old, state: "retired", referencedByProtectedGeneration: false },
      { id: "old-protected", createdAt: old, state: "retired", referencedByProtectedGeneration: true },
      { id: "recent-failed", createdAt: recent, state: "failed", referencedByProtectedGeneration: false },
      { id: "active", createdAt: old, state: "active", referencedByProtectedGeneration: false },
    ], { now, retentionDays: 30 });
    expect(plan.map((candidate) => candidate.id)).toEqual(["old-retired"]);
  });
});
