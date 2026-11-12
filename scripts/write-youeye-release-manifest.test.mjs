import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY } from "./release-identity.mjs";
import { LATEST_POINTER_SCHEMA_VERSION } from "../apps/server/src/db/latest-schema.mjs";

const script = resolve(import.meta.dir, "write-youeye-release-manifest.mjs");
const created = [];

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pointer-manifest-"));
  created.push(directory);
  return directory;
}

async function runManifest(directory, version) {
  const env = { ...process.env };
  delete env.YOUEYE_VERSION;
  if (version !== undefined) env.YOUEYE_VERSION = version;
  const child = Bun.spawn(["bun", script, directory], {
    cwd: resolve(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() };
}

describe("YouEye release manifest", () => {
  test("records the build version, public identity and shared schema version", async () => {
    const directory = outputDirectory();
    expect((await runManifest(directory, "0.6.1-rc.3")).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(directory, "release-manifest.json"), "utf8"));
    expect(manifest.version).toBe("0.6.1-rc.3");
    expect(manifest.repository).toBe(PUBLIC_CANONICAL_REPOSITORY);
    expect(manifest).not.toHaveProperty("branch");
    expect(manifest).not.toHaveProperty("commit");
    expect(manifest.runtime.schemaVersion).toBe(LATEST_POINTER_SCHEMA_VERSION);
    expect(manifest.runtime.bun).toBe('1.4.2 (bundled)');
    expect(manifest.runtime.engine).toEqual({package: '@bitkyc08/opencodex', version: '2.79.0'});
    expect(manifest.entrypoints.ui).toBe('ui/manifest.json');
  });

  test("refuses to write without a valid YOUEYE_VERSION", async () => {
    for (const version of [undefined, "", "latest", "0.6.1-rc.0", "v0.6.1"]) {
      const result = await runManifest(outputDirectory(), version);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("YOUEYE_VERSION");
    }
  });
});
