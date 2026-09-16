import { expect, test, type Page, type Route } from "@playwright/test";

const descriptors = [
  {
    id: "artificial-analysis",
    label: "Artificial Analysis",
    description: "Artificial Analysis Intelligence Index.",
    sourceUrl: "https://artificialanalysis.ai/",
    license: "Artificial Analysis API terms",
    scoreMetric: "intelligenceIndex",
    rankMetric: "rank",
    unit: "points",
    higherIsBetter: true,
    defaultVisible: true,
    rankingPriority: 10,
    attribution: "Data provided by Artificial Analysis",
  },
  {
    id: "benchlm",
    label: "BenchLM",
    description: "Open benchmark aggregate.",
    sourceUrl: "https://benchlm.ai/data",
    license: "MIT",
    scoreMetric: "displayScore",
    rankMetric: "rank",
    unit: "points",
    higherIsBetter: true,
    defaultVisible: true,
    rankingPriority: 20,
    attribution: "BenchLM",
  },
  {
    id: "future-eval",
    label: "Future Eval",
    description: "Fixture for a benchmark unknown to the web source code.",
    sourceUrl: "https://example.test/future",
    license: "CC0-1.0",
    scoreMetric: "score",
    rankMetric: null,
    unit: "percent",
    higherIsBetter: true,
    defaultVisible: false,
    rankingPriority: null,
    attribution: "Future Eval",
  },
] as const;

const provenance = {
  source: "fixture",
  sourceUrl: "https://example.test/source",
  license: "CC0-1.0",
  fetchedAt: "2026-07-28T00:00:00.000Z",
};

function benchmark(benchmarkId: string, label: string, score: number, rank: number | null, unit: "points" | "percent" = "points") {
  return {
    benchmarkId,
    sourceModel: label,
    metrics: { score, intelligenceIndex: score, displayScore: score, rank },
    provenance,
    fetchedAt: provenance.fetchedAt,
    presentation: {
      label: benchmarkId,
      score,
      rank,
      effectiveRank: rank ?? 1,
      rankDerived: rank === null,
      population: 3,
      percentile: rank === null ? 1 : 1 - ((rank - 1) / 2),
      unit,
      higherIsBetter: true,
    },
  };
}

function model(id: string, name: string, creatorIconKey: string, modelIconKey: string | null, aaRank: number) {
  return {
    id,
    slug: id,
    name,
    creator: "Example Labs",
    creatorIconKey,
    modelIconKey,
    description: `${name} fixture model`,
    contextWindow: 128000,
    maxOutput: 8192,
    capabilities: { reasoning: true, vision: false, tools: true, streaming: true },
    referencePricing: { input: 1, output: 3, currency: "USD", source: "fixture", fetchedAt: provenance.fetchedAt },
    providerCount: 1,
    availableProviderCount: 1,
    available: true,
    providers: [],
    aliases: [],
    benchmarks: [
      benchmark("artificial-analysis", `${name} (Max)`, 100 - aaRank, aaRank),
      benchmark("benchlm", name, 80 - aaRank, aaRank + 1),
      benchmark("future-eval", name, 0.75 - aaRank / 100, null, "percent"),
    ],
    metadataSource: "fixture",
    metadataFetchedAt: provenance.fetchedAt,
    recommendedRanking: {
      method: "mean_percentile",
      rank: aaRank,
      percentile: 1 - ((aaRank - 1) / 2),
      coverage: 2,
      eligibleSources: 2,
      sources: [],
    },
  };
}

const models = [
  model("alpha", "Alpha", "google", "gemini", 1),
  model("beta", "Beta", "openai", "openai", 2),
  model("gamma", "Gamma", "example-labs", null, 3),
];

