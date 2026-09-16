import { Hono } from "hono";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { sourceSync } from "../services/source-sync";
import { scheduleCanonicalCatalogSync } from "../services/catalog-sync";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);

app.get("/", async (c) => c.json({ contractVersion: "1", sources: await sourceSync.states() }));

app.post("/refresh", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { sources?: unknown };
  const requested = body.sources === undefined ? sourceSync.sourceIds() : body.sources;
  if (!Array.isArray(requested) || requested.some((source) => typeof source !== "string")) {
    return c.json({ error: "sources must be an array of source IDs" }, 400);
  }
  const unknown = requested.filter((source) => !sourceSync.sourceIds().includes(source));
  if (unknown.length > 0) return c.json({ error: `Unknown sources: ${unknown.join(", ")}` }, 400);

  const results = await Promise.allSettled(requested.map((source) => sourceSync.refresh(source)));
  if (results.some((result) => result.status === "fulfilled" && result.value !== null)) await scheduleCanonicalCatalogSync();
  return c.json({
    results: results.map((result, index) => result.status === "fulfilled"
      ? result.value === null
        ? { sourceId: requested[index], status: "disabled", recordCount: 0 }
        : { sourceId: requested[index], status: "ok", recordCount: result.value.records.length }
      : { sourceId: requested[index], status: "error", error: result.reason instanceof Error ? result.reason.message : "Source sync failed" }),
    sources: await sourceSync.states(),
  });
});

export default app;
