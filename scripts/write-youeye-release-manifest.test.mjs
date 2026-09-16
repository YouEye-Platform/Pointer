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

async function runManifest(directory, sourceRepository) {
  const child = Bun.spawn(["bun", script, directory], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      YOUEYE_SOURCE_COMMIT: "a".repeat(40),
      YOUEYE_SOURCE_BRANCH: "train",
      ...(sourceRepository === undefined ? {} : { YOUEYE_SOURCE_REPOSITORY: sourceRepository }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() };
}

describe("YouEye release manifest", () => {
  test("retains the private builder's logical source ID separately from public product identity", async () => {
    const directory = outputDirectory();
    expect((await runManifest(directory, "Pointer")).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(directory, "release-manifest.json"), "utf8"));
    expect(manifest.repository).toBe(PUBLIC_CANONICAL_REPOSITORY);
    expect(manifest.sourceRepository).toBe("Pointer");
    expect(manifest.branch).toBe("train");
    expect(manifest.commit).toBe("a".repeat(40));
  });
  test("writes the public canonical identity and shared schema version", async () => {
    const directory = outputDirectory();
    expect((await runManifest(directory, PUBLIC_CANONICAL_REPOSITORY)).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(directory, "release-manifest.json"), "utf8"));
    expect(manifest.repository).toBe(PUBLIC_CANONICAL_REPOSITORY);
    expect(manifest.runtime.schemaVersion).toBe(LATEST_POINTER_SCHEMA_VERSION);
  });

  test("does not fabricate absent checkout provenance and refuses unrelated sources", async () => {
    const directory = outputDirectory();
    const missing = await runManifest(directory, undefined);
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(resolve(directory, "release-manifest.json"), "utf8")).sourceRepository).toBe(null);

    const invalid = await runManifest(outputDirectory(), "https://git.example.test/team/Other");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("does not match");
  });
});
