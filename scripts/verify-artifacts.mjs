import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  artifactsDirectory,
  command,
  requirePath,
} from "./release-lib.mjs";

requirePath(artifactsDirectory, "artifact directory");
const archives = readdirSync(artifactsDirectory)
  .filter((name) => /^pointer-(server|web)-[0-9a-f]{12}\.tgz$/.test(name))
  .sort();

if (archives.length !== 2) {
  throw new Error(`Expected exactly two release archives, found ${archives.length}`);
}

function verifyLinks(directory, extractionRoot) {
  for (const name of readdirSync(directory)) {
    const entry = resolve(directory, name);
    const stat = lstatSync(entry);
    if (stat.isDirectory()) {
      verifyLinks(entry, extractionRoot);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = readlinkSync(entry);
    if (target.startsWith("/")) {
      throw new Error(`Absolute symbolic link found: ${entry} -> ${target}`);
    }
    const resolvedTarget = resolve(dirname(entry), target);
    if (!resolvedTarget.startsWith(`${extractionRoot}/`) || !existsSync(entry)) {
      throw new Error(`Escaping or broken symbolic link found: ${entry} -> ${target}`);
    }
  }
}

for (const archive of archives) {
  const path = resolve(artifactsDirectory, archive);
  const expected = readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archive}`);
  const listing = String(
    command("tar", ["-tzf", path], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    }) ?? ""
  );
  if (!listing.includes("release-manifest.json")) {
    throw new Error(`Release manifest missing from ${archive}`);
  }
  const extractionRoot = mkdtempSync(join(tmpdir(), "pointer-artifact-"));
  try {
    command("tar", ["-xzf", path, "-C", extractionRoot]);
    requirePath(resolve(extractionRoot, "release-manifest.json"));
    verifyLinks(extractionRoot, extractionRoot);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
  console.log(`verified ${basename(path)} ${actual}`);
}
