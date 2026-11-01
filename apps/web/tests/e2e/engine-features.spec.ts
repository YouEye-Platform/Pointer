import { expect, test } from "@playwright/test";

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
