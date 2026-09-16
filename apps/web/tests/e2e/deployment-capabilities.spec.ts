import { expect, test, type Page } from "@playwright/test";

const managedCapabilities = {
  contractVersion: "1",
  deploymentMode: "managed",
  localAuthAvailable: false,
  surface: "management",
  managementContractVersion: "platform-v1",
  inferenceContractVersion: "gateway-v1",
};

async function mockCapabilities(
  page: Page,
  response: { status: number; body?: unknown }
) {
  await page.route("**/.well-known/pointer", async (route) => {
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body ?? { error: "unavailable" }),
    });
  });
}

test("managed hosts suppress local login and registration without redirecting", async ({
  page,
}) => {
  await mockCapabilities(page, { status: 200, body: managedCapabilities });

  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Managed by your host platform" })
  ).toBeVisible();
  await expect(page.getByText("Settings → AI")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create one" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: "Managed by your host platform" })
  ).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/register$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("capability outages fail closed without showing an auth form", async ({
  page,
}) => {
  await mockCapabilities(page, { status: 503 });
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Unable to check this Pointer service" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
});

test("unsupported capability contract versions fail closed", async ({ page }) => {
  await mockCapabilities(page, {
    status: 200,
    body: {
      ...managedCapabilities,
      contractVersion: "2",
      deploymentMode: "standalone",
      localAuthAvailable: true,
      surface: "combined",
    },
  });
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: "Unable to check this Pointer service" })
  ).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveCount(0);
});

test("older server without capability discovery retains standalone login", async ({
  page,
}) => {
  await mockCapabilities(page, { status: 404 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});
