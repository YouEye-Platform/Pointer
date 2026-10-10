import { expect, test } from "@playwright/test";

test("providers share list and detail pages, preserve keys and sign-in, and have no model toggle", async ({ page }) => {
  let saved: any; let signedIn = false; let loginCount = 0; let oauthStarted = false;
  const presets = [
    { id: "custom", label: "Custom provider", adapter: "openai-chat", baseUrl: "", auth: "key" },
    { id: "openai", label: "ChatGPT", adapter: "openai-responses", baseUrl: "", auth: "forward" },
    { id: "opencode-go", label: "OpenCode Go", adapter: "openai-chat", baseUrl: "https://provider.example.test/v1", auth: "key" },
    { id: "anthropic", label: "Anthropic", adapter: "anthropic", baseUrl: "", auth: "oauth", oauthProvider: "anthropic" },
  ];
  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-only-jwt"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/auth/me") return json({ id: "fixture", email: "fixture@example.test", name: "Preview operator", role: "user" });
    if (path === "/api/connections/provider-presets") return json({ providers: presets });
    if (path === "/api/connections/oauth/providers") return json({ providers: ["anthropic"] });
    if (path === "/api/connections/providers") {
      if (route.request().method() === "POST") { saved = route.request().postDataJSON(); return json({ success: true }); }
      return json(saved ? [{ name: saved.name, adapter: saved.provider.adapter, baseUrl: saved.provider.baseUrl, hasApiKey: true }] : []);
    }
    if (path === "/api/connections/sync") return json({ connections: 1, models: 41 });
    if (path === "/api/connections/providers/keys") return json({ keys: [{ id: "fixture-key", label: "Personal account" }] });
    if (path === "/api/connections/models") return json(saved ? [{ provider: saved.name, id: "gpt-6.1-sol", namespaced: `${saved.name}/gpt-6.1-sol`, disabled: false }] : []);
    if (path === "/api/connections/codex-auth/active") return json({ activeCodexAccountId: "fixture-account", upstreamFailoverThreshold: 3 });
    if (path === "/api/connections/pool/settings") return json({ kind: "codex", supported: ["strategy"], strategy: "quota" });
    if (path === "/api/connections/usage") return json({ providers: [] });
    if (path === "/api/connections/provider-quotas") return json({ reports: [] });
    if (path === "/api/connections/codex-auth/accounts") return json({ accounts: signedIn ? [{ id: "fixture-account", email: "fixture@example.test", plan: "plus", hasCredential: true }] : [] });
    if (path === "/api/connections/codex-auth/login") { loginCount++; return json({ flowId: "fixture-flow", url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH" }); }
    if (path === "/api/connections/codex-auth/login-status") return json({ status: signedIn ? "done" : "pending" });
    if (path === "/api/connections/oauth/accounts") return json({ accounts: [] });
    if (path === "/api/connections/oauth/login") {
      expect(route.request().postDataJSON()).toEqual({ provider: "anthropic", addAccount: true, openBrowser: false });
      oauthStarted = true; return json({ url: "https://provider.example.test/login", instructions: "Sign in, then paste the redirect URL." });
    }
    if (path === "/api/connections/oauth/status") return json({ done: false });
    if (path === "/api/connections/oauth/login/code") {
      expect(route.request().postDataJSON()).toEqual({ provider: "anthropic", input: "fixture-callback" }); return json({ ok: true });
    }
    if (path === "/api/connections/oauth/login/cancel") return json({ ok: true });
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture operation" } });
  });
  await page.goto("/connections");
  await expect(page).toHaveURL(/\/providers$/);
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  for (const label of ["ChatGPT", "OpenCode Go", "Anthropic"]) await expect(page.getByRole("link", { name: new RegExp(label) })).toBeVisible();
  await page.getByRole("link", { name: /OpenCode Go/ }).click();
  await expect(page).toHaveURL(/\/providers\/opencode-go$/);
  await page.getByLabel("API key", { exact: true }).fill("fixture-only-key");
  await page.getByRole("button", { name: "Connect provider", exact: true }).click();
  await expect(page.locator(".connection-notice")).toContainText("Models refreshed");
  expect(saved.name).toBe("opencode-go"); expect(saved.provider.apiKey).toBe("fixture-only-key");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByText("GPT-6.1 Sol", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Enable|Disable/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/pointer-provider-desktop.png", fullPage: true });
  await page.goto("/providers/openai");
  await page.getByRole("button", { name: "Connect account", exact: true }).click();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible(); expect(loginCount).toBe(1);
  signedIn = true;
  await expect(page.getByText("ABCD-EFGH", { exact: true })).not.toBeVisible({ timeout: 10000 });
  await expect(page.locator(".provider-accounts")).toContainText("fixture@example.test");
  await page.goto("/providers/anthropic");
  await page.getByRole("button", { name: "Connect account", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", "https://provider.example.test/login");
  expect(oauthStarted).toBe(true);
  await page.getByLabel("Redirect URL or authorization code").fill("fixture-callback");
  await page.getByRole("button", { name: "Complete sign-in" }).click();
  await expect(page.getByLabel("Redirect URL or authorization code")).toHaveValue("");
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(page.getByRole("link", { name: "Open sign-in page" })).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/providers/opencode-go");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Pointer" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
  await page.screenshot({ path: "test-results/pointer-provider-phone.png", fullPage: true });
});
