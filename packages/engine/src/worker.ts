// The supervisor supplies an owner-private environment before this module loads.
// OpenCodex owns provider authentication, routing and protocol handling.
import { loadConfig, startServer } from "@bitkyc08/opencodex";

const config = loadConfig();
if (config.hostname !== "127.0.0.1"
  || ["codex", "grok", "claude-desktop"].some(key => (config.clientIntegrations as Record<string, boolean> | undefined)?.[key] !== false)) {
  throw new Error("Managed engines require disabled local client integrations and a private bind");
}
// Upstream's CLI drives this gate after syncing local coding clients. That step
// is deliberately disabled here; readiness means the engine listener started,
// not that any configured provider has passed a live inference test.
let status: "pending" | "ready" | "failed" = "pending";
const readinessGate = {
  getStatus: () => status,
  markReady: () => { if (status === "pending") status = "ready"; },
  markFailed: () => { if (status === "pending") status = "failed"; },
};
const server = startServer(0, { readinessGate });
readinessGate.markReady();
process.send?.({ type: "listening", port: server.port });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
