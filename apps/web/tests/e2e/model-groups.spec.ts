import { expect, test, type Page, type Route } from "@playwright/test";

const generatedAt = "2026-07-29T00:00:00.000Z";
const ranking = { sort: "recommended" as const, method: "mean_percentile" as const, sourceIds: [] };

function provider(providerId: string, available: boolean, suffix = "model") {
  return {
    providerModelKey: `${providerId}-${suffix}-key`,
    providerId,
    providerName: providerId === "provider-a" ? "Provider A" : providerId === "provider-b" ? "Provider B" : "Provider C",
    providerIconKey: null,
    rawModelId: `${providerId}/${suffix}`,
    pricing: { input: 1, output: 2, currency: "USD", source: "fixture", fetchedAt: generatedAt },
    capabilities: { tools: true, vision: false, streaming: true },
    contextWindow: 128_000,
    maxOutput: 8_192,
    available,
  };
}

function model(id: string, name: string, providers: ReturnType<typeof provider>[], rank: number) {
  const availableProviderIds = new Set(providers.filter((route) => route.available).map((route) => route.providerId));
  return {
    id,
    slug: id,
    name,
    creator: "Example Labs",
    creatorIconKey: null,
    modelIconKey: null,
    description: `${name} model`,
    contextWindow: 128_000,
    maxOutput: 8_192,
    capabilities: { reasoning: true, vision: false, tools: true, streaming: true },
    referencePricing: { input: 1, output: 2, currency: "USD", source: "fixture", fetchedAt: generatedAt },
    providerCount: new Set(providers.map((route) => route.providerId)).size,
    availableProviderCount: availableProviderIds.size,
    available: availableProviderIds.size > 0,
    providers,
    aliases: [],
    benchmarks: [],
    metadataSource: "fixture",
    metadataFetchedAt: generatedAt,
    recommendedRanking: {
      method: "mean_percentile" as const,
      rank,
      percentile: 1 - ((rank - 1) / 2),
      coverage: 1,
      eligibleSources: 1,
      sources: [],
    },
  };
}

const alpha = model("model/alpha", "Alpha Human Name", [provider("provider-a", true, "alpha")], 1);
const beta = model("model/beta", "Beta Human Name", [
  provider("provider-a", true, "beta"),
  provider("provider-b", true, "beta"),
], 2);
const gamma = model("model/gamma", "Gamma Human Name", [provider("provider-c", false, "gamma")], 3);
const allModels = [alpha, beta, gamma];

type Entry = {
  id: string;
  groupId: string;
  catalogEntityId: string;
  providerModelKey: string;
  modelId: string;
  modelName: string;
  modelSlug: string;
  modelIconKey: null;
  creator: string;
  providerId: string;
  providerName: string;
  providerIconKey: null;
  rawModelId: string;
  alias: string | null;
  enabled: boolean;
  position: number;
  hiddenAliases: string[];
  providerAvailable: boolean;
  needsReview: boolean;
  inputPrice: string;
  outputPrice: string;
  contextWindow: number;
  maxOutput: number;
};

type Group = {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  createdAt: string;
  entries: Entry[];
};

function fixtureEntry(groupId: string, catalogModel = alpha, providerModelKey = alpha.providers[0].providerModelKey): Entry {
  const route = catalogModel.providers.find((candidate) => candidate.providerModelKey === providerModelKey)!;
  return {
    id: `entry-${groupId}-${catalogModel.id.replaceAll("/", "-")}`,
    groupId,
    catalogEntityId: catalogModel.id,
    providerModelKey,
    modelId: catalogModel.id,
    modelName: catalogModel.name,
    modelSlug: catalogModel.slug,
    modelIconKey: null,
    creator: catalogModel.creator,
    providerId: route.providerId,
    providerName: route.providerName,
    providerIconKey: null,
    rawModelId: route.rawModelId,
    alias: null,
    enabled: true,
    position: 0,
    hiddenAliases: ["big", "opus", "default"],
    providerAvailable: route.available,
    needsReview: false,
    inputPrice: "1",
    outputPrice: "2",
    contextWindow: 128_000,
    maxOutput: 8_192,
  };
}

function applyRoles(group: Group) {
  const roles = [
    ["big", "opus", "default"],
    ["medium", "sonnet", "secondary"],
    ["small", "haiku", "utility"],
  ];
  let enabledPosition = 0;
  group.entries.forEach((entry, position) => {
    entry.position = position;
    entry.hiddenAliases = entry.enabled ? roles[enabledPosition++] ?? [] : [];
  });
}

