import { describe, expect, test } from "bun:test";
import { ensureInstallationSchema } from "./managed-contracts";

const base = {
  appId: "open-webui",
  displayName: "Open WebUI",
};

describe("managed application contract", () => {
  test("accepts only HTTPS or the same-origin YouEye Market image proxy for icons", () => {
    expect(ensureInstallationSchema.safeParse({
      ...base,
      iconUrl: "https://apps.example.test/open-webui.svg",
    }).success).toBe(true);
    expect(ensureInstallationSchema.safeParse({
      ...base,
      iconUrl: "/api/market/image?url=https%3A%2F%2Fapps.example.test%2Fopen-webui.svg",
    }).success).toBe(true);
    expect(ensureInstallationSchema.safeParse({
      ...base,
      iconUrl: "javascript:alert(1)",
    }).success).toBe(false);
    expect(ensureInstallationSchema.safeParse({
      ...base,
      iconUrl: "/unrelated/local/path",
    }).success).toBe(false);
  });
});
