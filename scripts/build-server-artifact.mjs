import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
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
  output,
} from "./release-lib.mjs";

const metadata = releaseMetadata();
if (output('bun', ['--version']) !== '1.4.2') throw new Error('The server artifact requires Bun 1.4.2');
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
command("pnpm", ["--filter", "@pointer/web", "build:embed"]);
cpSync(resolve(root, "apps/web/public/pointer-ui"), resolve(stage, "ui"), { recursive: true });
command("bun", ["build", "apps/server/scripts/transition-managed-identity.ts", "--target=bun", `--outfile=${resolve(stage, "transition-managed-identity.js")}`]);
command("bun", ["build", "apps/server/scripts/import-provider-state.ts", "--target=bun", "--external=@pointer/engine", `--outfile=${resolve(stage, "import-provider-state.js")}`]);
mkdirSync(resolve(stage, "cli"), { recursive: true });
cpSync(resolve(root, "packages/cli/dist/index.js"), resolve(stage, "cli/pointer.js"));
for (const notice of ["LICENSE", "NOTICE.md", "third-party"]) {
  cpSync(resolve(root, notice), resolve(stage, notice), { recursive: true });
}

mkdirSync(resolve(stage, "contracts"), { recursive: true });
cpSync(resolve(root, "packages/contracts/specs"), resolve(stage, "contracts/specs"), {
  recursive: true,
});
writeReleaseFiles(stage, "server", metadata);
cpSync(output('sh', ['-c', 'command -v bun']), resolve(stage, 'bun'));
chmodSync(resolve(stage, 'bun'), 0o755);

const archive = createArchive("server", stage, metadata);
console.log(archive);
