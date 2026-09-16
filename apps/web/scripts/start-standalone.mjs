import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const candidates = [
  ".next/standalone/apps/web/server.js",
  ".next/standalone/server.js",
];
const entry = candidates.find(existsSync);
if (!entry) {
  throw new Error(`Next standalone entry not found; checked ${candidates.join(", ")}`);
}

const child = spawn(process.execPath, [entry], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
