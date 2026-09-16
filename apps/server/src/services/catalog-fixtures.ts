import type { CatalogCorpus } from "./catalog-contracts";

export type FixtureClassification = "same_entity" | "distinct_variant" | "ambiguous" | "unresolved";

export interface IdentityFixture {
  id: string;
  family: "glm" | "claude" | "gemini" | "gpt" | "qwen" | "deepseek";
  classification: FixtureClassification;
  observations: string[];
  expectedEntityIds: Array<string | null>;
  expectedNames: string[];
  evidence: string[];
  expectedResolverEvidence: string[];
}

// These cases are reviewed expectations, not application-level alias overrides.
export const IDENTITY_FIXTURES: IdentityFixture[] = [
  {
    id: "glm-5.1-cross-provider",
    family: "glm",
    classification: "same_entity",
    observations: ["z-ai/glm-5.1", "glm-5.1"],
    expectedEntityIds: ["model/z-ai-glm-5.1--6ed4bdb12801bc69", "model/z-ai-glm-5.1--6ed4bdb12801bc69"],
    expectedNames: ["GLM 5.1"],
    evidence: ["Exact source-native suffix and version agree; provider namespace is an organization hint."],
    expectedResolverEvidence: ["family:glm", "version:5.1"],
  },
  {
    id: "claude-sonnet-thinking-variant",
    family: "claude",
    classification: "distinct_variant",
    observations: ["claude-3.7-sonnet", "claude-3.7-sonnet-thinking"],
    expectedEntityIds: ["model/claude-sonnet-3.7--2cf519d769b98df7", "model/claude-sonnet-3.7-thinking--14a5ae09ad577838"],
    expectedNames: ["Claude 3.7 Sonnet", "Claude 3.7 Sonnet Thinking"],
    evidence: ["Thinking changes runtime behavior and must block an automatic base-model merge."],
    expectedResolverEvidence: ["new-reference-identity:claude-sonnet|3.7|_|thinking|_|_|_"],
  },
  {
    id: "gemini-preview-date",
    family: "gemini",
    classification: "distinct_variant",
    observations: ["gemini-2.5-pro-preview-03-25", "gemini-2.5-pro"],
    expectedEntityIds: ["model/gemini-pro-2.5-03-25-preview--56ba8ea9eeee5019", "model/gemini-pro-2.5--4167a4e417d69cb6"],
    expectedNames: ["Gemini 2.5 Pro Preview 03-25", "Gemini 2.5 Pro"],
    evidence: ["Preview channel and dated revision are identity-significant until an authoritative crosswalk says otherwise."],
    expectedResolverEvidence: ["new-reference-identity:gemini-pro|2.5|03-25|preview|_|_|_"],
  },
  {
    id: "gpt-dated-revisions",
    family: "gpt",
    classification: "distinct_variant",
    observations: ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20"],
    expectedEntityIds: ["model/gpt-4o-2024-08-06--215993e5f6067512", "model/gpt-4o-2024-11-20--f87c73089ee9af8b"],
    expectedNames: ["GPT-4o 2024-08-06", "GPT-4o 2024-11-20"],
    evidence: ["Authoritative dated model IDs represent separately routable revisions."],
    expectedResolverEvidence: ["new-reference-identity:gpt-4o|_|2024-11-20|_|_|_|_"],
  },
  {
    id: "qwen-size-variants",
    family: "qwen",
    classification: "distinct_variant",
    observations: ["qwen3-32b", "qwen3-235b-a22b"],
    expectedEntityIds: ["model/qwen3-32b--9ac92eeebe85ad9b", "model/qwen3-235b-a22b--9491625fea537ecf"],
    expectedNames: ["Qwen3 32B", "Qwen3 235B-A22B"],
    evidence: ["Parameter size and architecture suffixes are hard identity blockers."],
    expectedResolverEvidence: ["new-reference-identity:qwen3|_|_|_|235b-a22b|_|_"],
  },
  {
    id: "deepseek-free-route",
    family: "deepseek",
    classification: "same_entity",
    observations: ["deepseek/deepseek-r1", "deepseek/deepseek-r1:free"],
    expectedEntityIds: ["model/deepseek-deepseek-r1--265a207432a7014a", "model/deepseek-deepseek-r1--265a207432a7014a"],
    expectedNames: ["DeepSeek R1"],
    evidence: ["The free suffix describes a provider route/pricing tier, not a different model entity."],
    expectedResolverEvidence: ["family:deepseek-r1"],
  },
  {
    id: "glm-unknown-provider-label",
    family: "glm",
    classification: "ambiguous",
    observations: ["GLM 5"],
    expectedEntityIds: [null],
    expectedNames: [],
    evidence: ["The label lacks enough evidence to choose base, turbo, free, or a dated revision."],
    expectedResolverEvidence: ["insufficient-score-margin"],
  },
  {
    id: "unknown-deepseek-candidate",
    family: "deepseek",
    classification: "unresolved",
    observations: ["deepseek-next"],
    expectedEntityIds: [null],
    expectedNames: [],
    evidence: ["No authoritative identifier, crosswalk, or approved alias exists."],
    expectedResolverEvidence: ["insufficient-identity-evidence"],
  },
];

