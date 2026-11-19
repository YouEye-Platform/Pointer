import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY } from "./release-identity.mjs";
import { LATEST_POINTER_SCHEMA_VERSION } from "../apps/server/src/db/latest-schema.mjs";

const script = resolve(import.meta.dir, "write-youeye-release-manifest.mjs");
const line = readFileSync(resolve(import.meta.dir, "../VERSION"), "utf8").trim();
const otherLine = `${Number(line.split(".")[0]) + 1}.0.0`;
const tree = "0123456789abcdef0123456789abcdef01234567";
const created = [];

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function outputDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pointer-manifest-"));
  created.push(directory);
  return directory;
}

async function runManifest(directory, version, sourceTree = tree) {
  const env = { ...process.env, YOUEYE_VERSION: `${line}-dev.3` };
  delete env.YOUEYE_LINE;
  delete env.YOUEYE_SOURCE_TREE;
  if (version !== undefined) env.YOUEYE_LINE = version;
  if (sourceTree !== null) env.YOUEYE_SOURCE_TREE = sourceTree; // null: unset
  const child = Bun.spawn(["bun", script, directory], {
    cwd: resolve(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() };
}

describe("YouEye release manifest", () => {
  test("records the line and tree (never a build name), public identity and shared schema version", async () => {
    const directory = outputDirectory();
    expect((await runManifest(directory, line)).exitCode).toBe(0);
    const text = readFileSync(resolve(directory, "release-manifest.json"), "utf8");
    const manifest = JSON.parse(text);
    expect(manifest.version).toBe(line);
    expect(manifest.sourceTree).toBe(tree);
    expect(text).not.toContain("-dev.");
    expect(manifest.repository).toBe(PUBLIC_CANONICAL_REPOSITORY);
    expect(manifest).not.toHaveProperty("branch");
    expect(manifest).not.toHaveProperty("commit");
    expect(manifest.runtime.schemaVersion).toBe(LATEST_POINTER_SCHEMA_VERSION);
    expect(manifest.runtime.bun).toBe('1.4.2 (bundled)');
    expect(manifest.runtime.engine).toEqual({package: '@bitkyc08/opencodex', version: '2.79.0'});
    expect(manifest.entrypoints.ui).toBe('ui/manifest.json');
  });

  test("refuses to write without the VERSION line and a git tree", async () => {
    for (const version of [undefined, "", "latest", `${line}-dev.3`, `${line}-rc.3`, `v${line}`, otherLine]) {
      const result = await runManifest(outputDirectory(), version);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("YOUEYE_LINE");
    }
    for (const sourceTree of [null, "", "abc", tree.toUpperCase()]) {
      const result = await runManifest(outputDirectory(), line, sourceTree);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("YOUEYE_SOURCE_TREE");
    }
  });
});
