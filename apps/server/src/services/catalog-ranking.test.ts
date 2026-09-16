import { describe, expect, test } from "bun:test";
import { calculateCatalogRankings, compareRecommended } from "./catalog-ranking";
import type { BenchmarkDescriptor } from "./benchmark-registry";

const descriptor = (
  id: string,
  rankingPriority: number | null,
  higherIsBetter = true,
): BenchmarkDescriptor => ({
  id,
  label: id,
  description: id,
  sourceUrl: "https://example.com",
  license: "test",
  scoreMetric: "score",
  rankMetric: "rank",
  unit: "points",
  higherIsBetter,
  defaultVisible: true,
  rankingPriority,
  attribution: id,
});

const benchmark = (benchmarkId: string, rank: number | null, score: number | null) => ({
  benchmarkId,
  presentation: { rank, score, higherIsBetter: true },
});

describe("catalog benchmark ranking", () => {
  test("uses equal-weight source percentiles instead of source priority", () => {
    const result = calculateCatalogRankings([
      { id: "balanced", benchmarks: [benchmark("benchlm", 2, 90), benchmark("arena", 1, 1500)] },
      { id: "legacy-leader", benchmarks: [benchmark("benchlm", 1, 95), benchmark("arena", 3, 1400)] },
      { id: "arena-second", benchmarks: [benchmark("arena", 2, 1450)] },
    ], [descriptor("benchlm", 20), descriptor("arena", 30)]);

    expect(result.recommendedRankings.get("balanced")).toMatchObject({ rank: 1, coverage: 2, eligibleSources: 2 });
    expect(result.recommendedRankings.get("legacy-leader")).toMatchObject({ rank: 2, coverage: 2 });
    expect(result.recommendedRankings.get("arena-second")).toMatchObject({ rank: 3, coverage: 1 });
  });

  test("derives missing ranks from score and exposes the derivation", () => {
    const result = calculateCatalogRankings([
      { id: "first", benchmarks: [benchmark("benchlm", null, 80)] },
      { id: "second", benchmarks: [benchmark("benchlm", null, 70)] },
    ], [descriptor("benchlm", 20)]);

    expect(result.benchmarkRanks.get("benchlm")?.get("first")).toMatchObject({
      rank: 1,
      publishedRank: null,
      rankDerived: true,
      population: 2,
      percentile: 1,
    });
    expect(result.recommendedRankings.get("second")).toMatchObject({ rank: 2, percentile: 0 });
  });

  test("keeps specialist sources out of Recommended while projecting their order", () => {
    const result = calculateCatalogRankings([
      { id: "general", benchmarks: [benchmark("benchlm", 1, 90), benchmark("agent", 2, 80)] },
      { id: "agent", benchmarks: [benchmark("benchlm", 2, 80), benchmark("agent", 1, 90)] },
      { id: "unranked", benchmarks: [] },
    ], [descriptor("benchlm", 20), descriptor("agent", null)]);

    expect(result.recommendedRankings.get("general")?.rank).toBe(1);
    expect(result.benchmarkRanks.get("agent")?.get("agent")?.rank).toBe(1);
    expect(result.recommendedRankings.has("unranked")).toBe(false);
    const sorted = ["unranked", "agent", "general"].map((id) => ({
      id,
      recommendedRanking: result.recommendedRankings.get(id) ?? null,
    })).sort(compareRecommended);
    expect(sorted.map((item) => item.id)).toEqual(["general", "agent", "unranked"]);
  });
});
