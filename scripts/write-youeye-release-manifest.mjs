import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_CANONICAL_REPOSITORY, buildSourceRepository } from "./release-identity.mjs";
import { LATEST_POINTER_SCHEMA_VERSION } from "../apps/server/src/db/latest-schema.mjs";

const output = process.argv[2];
if (!output) throw new Error("output directory is required");
const commit = process.env.YOUEYE_SOURCE_COMMIT || "";
const branch = process.env.YOUEYE_SOURCE_BRANCH || "detached";
const sourceRepository = buildSourceRepository(process.env.YOUEYE_SOURCE_REPOSITORY);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("exact source commit is required");
const pkg = JSON.parse(readFileSync(resolve("apps/server/package.json"), "utf8"));
writeFileSync(resolve(output, "release-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  component: "pointer",
  version: pkg.version,
  repository: PUBLIC_CANONICAL_REPOSITORY,
  sourceRepository,
  branch,
  commit,
  runtime: { bun: "1.3.x (bundled)", postgresql: "17", schemaVersion: LATEST_POINTER_SCHEMA_VERSION },
  entrypoints: { service: "server.js", migration: "migrate.js" },
}, null, 2)}\n`);
