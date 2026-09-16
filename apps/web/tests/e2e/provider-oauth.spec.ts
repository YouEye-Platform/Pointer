import { expect, test, type Page, type Route } from "@playwright/test";

async function mockProviderOAuth(page: Page) {
  let providerAdded = false;
  let connected = false;
  let pollCount = 0;
  let fromManifestBody: unknown = null;

  await page.addInitScript(() => {
    localStorage.setItem("pointer_token", "fixture-jwt");
  });

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/auth/me") {
      return route.fulfill({
        json: {
          id: "admin",
          email: "admin@example.test",
          name: "Admin",
          role: "admin",
        },
      });
    }
    if (url.pathname === "/api/providers/manifests") {
      return route.fulfill({
        json: [
          {
            id: "xai-grok",
            name: "Grok Subscription",
            type: "openai-compatible",
            auth: {
              type: "oauth-device-flow",
              connectLabel: "Connect Grok subscription",
              deviceFlowSupported: true,
            },
          },
          {
            id: "xai",
            name: "xAI",
            type: "openai-compatible",
            auth: { type: "bearer", keyPrefix: "xai-" },
          },
        ],
      });
    }
    if (url.pathname === "/api/providers" && request.method() === "GET") {
      return route.fulfill({
        json: providerAdded
          ? [
              {
                id: "xai-grok",
                name: "Grok Subscription",
                type: "openai-compatible",
                status: "active",
                hasOwnKey: connected,
                modelCount: connected ? 1 : 0,
                iconKey: "xai",
                balance: { supported: false },
              },
            ]
          : [],
      });
    }
    if (
      url.pathname === "/api/providers/from-manifest"
      && request.method() === "POST"
    ) {
      fromManifestBody = request.postDataJSON();
      providerAdded = true;
      return route.fulfill({ status: 201, json: { id: "xai-grok" } });
    }
    if (
      url.pathname === "/api/providers/xai-grok"
      && request.method() === "GET"
    ) {
      return route.fulfill({
        json: {
          id: "xai-grok",
          name: "Grok Subscription",
          type: "openai-compatible",
          authType: "oauth-device-flow",
          status: "active",
          iconKey: "xai",
          modelCount: connected ? 1 : 0,
          auth: {
            type: "oauth-device-flow",
            connectLabel: "Connect Grok subscription",
            deviceFlowSupported: true,
          },
          keyStatus: connected
            ? {
                configured: true,
                label: "Grok Subscription OAuth",
                credentialType: "oauth2",
              }
            : { configured: false },
          operations: {
            balance: {
              supported: false,
              value: null,
              updatedAt: null,
            },
            rateLimits: { supported: false, updatedAt: null },
            account: {
              supported: true,
              status: connected ? "ok" : "never_synced",
              data: connected
                ? { connected: true, subscriptionTier: "GrokPro" }
                : null,
              updatedAt: null,
            },
          },
          models: connected
            ? [
                {
                  id: "provider-model-1",
                  modelId: "grok-code",
                  canonicalSlug: null,
                  name: "Grok Code",
                  providerModelId: "grok-code",
                  inputPrice: null,
                  outputPrice: null,
                  contextWindow: 131072,
                  maxOutput: 8192,
                  supportsStreaming: true,
                  supportsTools: true,
                  supportsVision: false,
                  nativeFormat: "responses",
                  nativeEndpoint: "/responses",
                  priceFetchedAt: null,
                },
              ]
            : [],
        },
      });
    }
    if (url.pathname === "/api/stats/provider/xai-grok") {
      return route.fulfill({
        json: {
          sample: { requests: 0, confidence: "low" },
          totals: {
            successRate: null,
            totalCost: null,
            inputTokens: 0,
            outputTokens: 0,
          },
          latency: { p50: null, p95: null },
          ttfb: { p50: null },
          throughput: { avg: null },
        },
      });
    }
    if (
      url.pathname === "/api/providers/xai-grok/oauth/device/start"
      && request.method() === "POST"
    ) {
      return route.fulfill({
        status: 201,
        json: {
          flowId: "oauth_fixture",
          userCode: "ABCD-EFGH",
          verificationUri: "https://accounts.x.ai/device",
          verificationUriComplete:
            "https://accounts.x.ai/device?code=ABCD-EFGH",
          interval: 1,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      });
    }
    if (
      url.pathname
        === "/api/providers/xai-grok/oauth/device/oauth_fixture/poll"
      && request.method() === "POST"
    ) {
      pollCount += 1;
      if (pollCount === 1) {
        return route.fulfill({
          status: 202,
          json: { status: "pending", retryAfter: 1 },
        });
      }
      connected = true;
      return route.fulfill({
        json: { status: "connected", credentialId: "credential-fixture" },
      });
    }
    if (
      url.pathname
        === "/api/providers/xai-grok/oauth/device/oauth_fixture"
      && request.method() === "DELETE"
    ) {
      return route.fulfill({ json: { cancelled: true } });
    }

    return route.fulfill({
      status: 404,
      json: { error: `Unhandled fixture route: ${request.method()} ${url.pathname}` },
    });
  });

  return {
    fromManifestBody: () => fromManifestBody,
    pollCount: () => pollCount,
  };
}

test("adds and connects an OAuth subscription without collecting a key", async ({
  page,
}) => {
  const fixture = await mockProviderOAuth(page);

  await page.goto("/providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByLabel("Manifest").selectOption("xai-grok");

  await expect(page.getByLabel("API key")).toHaveCount(0);
  await expect(
    page.getByText("No password or subscription token is entered into Pointer.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Add and continue" }).click();

  await expect(page).toHaveURL(/\/providers\/xai-grok$/);
  expect(fixture.fromManifestBody()).toEqual({ manifestId: "xai-grok" });
  await expect(
    page.getByRole("button", { name: "Connect Grok subscription" })
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Connect Grok subscription" })
    .click();
  await expect(page.getByText("ABCD-EFGH")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open secure sign-in" })).toHaveAttribute(
    "href",
    "https://accounts.x.ai/device?code=ABCD-EFGH"
  );
  await expect(page.getByText(/Waiting for authorization/)).toBeVisible();

  await expect(page.getByText(/Grok Subscription is connected/)).toBeVisible({
    timeout: 6_000,
  });
  await expect(page.getByText("GrokPro")).toBeVisible();
  await expect(page.getByText("Grok Code")).toBeVisible();
  await expect(page.getByText("responses", { exact: true })).toBeVisible();
  expect(fixture.pollCount()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/access-token|refresh-token|fixture-jwt/)).toHaveCount(0);

  await page.screenshot({
    path: "test-results/provider-oauth-connected.png",
    fullPage: true,
  });
});
