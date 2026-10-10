import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/embed", fullyParallel: false, retries: 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:3202", trace: "retain-on-failure" },
  webServer: { command: "bun tests/embed-server.mjs", url: "http://127.0.0.1:3202", reuseExistingServer: false },
});
