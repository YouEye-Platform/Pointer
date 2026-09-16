import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  command,
  createArchive,
  ensureReleaseDirectories,
  releaseMetadata,
  removeOldArchives,
  requirePath,
  resetDirectory,
  root,
  stagingDirectory,
  writeReleaseFiles,
} from "./release-lib.mjs";

const metadata = releaseMetadata();
const stage = resolve(stagingDirectory, "web");
const web = resolve(root, "apps/web");
ensureReleaseDirectories();
removeOldArchives("web");
resetDirectory(stage);

command("pnpm", ["--filter", "@pointer/web", "build"], {
  env: {
    ...process.env,
    NEXT_PUBLIC_API_URL: "",
    POINTER_COMPONENT_VERSION: metadata.version,
    POINTER_BUILD_REPOSITORY: metadata.repository,
    POINTER_BUILD_BRANCH: metadata.branch,
    POINTER_BUILD_COMMIT: metadata.commit,
    POINTER_BUILD_AT: metadata.builtAt,
  },
});
command("pnpm", ["--filter", "@pointer/web", "prepare:standalone"]);

const standalone = resolve(web, ".next/standalone");
requirePath(standalone, "Next standalone output");
cpSync(standalone, stage, { recursive: true });

function makeLinksPortable(directory) {
  for (const name of readdirSync(directory)) {
    const entry = resolve(directory, name);
    const stat = lstatSync(entry);
    if (stat.isDirectory()) {
      makeLinksPortable(entry);
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = readlinkSync(entry);
    if (!target.startsWith("/")) continue;
    const relativeTarget = relative(standalone, target);
    if (relativeTarget.startsWith("..")) {
      throw new Error(`Standalone link escapes build output: ${entry} -> ${target}`);
    }
    const stagedTarget = resolve(stage, relativeTarget);
    unlinkSync(entry);
    symlinkSync(relative(dirname(entry), stagedTarget), entry);
  }
}

makeLinksPortable(stage);

const runtime = existsSync(resolve(stage, "apps/web/server.js"))
  ? resolve(stage, "apps/web")
  : stage;
writeReleaseFiles(stage, "web", metadata);
if (runtime !== stage) writeReleaseFiles(runtime, "web", metadata);

const archive = createArchive("web", stage, metadata);
console.log(archive);
