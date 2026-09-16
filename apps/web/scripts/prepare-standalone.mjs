import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const candidates = [
  ".next/standalone/apps/web/server.js",
  ".next/standalone/server.js",
];
const entry = candidates.find(existsSync);
if (!entry) {
  throw new Error(`Next standalone entry not found; checked ${candidates.join(", ")}`);
}

const runtimeRoot = dirname(entry);
mkdirSync(join(runtimeRoot, ".next"), { recursive: true });
cpSync(".next/static", join(runtimeRoot, ".next/static"), {
  recursive: true,
  force: true,
});
if (existsSync("public")) {
  cpSync("public", join(runtimeRoot, "public"), { recursive: true, force: true });
}
console.log(entry);
