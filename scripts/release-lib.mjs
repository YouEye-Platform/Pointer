import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY } from "./release-identity.mjs";

export const root = resolve(import.meta.dirname, "..");
export const artifactsDirectory = resolve(root, ".artifacts");
export const stagingDirectory = resolve(root, ".staging");

export function command(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

export function output(program, args) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

export function releaseMetadata() {
  const commit = output("git", ["rev-parse", "HEAD"]);
  const branch = output("git", ["branch", "--show-current"]) || "detached";
  const dirty = output("git", ["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Release artifacts require a clean Git worktree");
  }
  return {
    repository: PUBLIC_CANONICAL_REPOSITORY,
    branch,
    commit,
    builtAt: new Date().toISOString(),
    version: `${JSON.parse(readFileSync(resolve(root, "apps/server/package.json"), "utf8")).version}+${commit.slice(0, 12)}`,
  };
}

export function resetDirectory(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

export function ensureReleaseDirectories() {
  mkdirSync(artifactsDirectory, { recursive: true });
  mkdirSync(stagingDirectory, { recursive: true });
}

export function removeOldArchives(component) {
  const pattern = new RegExp(`^pointer-${component}-[0-9a-f]{12}\\.tgz(?:\\.sha256)?$`);
  for (const name of readdirSync(artifactsDirectory)) {
    if (pattern.test(name)) rmSync(resolve(artifactsDirectory, name));
  }
}

export function writeReleaseFiles(directory, component, metadata) {
  const manifest = {
    schemaVersion: 1,
    component,
    ...metadata,
  };
  writeFileSync(
    resolve(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const values = {
    POINTER_COMPONENT_VERSION: metadata.version,
    POINTER_BUILD_REPOSITORY: metadata.repository,
    POINTER_BUILD_BRANCH: metadata.branch,
    POINTER_BUILD_COMMIT: metadata.commit,
    POINTER_BUILD_AT: metadata.builtAt,
  };
  writeFileSync(
    resolve(directory, "release.env"),
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")}\n`
  );
}

export function createArchive(component, directory, metadata) {
  const name = `pointer-${component}-${metadata.commit.slice(0, 12)}.tgz`;
  const path = resolve(artifactsDirectory, name);
  command("tar", ["-C", directory, "-czf", path, "."]);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${digest}  ${name}\n`);
  return path;
}

export function requirePath(path, label = path) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
}