export const BROKEN_CATALOG_CORPUS_FIXTURE: CatalogCorpus = {
  corpusVersion: "1",
  generatedAt: "2026-07-14T00:00:00.000Z",
  observations: [
    {
      id: "obs_openrouter_glm_5_1",
      sourceId: "openrouter",
      sourceRecordKey: "z-ai/glm-5.1",
      kind: "reference_model",
      nativeId: "z-ai/glm-5.1",
      observedName: "Z.ai: GLM 5.1",
      organizationHint: "z-ai",
      providerId: null,
      attributes: {},
      provenance: {
        source: "openrouter",
        sourceUrl: "https://openrouter.ai/api/v1/models",
        license: "public-api",
        fetchedAt: "2026-07-14T00:00:00.000Z",
      },
      active: true,
    },
    {
      id: "obs_deepinfra_glm_5_1",
      sourceId: "provider:deepinfra",
      sourceRecordKey: "glm-5.1",
      kind: "provider_model",
      nativeId: "glm-5.1",
      observedName: null,
      organizationHint: "z-ai",
      providerId: "deepinfra",
      attributes: {},
      provenance: null,
      active: true,
    },
    {
      id: "obs_livebench_unknown",
      sourceId: "livebench",
      sourceRecordKey: "GLM 5",
      kind: "benchmark_model",
      nativeId: "GLM 5",
      observedName: "GLM 5",
      organizationHint: null,
      providerId: null,
      attributes: {},
      provenance: {
        source: "livebench",
        sourceUrl: "https://huggingface.co/datasets/livebench/model_judgment",
        license: "dataset-declared",
        fetchedAt: "2026-07-13T00:00:00.000Z",
      },
      active: true,
    },
  ],
  entities: [
    { id: "z-ai/glm-5.1", slug: "z-ai--glm-5.1", preferredName: "Z.ai: GLM 5.1", organizationId: "org_z_ai", active: true },
    { id: "provider/glm-5-1", slug: "provider--glm-5-1", preferredName: "GLM 5 1", organizationId: null, active: true },
    { id: "benchmark/glm-5", slug: "benchmark--glm-5", preferredName: "Glm 5", organizationId: null, active: true },
    { id: "stale/model", slug: "stale--model", preferredName: "Stale Model", organizationId: null, active: true },
  ],
  decisions: [
    { observationId: "obs_openrouter_glm_5_1", entityId: "z-ai/glm-5.1", state: "linked", method: "native_id", confidence: 1, candidateEntityIds: [], evidence: [], resolverVersion: "legacy" },
    { observationId: "obs_deepinfra_glm_5_1", entityId: "provider/glm-5-1", state: "linked", method: "structured_match", confidence: 0.5, candidateEntityIds: [], evidence: [], resolverVersion: "legacy" },
    { observationId: "obs_livebench_unknown", entityId: null, state: "ambiguous", method: "none", confidence: 0, candidateEntityIds: ["z-ai/glm-5.1", "provider/glm-5-1"], evidence: [], resolverVersion: "legacy" },
  ],
  organizations: [{ id: "org_z_ai", name: "Z.ai", aliases: ["z-ai", "zhipuai"], websiteUrl: "https://z.ai" }],
  assets: [],
  providerRoutes: [{ id: "route_deepinfra_glm_5_1", providerId: "deepinfra", providerModelId: "glm-5.1", entityId: "provider/glm-5-1", active: true }],
  benchmarkLinks: [{
    id: "benchmark_livebench_glm_5",
    benchmarkId: "livebench",
    sourceModel: "GLM 5",
    entityId: null,
    provenance: {
      source: "livebench",
      sourceUrl: "https://huggingface.co/datasets/livebench/model_judgment",
      license: "dataset-declared",
      fetchedAt: "2026-07-13T00:00:00.000Z",
    },
  }],
  aliases: [
    { id: "alias_1", source: "openrouter", alias: "z-ai/glm-5.1", entityId: "z-ai/glm-5.1", explicit: false },
    { id: "alias_2", source: "provider:deepinfra", alias: "glm-5.1", entityId: "provider/glm-5-1", explicit: false },
  ],
  sources: [
    { sourceId: "openrouter", health: "healthy", lastAttemptAt: "2026-07-14T00:00:00.000Z", lastSuccessAt: "2026-07-14T00:00:00.000Z", recordCount: 347, errorCode: null, errorMessage: null },
    { sourceId: "livebench", health: "stale", lastAttemptAt: "2026-07-14T00:00:00.000Z", lastSuccessAt: "2026-07-13T00:00:00.000Z", recordCount: 195, errorCode: "upstream", errorMessage: "Source returned HTTP 400" },
  ],
  legacyPresentation: [
    { entityId: "z-ai/glm-5.1", currentName: "Z.ai: GLM 5.1", currentCreator: "z-ai", currentCreatorIconKey: "z-ai", currentLogoUrl: null, iconOutcome: "icon_key" },
    { entityId: "provider/glm-5-1", currentName: "GLM 5 1", currentCreator: null, currentCreatorIconKey: null, currentLogoUrl: null, iconOutcome: "fallback" },
    { entityId: "benchmark/glm-5", currentName: "Glm 5", currentCreator: null, currentCreatorIconKey: null, currentLogoUrl: null, iconOutcome: "fallback" },
    { entityId: "stale/model", currentName: "Stale Model", currentCreator: null, currentCreatorIconKey: null, currentLogoUrl: null, iconOutcome: "fallback" },
  ],
};
