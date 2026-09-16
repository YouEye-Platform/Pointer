export interface SourceState {
  sourceId: string;
  status: "never_synced" | "disabled" | "syncing" | "ok" | "error";
  stale: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  fetchedAt: string | null;
  recordCount: number;
  error: { code: string; message: string } | null;
}

export interface CatalogEnvelope {
  contractVersion: "1";
  snapshotId: string;
  generatedAt: string;
  sources: SourceState[];
  benchmarkDescriptors: BenchmarkDescriptor[];
  ranking: {
    sort: "recommended";
    method: "mean_percentile";
    sourceIds: string[];
  };
}

export interface BenchmarkDescriptor {
  id: string;
  label: string;
  description: string;
  sourceUrl: string;
  license: string;
  scoreMetric: string;
  rankMetric: string | null;
  unit: "points" | "percent" | "rank";
  higherIsBetter: boolean;
  defaultVisible: boolean;
  rankingPriority: number | null;
  attribution: string | null;
}

export interface CatalogProvider {
  providerModelKey: string;
  providerId: string;
  providerName: string;
  providerIconKey: string | null;
  rawModelId: string;
  pricing: { input: number | null; output: number | null; currency: "USD"; source: string | null; fetchedAt: string | null };
  capabilities: { tools: boolean; vision: boolean; streaming: boolean };
  contextWindow: number | null;
  maxOutput: number | null;
  available: boolean;
  accounts: Array<{ id: string; nickname: string | null }>;
}

export interface CatalogBenchmark {
  benchmarkId: string;
  sourceModel: string;
  metrics: Record<string, string | number | boolean | null>;
  provenance: { source: string; sourceUrl: string; license: string; fetchedAt: string };
  fetchedAt: string;
  presentation: {
    label: string;
    score: number | null;
    rank: number | null;
    effectiveRank: number | null;
    rankDerived: boolean;
    population: number | null;
    percentile: number | null;
    unit: "points" | "percent" | "rank";
    higherIsBetter: boolean;
  };
}

export interface CatalogModel {
  id: string;
  slug: string;
  name: string;
  nameProvenance?: {
    sourceId: string | null;
    observationId: string | null;
    sourceKind: "reference_model" | "provider_model" | "benchmark_model" | "reviewed_override" | "fallback";
    originalValue: string;
    selectedValue: string;
    fetchedAt: string | null;
    creatorPrefixRemoved: string | null;
  };
  creator: string | null;
  creatorIconKey: string | null;
  modelIconKey: string | null;
  description: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  capabilities: { reasoning: boolean; vision: boolean; tools: boolean; streaming: boolean };
  referencePricing: { input: number | null; output: number | null; currency: "USD"; source: string | null; fetchedAt: string | null };
  providerCount: number;
  availableProviderCount: number;
  available: boolean;
  providers: CatalogProvider[];
  aliases: Array<{ source: string; alias: string; provenance: unknown }>;
  benchmarks: CatalogBenchmark[];
  metadataSource: string | null;
  metadataFetchedAt: string | null;
  releasedAt: string | null;
  recommendedRanking: {
    method: "mean_percentile";
    rank: number;
    percentile: number;
    coverage: number;
    eligibleSources: number;
    sources: Array<{
      sourceId: string;
      sourceLabel: string;
      rank: number;
      publishedRank: number | null;
      rankDerived: boolean;
      population: number;
      percentile: number;
      score: number | null;
      attribution: string | null;
    }>;
  } | null;
}

export interface CatalogListResponse extends CatalogEnvelope {
  items: CatalogModel[];
  page: number;
  pageSize: number;
  total: number;
  facets: {
    creators: string[];
    providers: Array<{ id: string; name: string; available: boolean }>;
  };
}

export type CatalogDetailResponse = CatalogEnvelope & CatalogModel;

export const formatPrice = (value: number | null) => value === null ? "Unknown" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
export const formatTokens = (value: number | null) => value === null ? "Unknown" : Intl.NumberFormat("en", { notation: "compact" }).format(value);

export function benchmarkScore(benchmark: CatalogBenchmark | undefined): string {
  if (!benchmark) return "-";
  const value = benchmark.presentation.score;
  if (typeof value !== "number") return benchmark.presentation.rank === null ? "-" : `#${benchmark.presentation.rank}`;
  if (benchmark.presentation.unit === "percent") {
    const percentage = Math.abs(value) <= 1 ? value * 100 : value;
    return `${percentage.toFixed(1)}%`;
  }
  return value.toFixed(Math.abs(value) >= 10 ? 0 : 2);
}
