import { Hono } from "hono";
import { pruneCatalog } from "../services/catalog-retention";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { adminMiddleware, authMiddleware, type AuthUser } from "../middleware/auth";
import {
  ARTIFICIAL_ANALYSIS_SOURCE_ID,
  deleteBenchmarkCredential,
  hasBenchmarkCredential,
  saveBenchmarkCredential,
} from "../services/benchmark-credentials";
import { benchmarkRegistry } from "../services/benchmark-registry";
import { sourceSync } from "../services/source-sync";
import { ArtificialAnalysisAdapter } from "../services/sources/artificial-analysis";
import { SourceFetchError } from "../services/sources/types";
import {
  activateCatalogGeneration,
  dryRunCatalogGarbageCollection,
  listCatalogGenerations,
  reconcileCatalog,
} from "../services/catalog-reconciliation";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);
app.use("*", adminMiddleware);
app.use("*", async (c, next) => {
  const user = c.get("user");
  if (user.mode === "managed" && !user.permissions.includes("settings.manage"))
    return c.json({ error: "Settings management permission required" }, 403);
  await next();
});

app.get("/overview", async (c) => {
  const [[counts], users, providers] = await Promise.all([
    db.select({ users: sql<number>`(select count(*)::int from users)`, providers: sql<number>`(select count(*)::int from providers)`, instances: sql<number>`(select count(*)::int from instances)`, apiKeys: sql<number>`(select count(*)::int from api_keys)`, usageRows: sql<number>`(select count(*)::int from usage_logs)` }).from(schema.users).limit(1),
    db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, createdAt: schema.users.createdAt }).from(schema.users),
    db.select({ id: schema.providers.id, name: schema.providers.name, status: schema.providers.status, updatedAt: schema.providers.updatedAt }).from(schema.providers),
  ]);
  return c.json({ counts, users, providers });
});

const operationalSettingKeys = [
  "source_refresh_hours",
  "balance_refresh_minutes",
  "usage_retention_days",
  "catalog_diagnostic_days",
] as const;

app.get("/settings", async (c) => c.json(
  await db.select().from(schema.systemSettings)
    .where(inArray(schema.systemSettings.key, [...operationalSettingKeys]))
));

const settingsSchema = z.object({ settings: z.object({
  source_refresh_hours: z.coerce.number().finite().min(1).max(168).optional(),
  balance_refresh_minutes: z.coerce.number().finite().min(1).max(1440).optional(),
  usage_retention_days: z.coerce.number().finite().min(1).max(3650).optional(),
  catalog_diagnostic_days: z.coerce.number().finite().min(1).max(365).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one setting is required") });
app.put("/settings", async (c) => {
  const body = settingsSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const updatedAt = new Date();
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(body.data.settings)) {
      await tx.insert(schema.systemSettings).values({ key, value: String(value), updatedAt }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: String(value), updatedAt } });
    }
  });
  return c.json({ updated: Object.keys(body.data.settings), updatedAt });
});

app.get("/benchmark-sources", async (c) => {
  const [states, hasArtificialAnalysisCredential] = await Promise.all([
    sourceSync.states(),
    hasBenchmarkCredential(ARTIFICIAL_ANALYSIS_SOURCE_ID),
  ]);
  const stateById = new Map(states.map((state) => [state.sourceId, state]));
  return c.json({
    contractVersion: "1",
    sources: benchmarkRegistry.map((descriptor) => ({
      ...descriptor,
      optionalCredential: descriptor.id === ARTIFICIAL_ANALYSIS_SOURCE_ID,
      hasCredential: descriptor.id === ARTIFICIAL_ANALYSIS_SOURCE_ID ? hasArtificialAnalysisCredential : null,
      state: stateById.get(descriptor.id) ?? null,
    })),
  });
});

const artificialAnalysisCredentialSchema = z.object({
  apiKey: z.string().trim().min(8).max(512),
});

app.put("/benchmark-sources/artificial-analysis/credential", async (c) => {
  const body = artificialAnalysisCredentialSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "A valid Artificial Analysis API key is required" }, 400);
  let validatedSnapshot;
  try {
    validatedSnapshot = await new ArtificialAnalysisAdapter(async () => body.data.apiKey).fetch();
  } catch (error) {
    const status = error instanceof SourceFetchError && error.status === 401 ? 401 : 502;
    return c.json({
      error: {
        code: error instanceof SourceFetchError ? error.code : "upstream",
        message: "Artificial Analysis rejected the credential or returned invalid data",
      },
    }, status);
  }
  await saveBenchmarkCredential(ARTIFICIAL_ANALYSIS_SOURCE_ID, body.data.apiKey);
  const snapshot = await sourceSync.acceptValidatedSnapshot(validatedSnapshot);
  const reconciliation = await reconcileCatalog();
  return c.json({
    sourceId: ARTIFICIAL_ANALYSIS_SOURCE_ID,
    hasCredential: true,
    status: "ok",
    recordCount: snapshot?.records.length ?? 0,
    snapshotId: reconciliation.generationId,
  });
});

app.delete("/benchmark-sources/artificial-analysis/credential", async (c) => {
  await deleteBenchmarkCredential(ARTIFICIAL_ANALYSIS_SOURCE_ID);
  await sourceSync.refresh(ARTIFICIAL_ANALYSIS_SOURCE_ID);
  const reconciliation = await reconcileCatalog();
  return c.json({
    sourceId: ARTIFICIAL_ANALYSIS_SOURCE_ID,
    hasCredential: false,
    status: "disabled",
    snapshotId: reconciliation.generationId,
  });
});

app.get("/catalog/generations", async (c) => c.json({
  resolverVersion: "catalog-identity-1",
  generations: await listCatalogGenerations(),
}));

app.post("/catalog/reconcile", async (c) => c.json(await reconcileCatalog()));

app.post("/catalog/generations/:generationId/activate", async (c) => {
  const generationId = c.req.param("generationId");
  if (!/^cgn_[A-Za-z0-9_-]+$/.test(generationId)) return c.json({ error: "Invalid catalog generation ID" }, 400);
  return c.json(await activateCatalogGeneration(generationId));
});

app.get("/catalog/gc", async (c) => {
  const parsed = z.coerce.number().int().min(1).max(3650).safeParse(c.req.query("retentionDays") ?? 30);
  if (!parsed.success) return c.json({ error: "retentionDays must be an integer between 1 and 3650" }, 400);
  return c.json(await dryRunCatalogGarbageCollection({ retentionDays: parsed.data }));
});

app.get("/catalog/cleanup", async c => {
  const rows = await db.select().from(schema.systemSettings)
    .where(inArray(schema.systemSettings.key, ["catalog_cleanup_status"]));
  return c.json(rows[0] ? JSON.parse(rows[0].value) : { outcome: "not_run" });
});
app.post("/catalog/cleanup", async c => {
  const { operationalSettings } = await import("../services/system-settings");
  return c.json(await pruneCatalog({ diagnosticDays: (await operationalSettings()).catalogDiagnosticDays }));
});

export default app;
