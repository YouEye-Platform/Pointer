import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configPath, loadConfig, saveConfig } from "../src/config";

const originalConfig = process.env.POINTER_CONFIG;
const originalApiUrl = process.env.POINTER_API_URL;
const temporaryPaths: string[] = [];

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.POINTER_CONFIG;
  else process.env.POINTER_CONFIG = originalConfig;
  if (originalApiUrl === undefined) delete process.env.POINTER_API_URL;
  else process.env.POINTER_API_URL = originalApiUrl;

  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pointer-cli-test-"));
  temporaryPaths.push(directory);
  return join(directory, "nested", "config.json");
}

describe("CLI configuration", () => {
  test("persists and reloads credentials at POINTER_CONFIG", async () => {
    const path = await temporaryConfigPath();
    process.env.POINTER_CONFIG = path;

    expect(configPath()).toBe(path);
    await saveConfig({
      apiUrl: "https://pointer.example",
      token: "jwt-token",
      apiKey: "ptr_test",
      userEmail: "owner@example.com",
      instanceId: "instance-1",
    });

    expect(await loadConfig()).toEqual({
      apiUrl: "https://pointer.example",
      token: "jwt-token",
      apiKey: "ptr_test",
      userEmail: "owner@example.com",
      instanceId: "instance-1",
    });
  });

  test("uses POINTER_API_URL when the config is missing or corrupt", async () => {
    const path = await temporaryConfigPath();
    process.env.POINTER_CONFIG = path;
    process.env.POINTER_API_URL = "https://fallback.example";

    expect(await loadConfig()).toEqual({ apiUrl: "https://fallback.example" });
    await Bun.write(path, "not-json");
    expect(await loadConfig()).toEqual({ apiUrl: "https://fallback.example" });
  });
});

describe("CLI entrypoint", () => {
  test("prints help and version without contacting the API", async () => {
    const cwd = join(import.meta.dir, "..");
    const help = Bun.spawn(["bun", "run", "src/index.ts", "--help"], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(await help.exited).toBe(0);
    expect(await new Response(help.stdout).text()).toContain("Usage: pointer <command>");

    const version = Bun.spawn(["bun", "run", "src/index.ts", "--version"], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(await version.exited).toBe(0);
    expect((await new Response(version.stdout).text()).trim()).toBe("0.1.0");
  });
});
