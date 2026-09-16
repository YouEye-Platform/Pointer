import { describe, expect, test } from "bun:test";
import { AiderAdapter } from "./aider";
import { LMArenaAdapter } from "./lmarena";
import { LiveBenchAdapter } from "./livebench";
import { BenchLmAdapter } from "./benchlm";
import { ArtificialAnalysisAdapter } from "./artificial-analysis";
import type { FetchLike, SourceAdapter } from "./types";

const fixedNow = () => new Date("2026-07-10T00:00:00.000Z");
const asFetch = (implementation: FetchLike) => implementation;

describe("approved benchmark adapters", () => {
  test("normalizes Aider polyglot and edit leaderboards with Apache provenance", async () => {
    const yaml = `- model: model-a\n  edit_format: diff\n  pass_rate_1: 0.5\n  pass_rate_2: 0.7\n  total_cost: 1.2\n`;
    const snapshot = await new AiderAdapter().fetch({ fetchImpl: asFetch(async () => new Response(yaml)), now: fixedNow });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].metrics.polyglotPassRate2).toBe(0.7);
    expect(snapshot.records[0].metrics.editPassRate2).toBe(0.7);
    expect(snapshot.provenance.license).toBe("Apache-2.0");
  });

  test("normalizes official LMArena overall rows and validates date", async () => {
    const parser = async () => [{ model: "model-a", category: "overall", rating: 1234, rank: 2, votes: 99, date: "2026-07-09" }];
    const snapshot = await new LMArenaAdapter(parser).fetch({
      fetchImpl: asFetch(async (url) => String(url).includes("/api/datasets/")
        ? Response.json(["https://example.test/lmarena.parquet"])
        : new Response(new Uint8Array([1, 2, 3]))),
      now: fixedNow,
    });
    expect(snapshot.records[0].metrics.arenaScore).toBe(1234);
    expect(snapshot.provenance.license).toBe("CC-BY-4.0");
  });

  test("keeps each LMArena subset distinct and makes parquet BigInt rows JSON-safe", async () => {
    const parser = async () => [[
      "vision-model",
      "Example",
      "Proprietary",
      1400,
      1390,
      1410,
      12n,
      99n,
      1n,
      "overall",
      "2026-07-28",
    ]];
    const snapshot = await new LMArenaAdapter(parser, {
      id: "lmarena-vision",
      config: "vision_style_control",
    }).fetch({
      fetchImpl: asFetch(async (url) => String(url).includes("/api/datasets/")
        ? Response.json(["https://example.test/lmarena.parquet"])
        : new Response(new Uint8Array([1, 2, 3]))),
      now: fixedNow,
    });
    expect(snapshot.records[0]).toMatchObject({
      benchmarkId: "lmarena-vision",
      sourceModelId: "vision-model",
      creator: "Example",
      metrics: { votes: 99, rank: 1, leaderboardDate: "2026-07-28" },
    });
    expect(() => JSON.stringify(snapshot.records[0].raw)).not.toThrow();
  });

  test("normalizes official LiveBench parquet rows by category", async () => {
    const parser = async () => [
      { model: "model-a", score: 0.8, category: "coding" },
      { model: "model-a", score: 0.6, category: "language" },
    ];
    const fetchImpl = asFetch(async (url) => String(url).includes("/parquet/default/leaderboard")
      ? Response.json(["https://example.test/livebench.parquet"])
      : new Response(new Uint8Array([1, 2, 3])));
    const snapshot = await new LiveBenchAdapter(parser).fetch({ fetchImpl, now: fixedNow });
    expect(snapshot.records[0].metrics.coding).toBe(0.8);
    expect(snapshot.records[0].metrics.overall).toBe(0.7);
  });

  test("normalizes BenchLM rankings and dynamically discovered scores", async () => {
    const snapshot = await new BenchLmAdapter().fetch({
      fetchImpl: asFetch(async () => Response.json({
        items: [{
          canonicalModelKey: "alpha",
          slug: "alpha",
          model: "Alpha",
          creator: "Example",
          scores: { displayScore: 73.5, displayCategoryScores: { coding: 80 } },
          ranking: { overallRank: 4 },
        }],
      })),
      now: fixedNow,
    });
    expect(snapshot.records[0]).toMatchObject({
      benchmarkId: "benchlm",
      sourceModelId: "alpha",
      metrics: { displayScore: 73.5, rank: 4, categoryCoding: 80 },
    });
  });

  test("paginates Artificial Analysis with documented parameters and preserves Free-tier data", async () => {
    const requests: string[] = [];
    const snapshot = await new ArtificialAnalysisAdapter(async () => "fixture-key").fetch({
      fetchImpl: asFetch(async (url, init) => {
        requests.push(String(url));
        expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-key");
        const requestUrl = new URL(String(url));
        const page = requestUrl.searchParams.get("page");
        expect(requestUrl.searchParams.has("page_size")).toBe(false);
        return Response.json(page === "1" ? {
          tier: "free",
          intelligence_index_version: 4.1,
          data: [{
            id: "aa-alpha",
            slug: "alpha-max",
            name: "Alpha (Max)",
            model_creator: { id: "creator-a", name: "Example" },
            evaluations: {
              artificial_analysis_intelligence_index: 91,
              newly_published_metric: 44.5,
            },
            artificial_analysis_intelligence_index_cost: { total_cost: 12.5 },
            pricing: { price_1m_input_tokens: 1.25 },
            performance: { median_output_tokens_per_second: 150 },
          }],
          pagination: { page: 1, page_size: 200, total_pages: 2, has_more: true },
        } : {
          tier: "free",
          intelligence_index_version: 4.1,
          data: [{
            id: "aa-beta",
            slug: "beta",
            name: "Beta",
            evaluations: { artificial_analysis_intelligence_index: 88 },
          }],
          pagination: { page: 2, page_size: 200, total_pages: 2, has_more: false },
        });
      }),
      now: fixedNow,
    });
    expect(requests).toHaveLength(2);
    expect(snapshot.records[0]).toMatchObject({
      sourceModelId: "aa-alpha",
      creator: "Example",
      metrics: {
        artificialAnalysisId: "aa-alpha",
        intelligenceIndex: 91,
        newlyPublishedMetric: 44.5,
        intelligenceIndexVersion: 4.1,
        responseTier: "free",
        rank: 1,
      },
      raw: {
        intelligenceIndexCost: { total_cost: 12.5 },
        pricing: { price_1m_input_tokens: 1.25 },
        performance: { median_output_tokens_per_second: 150 },
      },
    });
    expect(snapshot.records[1].metrics.rank).toBe(2);
  });

  test("rejects contradictory Artificial Analysis pagination", async () => {
    const adapter = new ArtificialAnalysisAdapter(async () => "fixture-key");
    await expect(adapter.fetch({
      fetchImpl: asFetch(async () => Response.json({
        tier: "free",
        intelligence_index_version: 4.1,
        data: [{ id: "aa-alpha", name: "Alpha", evaluations: {} }],
        pagination: { page: 1, page_size: 200, total_pages: 2, has_more: false },
      })),
    })).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("benchmark adapter failure fixtures", () => {
  const cases: Array<{ name: string; create: () => SourceAdapter<unknown> }> = [
    { name: "Aider", create: () => new AiderAdapter() },
    { name: "LMArena", create: () => new LMArenaAdapter() },
    { name: "LiveBench", create: () => new LiveBenchAdapter(async () => []) },
    { name: "BenchLM", create: () => new BenchLmAdapter() },
    { name: "Artificial Analysis", create: () => new ArtificialAnalysisAdapter(async () => "fixture-key") },
  ];

  for (const fixture of cases) {
    test(`${fixture.name} reports upstream errors`, async () => {
      const adapter = fixture.create();
      await expect(adapter.fetch({ fetchImpl: asFetch(async () => new Response("bad", { status: 503 })) }))
        .rejects.toMatchObject({ code: "upstream", status: 503 });
    });

    test(`${fixture.name} rejects oversized responses`, async () => {
      const adapter = fixture.create();
      const fetchImpl = asFetch(async () => new Response("x", { headers: { "content-length": String(adapter.maxBytes + 1) } }));
      await expect(adapter.fetch({ fetchImpl })).rejects.toMatchObject({ code: "oversized" });
    });

    test(`${fixture.name} reports timeouts`, async () => {
      const adapter = fixture.create();
      const previous = adapter.timeoutMs;
      Object.defineProperty(adapter, "timeoutMs", { value: 1, configurable: true });
      const fetchImpl = asFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      try {
        await expect(adapter.fetch({ fetchImpl })).rejects.toMatchObject({ code: "timeout" });
      } finally {
        Object.defineProperty(adapter, "timeoutMs", { value: previous, configurable: true });
      }
    });

    test(`${fixture.name} rejects malformed responses`, async () => {
      const adapter = fixture.create();
      await expect(adapter.fetch({ fetchImpl: asFetch(async () => new Response("not valid source data")) }))
        .rejects.toMatchObject({ code: "malformed" });
    });
  }

  test("Aider rejects an empty leaderboard", async () => {
    await expect(new AiderAdapter().fetch({ fetchImpl: asFetch(async () => new Response("[]")) }))
      .rejects.toMatchObject({ code: "empty" });
  });

  test("LMArena rejects an empty leaderboard", async () => {
    await expect(new LMArenaAdapter(async () => []).fetch({
      fetchImpl: asFetch(async (url) => String(url).includes("/api/datasets/")
        ? Response.json(["https://example.test/lmarena.parquet"])
        : new Response(new Uint8Array([1]))),
    }))
      .rejects.toMatchObject({ code: "empty" });
  });

  test("LiveBench rejects an empty parsed leaderboard", async () => {
    const fetchImpl = asFetch(async (url) => String(url).includes("/parquet/default/leaderboard")
      ? Response.json(["https://example.test/livebench.parquet"])
      : new Response(new Uint8Array([1])));
    await expect(new LiveBenchAdapter(async () => []).fetch({ fetchImpl })).rejects.toMatchObject({ code: "empty" });
  });
});
