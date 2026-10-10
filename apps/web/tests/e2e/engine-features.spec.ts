import { expect, test } from "@playwright/test";

test("request diagnostics preserve zero, unknown cost and attempt attribution", async ({ page }) => {
  const queries: string[] = [];
  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-jwt"));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { id: "fixture", name: "Operator", role: "user" } });
    if (url.pathname === "/api/connections/logs") { queries.push(url.search); return route.fulfill({ json: { total: 1, logs: [{ requestId: "fixture-request", timestamp: 1735689600000, provider: "provider-a", model: "group fallback", resolvedModel: "glm-model", servedModel: "glm-model", status: 200, durationMs: 120, usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 }, displayMetrics: { cost: { kind: "unavailable", reason: "price_missing" } }, attempts: [{ provider: "provider-a", model: "glm-model", status: 200, durationMs: 120, accountLogLabel: "kfixture" }] }] } }); }
    return route.fulfill({ status: 404, json: { error: "No fixture operation" } });
  });
  await page.goto("/diagnostics");
  await expect(page.getByText(/10 input \/ 3 output \/ 0 cached \/ Unknown reasoning/)).toBeVisible();
  await expect(page.getByText("Cost: Unknown (price_missing)")).toBeVisible();
  await page.getByText("1 routing attempts").click();
  await expect(page.getByText(/provider-a\/glm-model/)).toBeVisible();
  await page.getByLabel("Status", { exact: true }).selectOption("2xx");
  await expect.poll(() => queries.at(-1)).toContain("status=2xx");
  await page.screenshot({ path: "test-results/pointer-diagnostics-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/pointer-diagnostics-phone.png", fullPage: true });
});

test("helper controls save only supported settings and report rejected changes", async ({ page }) => {
  let saved: any;
  const initial = { webSearch: { enabled: false, model: "provider-a/search", backend: "openai", streamRoutedModelOutput: false, internalState: "not editable" }, vision: { enabled: false, model: "provider-a/vision", backend: "routed", internalState: "not editable" }, webSearchModels: [], visionModels: [] };
  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-jwt"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { id: "fixture", name: "Operator", role: "user" } });
    if (path === "/api/connections/sidecar-settings") {
      if (route.request().method() === "PUT") { saved = route.request().postDataJSON(); return route.fulfill({ status: 400, json: { error: "Helper model unavailable" } }); }
      return route.fulfill({ json: initial });
    }
    return route.fulfill({ status: 404, json: { error: "No fixture operation" } });
  });
  await page.goto("/routing");
  await page.getByLabel("Enable web search", { exact: true }).check();
  await page.getByRole("button", { name: "Save helper settings" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Helper model unavailable");
  expect(saved.webSearch.enabled).toBe(true);
  expect(saved.webSearch.internalState).toBeUndefined(); expect(saved.vision.internalState).toBeUndefined();
  await expect(page.getByLabel("Enable web search", { exact: true })).toBeChecked();
});
