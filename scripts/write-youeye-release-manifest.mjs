import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY } from "./release-identity.mjs";
import { LATEST_POINTER_SCHEMA_VERSION } from "../apps/server/src/db/latest-schema.mjs";

// The release line (YOUEYE_LINE, X.Y.Z, equal to VERSION) and the git tree
// (YOUEYE_SOURCE_TREE), both set by .youeye/build/pointer. Never a build name
// (X.Y.Z-dev.N): this file is also the release's pointer-build-contract.json, and the
// same files are promoted under other names.
const LINE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const output = process.argv[2];
if (!output) throw new Error("output directory is required");
const version = process.env.YOUEYE_LINE || "";
const sourceTree = process.env.YOUEYE_SOURCE_TREE || "";
if (!LINE.test(version)) throw new Error("YOUEYE_LINE (the release line X.Y.Z) is required");
const sourceLine = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
if (version !== sourceLine) throw new Error(`YOUEYE_LINE ${version} is not the VERSION line ${sourceLine}`);
if (!/^[0-9a-f]{40}$/.test(sourceTree)) throw new Error("YOUEYE_SOURCE_TREE (the 40-character git tree) is required");
writeFileSync(resolve(output, "release-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  component: "pointer",
  version,
  sourceTree,
  repository: PUBLIC_CANONICAL_REPOSITORY,
  runtime: { bun: "1.4.2 (bundled)", postgresql: "17", schemaVersion: LATEST_POINTER_SCHEMA_VERSION, engine: { package: "@bitkyc08/opencodex", version: "2.79.0" } },
  entrypoints: { service: "server.js", migration: "migrate.js", managedIdentityTransition: "transition-managed-identity.js", providerStateImport: "import-provider-state.js", ui: "ui/manifest.json" },
}, null, 2)}\n`);
