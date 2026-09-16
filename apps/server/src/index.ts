import {
  createInferenceApp,
  createManagementApp,
  createStandaloneApp,
} from "./app";
import { config } from "./config";
import { registry } from "./providers/registry";
import { refreshSupportedAccounts, refreshSupportedBalances } from "./services/provider-operations";
import { scheduleCanonicalCatalogSync } from "./services/catalog-sync";
import { ensureManagedIntegration } from "./services/managed-platform";
import { pruneManagedState } from "./services/managed-retention";
import { pruneCatalog } from "./services/catalog-retention";
import { syncModelCatalog } from "./services/model-sync";
import { sourceSync } from "./services/source-sync";
import { operationalSettings, pruneExpiredUsage } from "./services/system-settings";
import { drainUsageWrites } from "./services/usage-telemetry";
import { createBunFetchHandler } from "./http-runtime";
import { sourceRefreshDelayMs } from "./services/source-refresh-schedule";

async function startup() {
  await registry.initialize();
  await ensureManagedIntegration();

  if (!config.backgroundJobsEnabled) {
    console.log("[pointer] Background synchronization and maintenance disabled");
    return;
  }

  setTimeout(async () => {
    try {
      await syncModelCatalog();
    } catch {
      console.error("[pointer] Initial model sync failed");
    }
  }, 5000);

  setInterval(async () => {
    try {
      await syncModelCatalog();
    } catch {
      console.error("[pointer] Periodic model sync failed");
    }
  }, 60 * 60 * 1000);

  const refreshSources = async (): Promise<boolean> => {
    try {
      const results = await sourceSync.refreshAll();
      let failed = false;
      for (const { sourceId, result } of results) {
        if (result.status === "rejected") {
          failed = true;
          console.error(`[sources] ${sourceId} sync failed`);
        }
      }
      if (results.some(({ result }) => result.status === "fulfilled" && result.value !== null)) {
        await scheduleCanonicalCatalogSync();
      }
      return !failed;
    } catch {
      console.error("[catalog] Canonical sync failed");
      return false;
    }
  };

  let nextSourceRefreshAt = 0;
  let sourceRefreshFailures = 0;
  let sourceRefreshRunning = false;
  let lastBalanceRefresh = 0;
  let lastUsagePrune = 0;
  let lastManagedPrune = 0;
  const maintenance = async () => {
    const settings = await operationalSettings();
    const now = Date.now();
    if (now >= nextSourceRefreshAt && !sourceRefreshRunning) {
      sourceRefreshRunning = true;
      try {
        const successful = await refreshSources();
        sourceRefreshFailures = successful ? 0 : sourceRefreshFailures + 1;
        nextSourceRefreshAt = Date.now() + sourceRefreshDelayMs(
          settings.sourceRefreshHours * 60 * 60 * 1000,
          sourceRefreshFailures,
        );
      } finally {
        sourceRefreshRunning = false;
      }
    }
    if (
      now - lastBalanceRefresh
      >= settings.balanceRefreshMinutes * 60 * 1000
    ) {
      lastBalanceRefresh = now;
      await refreshSupportedBalances().catch(() =>
        console.error("[operations] Balance refresh failed")
      );
      await refreshSupportedAccounts().catch(() =>
        console.error("[operations] Account refresh failed")
      );
    }
    if (now - lastUsagePrune >= 60 * 60 * 1000) {
      lastUsagePrune = now;
      await pruneCatalog({ diagnosticDays: settings.catalogDiagnosticDays }).catch(() => console.error("[operations] Catalog retention failed"));
      await pruneExpiredUsage(settings.usageRetentionDays).catch(() =>
        console.error("[operations] Usage retention failed")
      );
    }
    if (now - lastManagedPrune >= 60 * 60 * 1000) {
      lastManagedPrune = now;
      await pruneManagedState().catch(() =>
        console.error("[operations] Managed-state retention failed")
      );
    }
  };
  setTimeout(
    () => void maintenance().catch(() => console.error("[operations] Maintenance failed")),
    10_000
  );
  setInterval(
    () => void maintenance().catch(() => console.error("[operations] Maintenance failed")),
    60_000
  );
}

await startup().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[pointer] Startup failed: ${message}`);
  process.exit(1);
});

const servers: Array<ReturnType<typeof Bun.serve>> = [];
if (config.mode === "standalone") {
  const app = createStandaloneApp();
  servers.push(
    Bun.serve({
      hostname: config.standalone.bind,
      port: config.standalone.port,
      fetch: createBunFetchHandler(app),
      idleTimeout: 60,
    })
  );
  console.log(
    `[pointer] Standalone listener ready on ${config.standalone.bind}:${config.standalone.port}`
  );
} else {
  const management = createManagementApp();
  const inference = createInferenceApp();
  servers.push(
    Bun.serve({
      hostname: config.management!.bind,
      port: config.management!.port,
      fetch: createBunFetchHandler(management),
      idleTimeout: 60,
    }),
    Bun.serve({
      hostname: config.inference!.bind,
      port: config.inference!.port,
      fetch: createBunFetchHandler(inference),
      idleTimeout: 60,
    })
  );
  console.log(
    `[pointer] Managed listeners ready on management ${config.management!.bind}:${config.management!.port} and inference ${config.inference!.bind}:${config.inference!.port}`
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pointer] ${signal}: draining usage writes`);
  const drained = await drainUsageWrites();
  for (const server of servers) server.stop(true);
  if (!drained) console.error("[pointer] Usage write drain timed out");
  process.exit(drained ? 0 : 1);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