async function mockPointerApi(page: Page) {
  let aaEnabled = false;
  let submittedKey = "";
  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-jwt"));
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      return route.fulfill({ json: { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" } });
    }
    if (url.pathname === "/api/catalog") {
      return route.fulfill({
        json: {
          contractVersion: "1",
          snapshotId: "fixture-snapshot",
          generatedAt: provenance.fetchedAt,
          items: models,
          benchmarkDescriptors: descriptors,
          ranking: {
            sort: "recommended",
            method: "mean_percentile",
            sourceIds: ["artificial-analysis", "benchlm"],
          },
          sources: [],
          page: 1,
          pageSize: 50,
          total: models.length,
          facets: { creators: ["Example Labs"], providers: [] },
        },
      });
    }
    if (url.pathname === "/api/groups/default") {
      return route.fulfill({
        json: {
          id: "fixture-default-group",
          name: "Favorites",
          isDefault: true,
          position: 0,
          createdAt: provenance.fetchedAt,
          entries: [],
        },
      });
    }
    if (url.pathname === "/api/groups") {
      return route.fulfill({
        json: [{
          id: "fixture-default-group",
          name: "Favorites",
          isDefault: true,
          position: 0,
          createdAt: provenance.fetchedAt,
          entryCount: 0,
          enabledEntryCount: 0,
        }],
      });
    }
    if (url.pathname === "/api/providers") {
      return route.fulfill({
        json: [
          {
            id: "openrouter",
            name: "OpenRouter",
            type: "openai",
            status: "active",
            hasOwnKey: true,
            modelCount: 2,
            iconKey: "openrouter",
            balance: { supported: false },
          },
          {
            id: "custom-provider",
            name: "Custom Provider",
            type: "openai",
            status: "active",
            hasOwnKey: false,
            modelCount: 1,
            iconKey: "custom-provider",
            balance: { supported: false },
          },
        ],
      });
    }
    if (url.pathname === "/api/providers/manifests") {
      return route.fulfill({ json: [] });
    }
    if (url.pathname === "/api/admin/overview") {
      return route.fulfill({
        json: {
          counts: { users: 1, providers: 1, instances: 1, apiKeys: 1, usageRows: 1 },
          users: [{ id: "admin", name: "Admin", email: "admin@example.test", role: "admin", createdAt: provenance.fetchedAt }],
          providers: [{ id: "fixture", name: "Fixture", status: "active", updatedAt: provenance.fetchedAt }],
        },
      });
    }
    if (url.pathname === "/api/admin/settings") {
      if (request.method() === "PUT") return route.fulfill({ json: { updated: [] } });
      return route.fulfill({ json: [] });
    }
    if (url.pathname === "/api/admin/benchmark-sources/artificial-analysis/credential") {
      if (request.method() === "PUT") {
        submittedKey = (request.postDataJSON() as { apiKey: string }).apiKey;
        aaEnabled = true;
        return route.fulfill({ json: { sourceId: "artificial-analysis", hasCredential: true, status: "ok" } });
      }
      aaEnabled = false;
      return route.fulfill({ json: { sourceId: "artificial-analysis", hasCredential: false, status: "disabled" } });
    }
    if (url.pathname === "/api/admin/benchmark-sources") {
      return route.fulfill({
        json: {
          contractVersion: "1",
          sources: descriptors.map((descriptor) => ({
            ...descriptor,
            optionalCredential: descriptor.id === "artificial-analysis",
            hasCredential: descriptor.id === "artificial-analysis" ? aaEnabled : null,
            state: {
              sourceId: descriptor.id,
              status: descriptor.id === "artificial-analysis" && !aaEnabled ? "disabled" : "ok",
              stale: false,
              lastAttemptAt: null,
              lastSuccessAt: provenance.fetchedAt,
              fetchedAt: provenance.fetchedAt,
              recordCount: 2,
              error: null,
            },
          })),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unhandled fixture route" } });
  });
  return { submittedKey: () => submittedKey };
}

test("uses server ranking and discovers benchmark columns without web hardcoding", async ({ page }) => {
  await mockPointerApi(page);
  const iconRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/icons/brands/")
      && new URL(request.url()).pathname.endsWith(".svg")) iconRequests.push(request.url());
  });

  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  await expect(page.getByLabel("Sort", { exact: true })).toHaveValue("recommended");
  const modelLinks = page.locator(".model-table tbody tr td:first-child a");
  await expect(modelLinks.nth(0)).toHaveText("Alpha");
  await expect(modelLinks.nth(1)).toHaveText("Beta");

  await expect(page.getByLabel("Future Eval")).toBeVisible();
  await page.getByLabel("Future Eval").check();
  await expect(page.getByRole("columnheader", { name: "Future Eval" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Future Eval" })).toBeAttached();
  await expect(page.locator('[data-icon-kind="brand"]')).toHaveCount(2);
  await expect(page.locator('[data-icon-kind="brand"][data-icon-key="gemini"]')).toBeVisible();
  await expect(page.locator('[data-icon-kind="brand"][data-icon-key="openai"]')).toBeVisible();
  await expect(page.locator('[data-icon-kind="monogram"]')).toHaveCount(1);
  await expect.poll(() => iconRequests.length).toBe(2);
  expect(iconRequests.map((url) => new URL(url).pathname).sort()).toEqual([
    "/icons/brands/gemini-color.svg",
    "/icons/brands/openai.svg",
  ]);
  const noticeLink = page.getByRole("link", { name: "Icon licences" });
  await expect(noticeLink).toHaveAttribute("href", "/icons/brands/NOTICE.txt");
  const notice = await page.request.get("/icons/brands/NOTICE.txt");
  expect(notice.ok()).toBe(true);
  expect(await notice.text()).toContain("Copyright (c) 2023 LobeHub");
  await page.screenshot({ path: "test-results/benchmarks-models.png", fullPage: true });

  await page.goto("/providers");
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.locator('[data-icon-kind="brand"][data-icon-key="openrouter"]')).toBeVisible();
  await expect(page.locator('[data-icon-kind="monogram"]')).toHaveCount(1);
  await expect.poll(() => iconRequests.length).toBe(3);
  expect(iconRequests.map((url) => new URL(url).pathname).sort()).toEqual([
    "/icons/brands/gemini-color.svg",
    "/icons/brands/openai.svg",
    "/icons/brands/openrouter-color.svg",
  ]);
  await page.screenshot({ path: "test-results/icons-providers.png", fullPage: true });
});

test("configures and removes Artificial Analysis without exposing the submitted key", async ({ page }) => {
  const fixture = await mockPointerApi(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Artificial Analysis", level: 2 })).toBeVisible();
  const input = page.getByLabel("Artificial Analysis API key", { exact: true });
  await input.fill("fixture-aa-key-12345");
  await page.getByRole("button", { name: "Save Artificial Analysis API key" }).click();
  await expect(page.getByText(/Artificial Analysis enabled/)).toBeVisible();
  await expect(input).toHaveValue("");
  expect(fixture.submittedKey()).toBe("fixture-aa-key-12345");
  await expect(page.getByText("fixture-aa-key-12345")).toHaveCount(0);
  await expect(page.locator('[data-source-id="artificial-analysis"]')).toContainText("ok");

  await page.getByRole("button", { name: "Remove Artificial Analysis API key" }).click();
  await expect(page.getByText(/Artificial Analysis disabled/)).toBeVisible();
  await expect(page.locator('[data-source-id="artificial-analysis"]')).toContainText("disabled");
  await page.screenshot({ path: "test-results/benchmarks-admin.png", fullPage: true });
});
