import { expect, test, type Page, type Route } from "@playwright/test";

const capabilities = {
  contractVersion: "1",
  deploymentMode: "standalone",
  localAuthAvailable: true,
  surface: "combined",
  managementContractVersion: "platform-v1",
  inferenceContractVersion: "gateway-v1",
};

const targets = {
  models: [{
    id: "model/example-reasoning",
    name: "Example Reasoning",
    canonicalModelId: "model/example-reasoning",
    providers: [{
      id: JSON.stringify(["example", "example/reasoning"]),
      providerId: "example",
      providerName: "Example Provider",
      providerIconKey: "example",
      rawModelId: "example/reasoning",
    }],
  }],
  providers: [{
    id: "example",
    name: "Example Provider",
    iconKey: "example",
    modelCount: 1,
  }],
};

async function mockTestModel(page: Page, stream: string) {
  await page.addInitScript(() => localStorage.setItem("pointer_token", "fixture-jwt"));
  await page.route("**/.well-known/pointer", (route) => route.fulfill({ json: capabilities }));
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      return route.fulfill({
        json: { id: "fixture-user", email: "user@example.test", name: "User", role: "user" },
      });
    }
    if (pathname === "/api/test-model/targets") return route.fulfill({ json: targets });
    if (pathname === "/api/stats/summary") {
      return route.fulfill({
        json: {
          summary: {},
          daily: [],
          recent: [],
        },
      });
    }
    if (pathname === "/api/test-model" && request.method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: stream,
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

test("shows reasoning separately and completes only after a clean terminal", async ({ page }) => {
  await mockTestModel(page, [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Checking the route."},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}',
    "",
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));

  await page.goto("/test-model");
  await expect(page.getByLabel("Max output tokens")).toHaveValue("512");
  await page.getByRole("button", { name: "Run test" }).click();

  await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  await expect(page.getByText("OK", { exact: true })).toBeVisible();
  const reasoning = page.getByText(/Reasoning received/);
  await expect(reasoning).toBeVisible();
  await reasoning.click();
  await expect(page.getByTestId("test-reasoning-output")).toContainText("Checking the route.");
  await expect(page.locator(".test-result-notice[role=alert]")).toHaveCount(0);
});

test("surfaces an SSE error and never reports the run as complete", async ({ page }) => {
  await mockTestModel(page, [
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
    "",
    'data: {"error":{"type":"server_error","code":"upstream_error","message":"The provider stream could not be completed."}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));

  await page.goto("/test-model");
  await page.getByRole("button", { name: "Run test" }).click();

  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.locator(".test-result-notice[role=alert]")).toContainText("The provider stream could not be completed.");
  await expect(page.getByText("Complete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("partial", { exact: true })).toBeVisible();
});
