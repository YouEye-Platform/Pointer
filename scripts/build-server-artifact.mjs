import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createArchive,
  ensureReleaseDirectories,
  releaseMetadata,
  removeOldArchives,
  resetDirectory,
  root,
  stagingDirectory,
  writeReleaseFiles,
  command,
} from "./release-lib.mjs";

const metadata = releaseMetadata();
const stage = resolve(stagingDirectory, "server");
ensureReleaseDirectories();
removeOldArchives("server");
resetDirectory(stage);
resetDirectory(resolve(root, "apps/server/.staging"));

command("pnpm", [
  "--filter",
  "@pointer/server",
  "deploy",
  "--prod",
  "--legacy",
  stage,
]);
rmSync(resolve(root, "apps/server/.staging"), { recursive: true, force: true });
rmSync(resolve(stage, ".staging"), { recursive: true, force: true });
for (const workspacePackage of ["server", "web", "cli"]) {
  rmSync(
    resolve(stage, `node_modules/.pnpm/node_modules/@pointer/${workspacePackage}`),
    { force: true }
  );
}

command("pnpm", ["--filter", "@pointer/cli", "build"]);
mkdirSync(resolve(stage, "cli"), { recursive: true });
cpSync(resolve(root, "packages/cli/dist/index.js"), resolve(stage, "cli/pointer.js"));

mkdirSync(resolve(stage, "contracts"), { recursive: true });
cpSync(resolve(root, "packages/contracts/specs"), resolve(stage, "contracts/specs"), {
  recursive: true,
});
writeReleaseFiles(stage, "server", metadata);

const archive = createArchive("server", stage, metadata);
console.log(archive);
