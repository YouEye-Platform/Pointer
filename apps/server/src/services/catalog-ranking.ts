import type { BenchmarkDescriptor } from "./benchmark-registry";

export interface CatalogBenchmarkRankingInput {
  benchmarkId: string;
  presentation: {
    score: number | null;
    rank: number | null;
    higherIsBetter: boolean;
  };
}

export interface CatalogRankingItemInput {
  id: string;
  benchmarks: CatalogBenchmarkRankingInput[];
}

export interface BenchmarkRankProjection {
  sourceId: string;
  sourceLabel: string;
  rank: number;
  publishedRank: number | null;
  rankDerived: boolean;
  population: number;
  percentile: number;
  score: number | null;
  attribution: string | null;
}

export interface RecommendedRanking {
  method: "mean_percentile";
  rank: number;
  percentile: number;
  coverage: number;
  eligibleSources: number;
  sources: BenchmarkRankProjection[];
}

export interface CatalogRankingProjection {
  benchmarkRanks: Map<string, Map<string, BenchmarkRankProjection>>;
  recommendedRankings: Map<string, RecommendedRanking>;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function preferredBenchmark(
  item: CatalogRankingItemInput,
  descriptor: BenchmarkDescriptor,
): CatalogBenchmarkRankingInput | null {
  const candidates = item.benchmarks.filter((benchmark) =>
    benchmark.benchmarkId === descriptor.id
    && (benchmark.presentation.rank !== null || benchmark.presentation.score !== null));
  return candidates.sort((left, right) => {
    const leftRank = left.presentation.rank;
    const rightRank = right.presentation.rank;
    if (leftRank !== null || rightRank !== null) {
      if (leftRank === null || rightRank === null) return leftRank === null ? 1 : -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    const leftScore = left.presentation.score;
    const rightScore = right.presentation.score;
    if (leftScore === null || rightScore === null) return leftScore === null ? 1 : -1;
    return (rightScore - leftScore) * (descriptor.higherIsBetter ? 1 : -1);
  })[0] ?? null;
}

function sourceProjection(
  items: readonly CatalogRankingItemInput[],
  descriptor: BenchmarkDescriptor,
): Map<string, BenchmarkRankProjection> {
  const candidates = items.flatMap((item) => {
    const benchmark = preferredBenchmark(item, descriptor);
    return benchmark ? [{ item, benchmark }] : [];
  });
  if (candidates.length === 0) return new Map();

  const scoreOrdered = candidates
    .filter((candidate) => candidate.benchmark.presentation.score !== null)
    .sort((left, right) => {
      const leftScore = left.benchmark.presentation.score!;
      const rightScore = right.benchmark.presentation.score!;
      const scoreOrder = (rightScore - leftScore) * (descriptor.higherIsBetter ? 1 : -1);
      return scoreOrder || left.item.id.localeCompare(right.item.id);
    });
  const scoreRanks = new Map<string, number>();
  let previousScore: number | null = null;
  let previousRank = 0;
  scoreOrdered.forEach((candidate, index) => {
    const score = candidate.benchmark.presentation.score!;
    const rank = previousScore !== null && score === previousScore ? previousRank : index + 1;
    scoreRanks.set(candidate.item.id, rank);
    previousScore = score;
    previousRank = rank;
  });

  const effectiveRanks = candidates.map(({ item, benchmark }) => ({
    item,
    benchmark,
    rank: benchmark.presentation.rank ?? scoreRanks.get(item.id) ?? null,
  })).filter((candidate): candidate is typeof candidate & { rank: number } => candidate.rank !== null);
  const population = Math.max(
    effectiveRanks.length,
    ...effectiveRanks.map((candidate) => Math.ceil(candidate.rank)),
  );
  const result = new Map<string, BenchmarkRankProjection>();
  for (const { item, benchmark, rank } of effectiveRanks) {
    result.set(item.id, {
      sourceId: descriptor.id,
      sourceLabel: descriptor.label,
      rank,
      publishedRank: benchmark.presentation.rank,
      rankDerived: benchmark.presentation.rank === null,
      population,
      percentile: population <= 1 ? 1 : clamp(1 - ((rank - 1) / (population - 1))),
      score: benchmark.presentation.score,
      attribution: descriptor.attribution,
    });
  }
  return result;
}

export function calculateCatalogRankings(
  items: readonly CatalogRankingItemInput[],
  descriptors: readonly BenchmarkDescriptor[],
): CatalogRankingProjection {
  const benchmarkRanks = new Map(descriptors.map((descriptor) => [
    descriptor.id,
    sourceProjection(items, descriptor),
  ]));
  const generalDescriptors = descriptors.filter((descriptor) => descriptor.rankingPriority !== null);
  const ranked = items.flatMap((item) => {
    const sources = generalDescriptors.flatMap((descriptor) => {
      const projection = benchmarkRanks.get(descriptor.id)?.get(item.id);
      return projection ? [projection] : [];
    });
    if (sources.length === 0) return [];
    return [{
      id: item.id,
      percentile: sources.reduce((total, source) => total + source.percentile, 0) / sources.length,
      coverage: sources.length,
      sources,
    }];
  }).sort((left, right) =>
    right.percentile - left.percentile
    || right.coverage - left.coverage
    || left.id.localeCompare(right.id));

  return {
    benchmarkRanks,
    recommendedRankings: new Map(ranked.map((item, index) => [item.id, {
      method: "mean_percentile" as const,
      rank: index + 1,
      percentile: item.percentile,
      coverage: item.coverage,
      eligibleSources: generalDescriptors.length,
      sources: item.sources,
    }])),
  };
}

export function compareRecommended(
  left: { id: string; recommendedRanking: RecommendedRanking | null },
  right: { id: string; recommendedRanking: RecommendedRanking | null },
) {
  const leftRanking = left.recommendedRanking;
  const rightRanking = right.recommendedRanking;
  if (!leftRanking || !rightRanking) {
    return leftRanking === rightRanking ? left.id.localeCompare(right.id) : leftRanking ? -1 : 1;
  }
  return leftRanking.rank - rightRanking.rank || left.id.localeCompare(right.id);
}
