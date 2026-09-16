import {
  buildModelMatchIndex,
  friendlyModelName,
  matchCanonicalModel,
  normalizeModelLight,
  type CanonicalIdentity,
  type ModelMatch,
} from "./model-identity";
import type { NormalizedBenchmarkRecord, NormalizedReferenceModel, SourceProvenance } from "./sources/types";

export interface ProviderModelInput {
  id: string;
  providerId: string;
  providerName: string;
  rawModelId: string;
  catalogIdentity?: string | null;
  displayName?: string | null;
  existingModelId: string;
  inputPrice: string | null;
  outputPrice: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
}

export interface PlannedModel {
  id: string;
  slug: string;
  name: string;
  creator: string | null;
  description: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  referenceInputPrice: number | null;
  referenceOutputPrice: number | null;
  metadataSource: "openrouter" | "provider" | "benchmark";
  metadataFetchedAt: string | null;
  rawMetadata: unknown;
}

export interface PlannedAlias {
  canonicalModelId: string;
  source: string;
  alias: string;
  provenance: SourceProvenance | null;
}

export interface CatalogPlan {
  models: PlannedModel[];
  providerMappings: Array<{ providerModelId: string; canonicalModelId: string }>;
  aliases: PlannedAlias[];
  benchmarks: Array<NormalizedBenchmarkRecord & { canonicalModelId: string }>;
  collisions: Array<{ source: string; value: string; candidates: string[] }>;
}

const slugFor = (id: string) => id.toLowerCase().replace(/\//g, "--").replace(/:/g, "-");
const localId = (kind: "provider" | "benchmark", raw: string) => `${kind}/${normalizeModelLight(raw) || "unknown"}`;

function referenceModel(model: NormalizedReferenceModel): PlannedModel {
  return {
    id: model.id,
    slug: model.canonicalSlug || slugFor(model.id),
    name: model.displayName,
    creator: model.creator || null,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    supportsTools: model.supportedParameters.includes("tools"),
    supportsVision: model.inputModalities.includes("image"),
    supportsStreaming: true,
    referenceInputPrice: model.inputPricePerMillion,
    referenceOutputPrice: model.outputPricePerMillion,
    metadataSource: "openrouter",
    metadataFetchedAt: model.provenance.fetchedAt,
    rawMetadata: model.raw,
  };
}

function resolveMatch(value: string, index: ReturnType<typeof buildModelMatchIndex>): ModelMatch {
  return matchCanonicalModel(value, index);
}

export function planCanonicalCatalog(
  references: NormalizedReferenceModel[],
  providerModels: ProviderModelInput[],
  benchmarkRecords: NormalizedBenchmarkRecord[]
): CatalogPlan {
  const models = new Map(references.map((model) => [model.id, referenceModel(model)]));
  const identities: CanonicalIdentity[] = references.map((model) => ({
    id: model.id,
    name: model.displayName,
    aliases: [model.canonicalSlug, model.id].filter((value): value is string => Boolean(value)),
  }));
  let index = buildModelMatchIndex(identities);
  const aliases: PlannedAlias[] = [];
  const providerMappings: CatalogPlan["providerMappings"] = [];
  const benchmarks: CatalogPlan["benchmarks"] = [];
  const collisions: CatalogPlan["collisions"] = [];

  for (const reference of references) {
    for (const alias of new Set([reference.id, reference.displayName, reference.canonicalSlug].filter((value): value is string => Boolean(value)))) {
      aliases.push({ canonicalModelId: reference.id, source: "openrouter", alias, provenance: reference.provenance });
    }
  }

  for (const providerModel of providerModels) {
    const attempts = [providerModel.catalogIdentity, providerModel.rawModelId, providerModel.existingModelId, providerModel.displayName]
      .filter((value): value is string => Boolean(value));
    let canonicalId: string | null = null;
    for (const value of attempts) {
      const match = resolveMatch(value, index);
      if (match.status === "matched") {
        const target = models.get(match.canonicalId);
        // Aggressive matching is useful against the curated reference catalog,
        // but must not collapse distinct provider-only variants such as Turbo.
        if (match.strategy !== "aggressive" || target?.metadataSource === "openrouter") {
          canonicalId = match.canonicalId;
          break;
        }
      }
      if (match.status === "ambiguous") collisions.push({ source: `provider:${providerModel.providerId}`, value, candidates: match.candidates });
    }
    canonicalId ??= localId("provider", providerModel.rawModelId);
    if (!models.has(canonicalId)) {
      models.set(canonicalId, {
        id: canonicalId,
        slug: slugFor(canonicalId),
        name: providerModel.displayName?.trim() || friendlyModelName(providerModel.rawModelId),
        creator: providerModel.providerName,
        description: null,
        contextWindow: providerModel.contextWindow,
        maxOutput: providerModel.maxOutput,
        supportsTools: providerModel.supportsTools,
        supportsVision: providerModel.supportsVision,
        supportsStreaming: providerModel.supportsStreaming,
        referenceInputPrice: null,
        referenceOutputPrice: null,
        metadataSource: "provider",
        metadataFetchedAt: null,
        rawMetadata: { providerId: providerModel.providerId, rawModelId: providerModel.rawModelId },
      });
      identities.push({ id: canonicalId, name: models.get(canonicalId)!.name, aliases: attempts });
      index = buildModelMatchIndex(identities);
    }
    providerMappings.push({ providerModelId: providerModel.id, canonicalModelId: canonicalId });
    for (const alias of new Set(attempts)) {
      aliases.push({ canonicalModelId: canonicalId, source: `provider:${providerModel.providerId}`, alias, provenance: null });
    }
  }

  for (const benchmark of benchmarkRecords) {
    const match = resolveMatch(benchmark.sourceModel, index);
    let canonicalId: string;
    if (match.status === "matched") canonicalId = match.canonicalId;
    else {
      if (match.status === "ambiguous") collisions.push({ source: `benchmark:${benchmark.benchmarkId}`, value: benchmark.sourceModel, candidates: match.candidates });
      canonicalId = localId("benchmark", benchmark.sourceModel);
      if (!models.has(canonicalId)) {
        models.set(canonicalId, {
          id: canonicalId,
          slug: slugFor(canonicalId),
          name: friendlyModelName(benchmark.sourceModel),
          creator: null,
          description: null,
          contextWindow: null,
          maxOutput: null,
          supportsTools: false,
          supportsVision: false,
          supportsStreaming: false,
          referenceInputPrice: null,
          referenceOutputPrice: null,
          metadataSource: "benchmark",
          metadataFetchedAt: benchmark.provenance.fetchedAt,
          rawMetadata: benchmark.raw,
        });
      }
    }
    aliases.push({ canonicalModelId: canonicalId, source: `benchmark:${benchmark.benchmarkId}`, alias: benchmark.sourceModel, provenance: benchmark.provenance });
    benchmarks.push({ ...benchmark, canonicalModelId: canonicalId });
  }

  const bySlug = new Map<string, PlannedModel[]>();
  for (const model of models.values()) {
    const rows = bySlug.get(model.slug) ?? [];
    rows.push(model);
    bySlug.set(model.slug, rows);
  }
  for (const rows of bySlug.values()) {
    if (rows.length < 2) continue;
    for (const model of rows) model.slug = slugFor(model.id);
  }

  return { models: [...models.values()], providerMappings, aliases, benchmarks, collisions };
}