async function mockGroupsApi(page: Page) {
  const groups: Group[] = [
    {
      id: "group/default",
      name: "Default Picks",
      isDefault: true,
      position: 0,
      createdAt: generatedAt,
      entries: [fixtureEntry("group/default")],
    },
    {
      id: "group/secondary",
      name: "Secondary Picks",
      isDefault: false,
      position: 1,
      createdAt: generatedAt,
      entries: [],
    },
  ];
  const catalogRequests: URL[] = [];
  const mutations: Array<{ method: string; path: string; body: unknown }> = [];

  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-jwt"));
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      return route.fulfill({ json: { id: "user", email: "user@example.test", name: "User", role: "user" } });
    }
    if (url.pathname === "/api/catalog") {
      catalogRequests.push(url);
      const availability = url.searchParams.get("availability") ?? "all";
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "50");
      const filtered = allModels.filter((item) => (availability !== "available" || item.available)
        && (!search || item.name.toLowerCase().includes(search)));
      const items = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
      return route.fulfill({
        json: {
          contractVersion: "1",
          snapshotId: "fixture",
          generatedAt,
          items,
          benchmarkDescriptors: [],
          ranking,
          sources: [],
          page: pageNumber,
          pageSize,
          total: filtered.length,
          facets: {
            creators: ["Example Labs"],
            providers: [
              { id: "provider-a", name: "Provider A", available: true },
              { id: "provider-b", name: "Provider B", available: true },
              { id: "provider-c", name: "Provider C", available: false },
            ],
          },
        },
      });
    }
    if (url.pathname === "/api/catalog/detail") {
      const item = allModels.find((candidate) => candidate.id === url.searchParams.get("slug"));
      return item
        ? route.fulfill({ json: { contractVersion: "1", snapshotId: "fixture", generatedAt, benchmarkDescriptors: [], ranking, sources: [], ...item } })
        : route.fulfill({ status: 404, json: { error: "Model not found" } });
    }
    if (url.pathname === "/api/groups" && request.method() === "GET") {
      return route.fulfill({ json: groups.map((group) => ({
        ...group,
        entries: undefined,
        entryCount: group.entries.length,
        enabledEntryCount: group.entries.filter((entry) => entry.enabled).length,
      })) });
    }
    if (url.pathname === "/api/groups" && request.method() === "POST") {
      const body = request.postDataJSON() as { name: string };
      const group: Group = {
        id: `group/${groups.length + 1}`,
        name: body.name,
        isDefault: false,
        position: groups.length,
        createdAt: generatedAt,
        entries: [],
      };
      groups.push(group);
      mutations.push({ method: "POST", path: url.pathname, body });
      return route.fulfill({ status: 201, json: group });
    }
    if (url.pathname === "/api/groups/default") {
      return route.fulfill({ json: groups.find((group) => group.isDefault) });
    }

    const setDefault = url.pathname.match(/^\/api\/groups\/(.+)\/set-default$/);
    if (setDefault && request.method() === "PUT") {
      const id = decodeURIComponent(setDefault[1]);
      groups.forEach((group) => { group.isDefault = group.id === id; });
      mutations.push({ method: "PUT", path: url.pathname, body: {} });
      return route.fulfill({ json: groups.find((group) => group.id === id) });
    }
    const reorder = url.pathname.match(/^\/api\/groups\/(.+)\/entries\/reorder$/);
    if (reorder && request.method() === "PUT") {
      const id = decodeURIComponent(reorder[1]);
      const group = groups.find((candidate) => candidate.id === id)!;
      const body = request.postDataJSON() as { entryIds: string[] };
      group.entries = body.entryIds.map((entryId) => group.entries.find((entry) => entry.id === entryId)!);
      applyRoles(group);
      mutations.push({ method: "PUT", path: url.pathname, body });
      return route.fulfill({ json: { updated: true, entryIds: body.entryIds } });
    }
    const entries = url.pathname.match(/^\/api\/groups\/(.+)\/entries$/);
    if (entries && request.method() === "POST") {
      const id = decodeURIComponent(entries[1]);
      const group = groups.find((candidate) => candidate.id === id)!;
      const body = request.postDataJSON() as { catalogEntityId: string; providerModelKey: string };
      const catalogModel = allModels.find((candidate) => candidate.id === body.catalogEntityId)!;
      const entry = fixtureEntry(id, catalogModel, body.providerModelKey);
      group.entries.push(entry);
      applyRoles(group);
      mutations.push({ method: "POST", path: url.pathname, body });
      return route.fulfill({ status: 201, json: entry });
    }
    const entryPath = url.pathname.match(/^\/api\/groups\/(.+)\/entries\/([^/]+)$/);
    if (entryPath) {
      const id = decodeURIComponent(entryPath[1]);
      const entryId = decodeURIComponent(entryPath[2]);
      const group = groups.find((candidate) => candidate.id === id)!;
      const entry = group.entries.find((candidate) => candidate.id === entryId)!;
      if (request.method() === "DELETE") {
        group.entries = group.entries.filter((candidate) => candidate.id !== entryId);
        applyRoles(group);
        mutations.push({ method: "DELETE", path: url.pathname, body: null });
        return route.fulfill({ json: { deleted: true } });
      }
      const body = request.postDataJSON() as { providerModelKey?: string; alias?: string | null; enabled?: boolean };
      if (body.providerModelKey) {
        const catalogModel = allModels.find((candidate) => candidate.id === entry.catalogEntityId)!;
        const providerRoute = catalogModel.providers.find((candidate) => candidate.providerModelKey === body.providerModelKey)!;
        entry.providerModelKey = body.providerModelKey;
        entry.providerId = providerRoute.providerId;
        entry.providerName = providerRoute.providerName;
        entry.rawModelId = providerRoute.rawModelId;
      }
      if ("alias" in body) entry.alias = body.alias ?? null;
      if ("enabled" in body) entry.enabled = body.enabled!;
      applyRoles(group);
      mutations.push({ method: "PUT", path: url.pathname, body });
      return route.fulfill({ json: entry });
    }
    const groupPath = url.pathname.match(/^\/api\/groups\/(.+)$/);
    if (groupPath) {
      const id = decodeURIComponent(groupPath[1]);
      const group = groups.find((candidate) => candidate.id === id);
      if (!group) return route.fulfill({ status: 404, json: { error: "Group not found" } });
      if (request.method() === "GET") return route.fulfill({ json: group });
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { name?: string };
        if (body.name) group.name = body.name;
        mutations.push({ method: "PUT", path: url.pathname, body });
        return route.fulfill({ json: group });
      }
      groups.splice(groups.indexOf(group), 1);
      mutations.push({ method: "DELETE", path: url.pathname, body: null });
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${request.method()} ${url.pathname}` } });
  });

  return { groups, catalogRequests, mutations };
}

function latestCatalogRequest(requests: URL[]) {
  return requests[requests.length - 1];
}

test("Models defaults to added-provider availability and stars follow only the default group", async ({ page }) => {
  const fixture = await mockGroupsApi(page);
  await page.goto("/models");

  await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
  await expect(page.getByText("2 models available from your added providers")).toBeVisible();
  expect(latestCatalogRequest(fixture.catalogRequests).searchParams.get("availability")).toBe("available");
  expect(latestCatalogRequest(fixture.catalogRequests).searchParams.get("sort")).toBe("recommended");
  await expect(page.getByLabel("Instance")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Alpha Human Name" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Gamma Human Name" })).toHaveCount(0);

  const alphaStar = page.getByRole("button", { name: /Manage Alpha Human Name in Default Picks/ });
  const betaStar = page.getByRole("button", { name: /Add Beta Human Name in a model group/ });
  await expect(alphaStar).toHaveAttribute("aria-pressed", "true");
  await expect(betaStar).toHaveAttribute("aria-pressed", "false");

  await page.getByLabel("Show all models").check();
  await expect(page.getByRole("link", { name: "Gamma Human Name" })).toBeVisible();
  expect(latestCatalogRequest(fixture.catalogRequests).searchParams.get("availability")).toBe("all");
  await expect(page.getByRole("button", { name: /Add Gamma Human Name/ })).toBeDisabled();

  await page.getByRole("button", { name: "Grid" }).click();
  await expect(page.getByRole("button", { name: /Manage Alpha Human Name in Default Picks/ })).toHaveAttribute("aria-pressed", "true");
});

test("star popover always confirms exact group and provider routes", async ({ page }) => {
  const fixture = await mockGroupsApi(page);
  await page.goto("/models");

  const betaStar = page.getByRole("button", { name: /Add Beta Human Name/ });
  await betaStar.click();
  const popover = page.getByRole("dialog", { name: "Place Beta Human Name in a group" });
  await expect(popover).toBeVisible();
  await expect(popover.getByLabel("Group", { exact: true })).toHaveValue("group/default");
  await expect(popover.getByLabel("Provider")).toHaveValue("");
  await expect(popover.getByRole("option", { name: "Provider A" })).toHaveCount(1);
  await expect(popover.getByRole("option", { name: "Provider B" })).toHaveCount(1);

  await popover.getByLabel("Provider").selectOption("provider-b-beta-key");
  await popover.getByRole("button", { name: "Add to group" }).click();
  const managedBetaStar = page.getByRole("button", { name: /Manage Beta Human Name in Default Picks/ });
  await expect(managedBetaStar).toHaveAttribute("aria-pressed", "true");
  await expect(managedBetaStar).toBeFocused();
  expect(fixture.mutations.find((mutation) => mutation.method === "POST" && mutation.path.includes("/entries"))?.body).toEqual({
    catalogEntityId: "model/beta",
    providerModelKey: "provider-b-beta-key",
  });

  await managedBetaStar.click();
  await expect(popover.getByLabel("Provider")).toHaveValue("provider-b-beta-key");
  await popover.getByLabel("Provider").selectOption("provider-a-beta-key");
  await popover.getByRole("button", { name: "Update provider" }).click();
  expect(fixture.mutations.some((mutation) => mutation.method === "PUT"
    && JSON.stringify(mutation.body) === JSON.stringify({ providerModelKey: "provider-a-beta-key" }))).toBe(true);

  const alphaStar = page.getByRole("button", { name: /Manage Alpha Human Name/ });
  await alphaStar.click();
  const alphaPopover = page.getByRole("dialog", { name: "Place Alpha Human Name in a group" });
  await alphaPopover.getByLabel("Group", { exact: true }).selectOption("group/secondary");
  await expect(alphaPopover.getByLabel("Provider")).toHaveValue("provider-a-alpha-key");
  await alphaPopover.getByRole("button", { name: "Add to group" }).click();
  await expect(alphaStar).toHaveAttribute("aria-pressed", "true");
  expect(fixture.groups.find((group) => group.id === "group/secondary")?.entries).toHaveLength(1);
});

test("dedicated group page lists recommended models, searches, adds exact routes, and changes default", async ({ page }) => {
  const fixture = await mockGroupsApi(page);
  await page.goto("/groups");
  await expect(page.getByRole("heading", { name: "Model Groups" })).toBeVisible();
  await page.getByRole("link", { name: "Open group" }).nth(1).click();
  await expect(page).toHaveURL(/\/groups\/group%2Fsecondary$/);
  await expect(page.getByRole("heading", { name: "Secondary Picks" })).toBeVisible();

  await page.getByRole("button", { name: "Add model" }).first().click();
  const picker = page.getByRole("dialog", { name: "Add model" });
  const choices = picker.locator(".group-model-results > button");
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(0)).toContainText("Alpha Human Name");
  await expect(choices.nth(1)).toContainText("Beta Human Name");
  await expect(choices.nth(0)).not.toContainText("provider-a/alpha");

  await picker.getByLabel("Search available models").fill("Beta");
  await expect(choices).toHaveCount(1);
  const searchRequest = latestCatalogRequest(fixture.catalogRequests);
  expect(searchRequest.searchParams.get("search")).toBe("Beta");
  expect(searchRequest.searchParams.get("availability")).toBe("available");
  expect(searchRequest.searchParams.get("sort")).toBe("recommended");
  expect(searchRequest.searchParams.get("order")).toBe("asc");

  await choices.first().click();
  const providerStep = page.getByRole("dialog", { name: "Choose provider for Beta Human Name" });
  await providerStep.getByLabel("Provider").selectOption("provider-b-beta-key");
  await providerStep.getByRole("button", { name: "Add to group" }).click();
  await expect(page.locator(".group-entry-table tbody tr").filter({ hasText: "Beta Human Name" })).toBeVisible();
  await expect(page.getByText("big", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Change provider" }).click();
  const changeProvider = page.getByRole("dialog", { name: "Provider for Beta Human Name" });
  await changeProvider.getByLabel("Provider").selectOption("provider-a-beta-key");
  await changeProvider.getByRole("button", { name: "Update provider" }).click();
  await expect(page.locator(".group-entry-table tbody tr").filter({ hasText: "Provider A" })).toBeVisible();

  await page.getByRole("button", { name: "Set as default" }).click();
  await expect(page.getByText("★ Default")).toBeVisible();
  expect(fixture.groups.find((group) => group.id === "group/secondary")?.isDefault).toBe(true);
});

test("star popover and group controls remain keyboard and mobile accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockGroupsApi(page);
  await page.goto("/models");

  const star = page.getByRole("button", { name: /Add Beta Human Name/ });
  const starBox = await star.boundingBox();
  expect(starBox?.width).toBeGreaterThanOrEqual(44);
  expect(starBox?.height).toBeGreaterThanOrEqual(44);
  await star.click();
  const popover = page.getByRole("dialog", { name: "Place Beta Human Name in a group" });
  const popoverBox = await popover.boundingBox();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(390);
  expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(844);

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(star).toBeFocused();

  await page.goto("/groups/group%2Fsecondary");
  await expect(page.getByRole("heading", { name: "Secondary Picks" })).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
});
