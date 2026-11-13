import { expect, test } from "@playwright/test";

test("merged routes preserve filters, encoded comparison IDs and current responses", async ({ page }) => {
  await page.goto("/");
  const settings = page.locator("#pointer-settings");
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.fixtureRespond = async (path: string) => {
      const url = new URL(path, location.origin);
      if (url.pathname === "/api/stats/summary") {
        const source = url.searchParams.get("source");
        if (source === "proxy") await new Promise(resolve => setTimeout(resolve, 700));
        return Response.json({ days: 30, sample: { requests: 0, confidence: "low" }, totals: { requests: source === "proxy" ? 99 : source === "test" ? 7 : 0, inputTokens: 0, outputTokens: 0, totalCost: null, knownCostSamples: 0, errors: 0, successRate: null }, latency: { p50: null, p95: null }, throughput: { avg: null }, daily: [], recent: [] });
      }
      if (url.pathname === "/api/stats/breakdown") return Response.json({ group: url.searchParams.get("group"), items: [] });
      if (url.pathname === "/api/test-model/targets") return Response.json({ models: [], providers: [] });
      if (url.pathname === "/api/stats/compare") {
        fixture.comparedId = url.searchParams.get("models");
        return Response.json({ kind: "models", entities: [{ id: fixture.comparedId, requests: 0, confidence: "low", successRate: null, avgLatency: null, p95Latency: null, avgTtfb: null, avgTokensPerSecond: null, totalCost: null }] });
      }
    };
    fixture.pointerSettings.navigate("/dashboard");
  });
  await expect(settings.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(settings.locator(".kpi-grid strong").first()).toHaveText("0");
  await settings.getByLabel("Source", { exact: true }).selectOption("proxy");
  await settings.getByLabel("Source", { exact: true }).selectOption("test");
  await expect(settings.locator(".kpi-grid strong").first()).toHaveText("7");
  await page.waitForTimeout(850); // Allow the deliberately older response to arrive.
  await expect(settings.locator(".kpi-grid strong").first()).toHaveText("7");
  await settings.getByLabel("Group table by").selectOption("provider");
  await expect(settings.getByRole("heading", { name: "Grouped by provider" })).toBeVisible();
  await page.evaluate(() => (window as any).pointerSettings.navigate("/test-model"));
  await expect(settings.getByRole("heading", { name: "Test model", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Compare recorded usage" }).click();
  await expect(settings.getByText("Enter one to five comma-separated IDs.")).toBeVisible();
  await settings.getByLabel("IDs, comma separated").fill("model/provider/a/b");
  await settings.getByRole("button", { name: "Compare recorded usage" }).click();
  await expect(settings.getByRole("cell", { name: "model/provider/a/b", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).comparedId)).toBe("model/provider/a/b");
  const navigation = page.locator("#pointer-one").getByRole("navigation");
  for (const name of ["Usage", "Compare", "Request diagnostics", "Proxy Test"]) await expect(navigation.getByRole("link", { name, exact: true })).toHaveCount(0);
});

test("model loading follows the selected table or grid without placeholder tabs", async ({ page }) => {
  await page.goto("/");
  const settings = page.locator("#pointer-settings");
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).fixtureRespond = (path: string) => path.startsWith("/api/catalog?") ? new Promise(() => {}) : undefined;
    (window as any).pointerSettings.navigate("/models");
  });
  await expect(settings.getByRole("status", { name: "Loading models", exact: true }).locator("table")).toBeVisible();
  await expect(settings.locator(".loading-skeleton .model-grid")).toHaveCount(0);
  await settings.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(settings.getByRole("status", { name: "Loading models", exact: true }).locator(".model-grid")).toBeVisible();
  await expect(settings.locator(".loading-skeleton table")).toHaveCount(0);
  await settings.getByRole("button", { name: "Table", exact: true }).click();
  await expect(settings.getByRole("status", { name: "Loading models", exact: true }).locator("table")).toBeVisible();
});

test("combined Settings screens retain localized drafts, warnings and API values", async ({ page }) => {
  await page.goto("/");
  const settings = page.locator("#pointer-settings");
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.fixtureRespond = async (path: string) => {
      const url = new URL(path, location.origin);
      if (url.pathname === "/api/connections/sync") return Response.json({ models: 4, catalogWarning: "Synthetic catalog warning" });
      if (url.pathname === "/api/stats/summary") return Response.json({ days: 30, sample: { requests: 0, confidence: "low" }, totals: { requests: 0, inputTokens: 0, outputTokens: 0, totalCost: null, knownCostSamples: 0, errors: 0, successRate: null }, latency: { p50: null, p95: null }, throughput: { avg: null }, daily: [], recent: [] });
      if (url.pathname === "/api/stats/breakdown") return Response.json({ group: url.searchParams.get("group"), items: [] });
      if (url.pathname === "/api/test-model/targets") return Response.json({ models: [], providers: [] });
    };
  });
  await settings.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Synthetic catalog warning");
  await page.evaluate(() => (window as any).pointerSettings.setLocale("ru-RU"));
  await expect(settings.getByRole("heading", { name: "Провайдеры", exact: true })).toBeVisible();
  await settings.getByLabel("Найти провайдера", { exact: true }).fill("Provider draft");
  await page.evaluate(() => (window as any).pointerSettings.setLocale("de-DE"));
  await expect(settings.getByLabel("Anbieter suchen", { exact: true })).toHaveValue("Provider draft");
  await expect(settings.getByRole("heading", { name: "Keine passenden Anbieter", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).pointerSettings.setLocale("ru-RU"); (window as any).pointerSettings.navigate("/dashboard"); });
  await expect(settings.getByRole("heading", { name: "Обзор", exact: true })).toBeVisible();
  await settings.locator("#usage-entity").selectOption("provider");
  await settings.locator("#usage-entity-id").fill("synthetic-provider");
  await settings.locator("#usage-group").selectOption("source");
  await expect.poll(() => page.evaluate(() => (window as any).fixtureRequests.some((request: string) => {
    if (!request.startsWith("pointer-settings:/api/stats/breakdown?")) return false;
    const url = new URL(request.slice("pointer-settings:".length), location.origin);
    return url.searchParams.get("provider") === "synthetic-provider" && url.searchParams.get("group") === "source";
  }))).toBe(true);
  await page.evaluate(() => (window as any).pointerSettings.setLocale("de-DE"));
  await expect(settings.getByRole("heading", { name: "Übersicht", exact: true })).toBeVisible();
  await expect(settings.locator("#usage-entity")).toHaveValue("provider");
  await expect(settings.locator("#usage-entity-id")).toHaveValue("synthetic-provider");
  await page.evaluate(() => (window as any).pointerSettings.navigate("/test-model"));
  await expect(settings.getByRole("heading", { name: "Modell testen", exact: true })).toBeVisible();
  await settings.locator("#compare-ids").fill("model/provider/a/b");
  await page.evaluate(() => (window as any).pointerSettings.setLocale("fr-FR"));
  await expect(settings.getByRole("heading", { name: "Tester un modèle", exact: true })).toBeVisible();
  await expect(settings.locator("#compare-ids")).toHaveValue("model/provider/a/b");
  await expect(page.locator("#pointer-two").getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(settings.getByRole("navigation")).toHaveCount(0);
});
