import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY } from "./release-identity.mjs";
import { LATEST_POINTER_SCHEMA_VERSION } from "../apps/server/src/db/latest-schema.mjs";

// The build version (X.Y.Z-dev.N) comes from YOUEYE_VERSION, assigned by the release tool.
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev\.[1-9][0-9]*$/;
const output = process.argv[2];
if (!output) throw new Error("output directory is required");
const version = process.env.YOUEYE_VERSION || "";
if (!VERSION.test(version)) throw new Error("YOUEYE_VERSION (X.Y.Z-dev.N) is required");
writeFileSync(resolve(output, "release-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  component: "pointer",
  version,
  repository: PUBLIC_CANONICAL_REPOSITORY,
  runtime: { bun: "1.4.2 (bundled)", postgresql: "17", schemaVersion: LATEST_POINTER_SCHEMA_VERSION, engine: { package: "@bitkyc08/opencodex", version: "2.79.0" } },
  entrypoints: { service: "server.js", migration: "migrate.js", managedIdentityTransition: "transition-managed-identity.js", providerStateImport: "import-provider-state.js", ui: "ui/manifest.json" },
}, null, 2)}\n`);
