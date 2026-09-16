import { Hono } from "hono";
import { and, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { resolveCatalogTelemetryModelIds } from "../services/catalog-telemetry-identity";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);

const ALLOWED_DAYS = new Set([1, 7, 30, 90]);

function range(c: { req: { query(name: string): string | undefined } }) {
  const days = Number(c.req.query("days") || 30);
  if (!ALLOWED_DAYS.has(days)) return null;
  return { days, since: new Date(Date.now() - days * 86_400_000) };
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function confidence(samples: number) {
  return samples >= 100 ? "high" : samples >= 20 ? "medium" : "low";
}

async function modelUsageCondition(entityId: string): Promise<SQL> {
  const historicalIds = await resolveCatalogTelemetryModelIds(entityId);
  return or(
    eq(schema.usageLogs.catalogEntityId, entityId),
    and(isNull(schema.usageLogs.catalogEntityId), inArray(schema.usageLogs.modelId, historicalIds)),
  )!;
}

async function aggregate(userId: string, since: Date, scope: SQL[] = []) {
  const where = and(eq(schema.usageLogs.userId, userId), gte(schema.usageLogs.createdAt, since), ...scope);
  const [totals, daily, recent] = await Promise.all([
    db.select({
      requests: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where ${schema.usageLogs.outcome} = 'success')::int`,
      knownCostSamples: sql<number>`count(${schema.usageLogs.costUsd})::int`,
      totalCost: sql<string | null>`sum(${schema.usageLogs.costUsd})`,
      inputTokens: sql<number>`coalesce(sum(${schema.usageLogs.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${schema.usageLogs.outputTokens}), 0)::int`,
      cachedTokens: sql<number>`coalesce(sum(coalesce(${schema.usageLogs.cachedTokens}, 0) + coalesce(${schema.usageLogs.cacheReadTokens}, 0)), 0)::int`,
      latencySamples: sql<number>`count(${schema.usageLogs.latencyMs})::int`,
      latencyP50: sql<number | null>`percentile_cont(.5) within group (order by ${schema.usageLogs.latencyMs}) filter (where ${schema.usageLogs.latencyMs} is not null)`,
      latencyP95: sql<number | null>`percentile_cont(.95) within group (order by ${schema.usageLogs.latencyMs}) filter (where ${schema.usageLogs.latencyMs} is not null)`,
      latencyP99: sql<number | null>`percentile_cont(.99) within group (order by ${schema.usageLogs.latencyMs}) filter (where ${schema.usageLogs.latencyMs} is not null)`,
      latencyAvg: sql<number | null>`avg(${schema.usageLogs.latencyMs})`,
      ttfbSamples: sql<number>`count(${schema.usageLogs.ttfbMs})::int`,
      ttfbP50: sql<number | null>`percentile_cont(.5) within group (order by ${schema.usageLogs.ttfbMs}) filter (where ${schema.usageLogs.ttfbMs} is not null)`,
      ttfbP95: sql<number | null>`percentile_cont(.95) within group (order by ${schema.usageLogs.ttfbMs}) filter (where ${schema.usageLogs.ttfbMs} is not null)`,
      throughputSamples: sql<number>`count(${schema.usageLogs.tokensPerSecond})::int`,
      throughputAvg: sql<number | null>`avg(${schema.usageLogs.tokensPerSecond})`,
      throughputP50: sql<number | null>`percentile_cont(.5) within group (order by ${schema.usageLogs.tokensPerSecond}) filter (where ${schema.usageLogs.tokensPerSecond} is not null)`,
      errors: sql<number>`count(*) filter (where ${schema.usageLogs.outcome} <> 'success')::int`,
    }).from(schema.usageLogs).where(where),
    db.select({
      date: sql<string>`date_trunc('day', ${schema.usageLogs.createdAt})::date::text`,
      requests: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where ${schema.usageLogs.outcome} = 'success')::int`,
      cost: sql<string | null>`sum(${schema.usageLogs.costUsd})`,
      inputTokens: sql<number>`coalesce(sum(${schema.usageLogs.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${schema.usageLogs.outputTokens}), 0)::int`,
    }).from(schema.usageLogs).where(where)
      .groupBy(sql`date_trunc('day', ${schema.usageLogs.createdAt})::date`)
      .orderBy(sql`date_trunc('day', ${schema.usageLogs.createdAt})::date`),
    db.select({
      id: schema.usageLogs.id, modelId: schema.usageLogs.modelId, providerId: schema.usageLogs.providerId,
      providerAccountId: schema.usageLogs.providerAccountId,
      instanceId: schema.usageLogs.instanceId, apiKeyId: schema.usageLogs.apiKeyId, source: schema.usageLogs.source,
      outcome: schema.usageLogs.outcome, statusCode: schema.usageLogs.statusCode,
      inputTokens: schema.usageLogs.inputTokens, outputTokens: schema.usageLogs.outputTokens,
      costUsd: schema.usageLogs.costUsd, latencyMs: schema.usageLogs.latencyMs,
      ttfbMs: schema.usageLogs.ttfbMs, tokensPerSecond: schema.usageLogs.tokensPerSecond,
      createdAt: schema.usageLogs.createdAt,
    }).from(schema.usageLogs).where(where).orderBy(sql`${schema.usageLogs.createdAt} desc`).limit(50),
  ]);

  const row = totals[0];
  const requests = row?.requests || 0;
  return {
    period: { since: since.toISOString() },
    sample: { requests, confidence: confidence(requests) },
    totals: {
      requests, successful: row?.successful || 0, errors: row?.errors || 0,
      successRate: requests ? ((row?.successful || 0) / requests) * 100 : null,
      totalCost: numberOrNull(row?.totalCost), knownCostSamples: row?.knownCostSamples || 0,
      inputTokens: row?.inputTokens || 0, outputTokens: row?.outputTokens || 0, cachedTokens: row?.cachedTokens || 0,
    },
    latency: { samples: row?.latencySamples || 0, p50: numberOrNull(row?.latencyP50), p95: numberOrNull(row?.latencyP95), p99: numberOrNull(row?.latencyP99), avg: numberOrNull(row?.latencyAvg) },
    ttfb: { samples: row?.ttfbSamples || 0, p50: numberOrNull(row?.ttfbP50), p95: numberOrNull(row?.ttfbP95) },
    throughput: { samples: row?.throughputSamples || 0, avg: numberOrNull(row?.throughputAvg), p50: numberOrNull(row?.throughputP50) },
    daily: daily.map((d) => ({ ...d, cost: numberOrNull(d.cost), successRate: d.requests ? (d.successful / d.requests) * 100 : null })),
    recent: recent.map((item) => ({ ...item, costUsd: numberOrNull(item.costUsd), tokensPerSecond: numberOrNull(item.tokensPerSecond) })),
  };
}

app.get("/summary", async (c) => {
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  const user = c.get("user");
  const filters = await usageFilters(c, user.id);
  if ("error" in filters) return c.json({ error: filters.error }, 404);
  return c.json({ days: selected.days, filters: filters.values, ...(await aggregate(user.id, selected.since, filters.conditions)) });
});

async function usageFilters(c: any, userId: string): Promise<{ conditions: SQL[]; values: Record<string, string> } | { error: string }> {
  const values: Record<string, string> = {};
  const conditions: SQL[] = [];
  const model = c.req.query("model")?.trim();
  if (model) {
    values.model = model;
    conditions.push(await modelUsageCondition(model));
  }
  const mappings = [
    ["source", schema.usageLogs.source], ["provider", schema.usageLogs.providerId],
    ["account", schema.usageLogs.providerAccountId],
    ["instance", schema.usageLogs.instanceId], ["key", schema.usageLogs.apiKeyId], ["outcome", schema.usageLogs.outcome],
  ] as const;
  for (const [name, column] of mappings) {
    const value = c.req.query(name)?.trim();
    if (value) { values[name] = value; conditions.push(eq(column, value)); }
  }
  if (values.instance) {
    const [owned] = await db.select({ id: schema.instances.id }).from(schema.instances).where(and(eq(schema.instances.id, values.instance), eq(schema.instances.userId, userId))).limit(1);
    if (!owned) return { error: "Instance not found" };
  }
  if (values.key) {
    const [owned] = await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(and(eq(schema.apiKeys.id, values.key), eq(schema.apiKeys.userId, userId))).limit(1);
    if (!owned) return { error: "API key not found" };
  }
  if (values.account) {
    const [owned] = await db.select({ id: schema.providerAccounts.id }).from(schema.providerAccounts)
      .where(and(eq(schema.providerAccounts.id, values.account), eq(schema.providerAccounts.userId, userId))).limit(1);
    if (!owned) return { error: "Provider account not found" };
  }
  return { conditions, values };
}

app.get("/breakdown", async (c) => {
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  const user = c.get("user");
  const filters = await usageFilters(c, user.id);
  if ("error" in filters) return c.json({ error: filters.error }, 404);
  const groups = { model: sql<string>`coalesce(${schema.usageLogs.catalogEntityId}, ${schema.usageLogs.modelId})`, provider: schema.usageLogs.providerId, account: schema.usageLogs.providerAccountId, instance: schema.usageLogs.instanceId, key: schema.usageLogs.apiKeyId, source: schema.usageLogs.source, outcome: schema.usageLogs.outcome };
  const group = c.req.query("group") || "model";
  if (!(group in groups)) return c.json({ error: "group must be model, provider, account, instance, key, source, or outcome" }, 400);
  const column = groups[group as keyof typeof groups];
  const rows = await db.select({
    id: column,
    requests: sql<number>`count(*)::int`,
    successful: sql<number>`count(*) filter (where ${schema.usageLogs.outcome} = 'success')::int`,
    inputTokens: sql<number>`coalesce(sum(${schema.usageLogs.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${schema.usageLogs.outputTokens}), 0)::int`,
    totalCost: sql<string | null>`sum(${schema.usageLogs.costUsd})`,
    avgLatency: sql<number | null>`avg(${schema.usageLogs.latencyMs})`,
    avgTtfb: sql<number | null>`avg(${schema.usageLogs.ttfbMs})`,
  }).from(schema.usageLogs).where(and(eq(schema.usageLogs.userId, user.id), gte(schema.usageLogs.createdAt, selected.since), ...filters.conditions)).groupBy(column).orderBy(sql`count(*) desc`).limit(200);
  return c.json({ days: selected.days, group, filters: filters.values, items: rows.map((row) => ({ ...row, totalCost: numberOrNull(row.totalCost), avgLatency: numberOrNull(row.avgLatency), avgTtfb: numberOrNull(row.avgTtfb), successRate: row.requests ? (row.successful / row.requests) * 100 : null })) });
});

app.get("/model/:id", async (c) => scoped(c, "model", c.req.param("id")));
app.get("/provider/:id", async (c) => scoped(c, "provider", c.req.param("id")));

app.get("/account/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [owned] = await db.select({ id: schema.providerAccounts.id }).from(schema.providerAccounts)
    .where(and(eq(schema.providerAccounts.id, id), eq(schema.providerAccounts.userId, user.id))).limit(1);
  if (!owned) return c.json({ error: "Provider account not found" }, 404);
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  return c.json({ id, kind: "account", days: selected.days, ...(await aggregate(user.id, selected.since, [eq(schema.usageLogs.providerAccountId, id)])) });
});

async function scoped(c: any, kind: "model" | "provider", id: string) {
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  const condition = kind === "model" ? await modelUsageCondition(id) : eq(schema.usageLogs.providerId, id);
  return c.json({ id, kind, days: selected.days, ...(await aggregate(c.get("user").id, selected.since, [condition])) });
}

app.get("/instance/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [owned] = await db.select({ id: schema.instances.id }).from(schema.instances)
    .where(and(eq(schema.instances.id, id), eq(schema.instances.userId, user.id))).limit(1);
  if (!owned) return c.json({ error: "Instance not found" }, 404);
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  return c.json({ id, kind: "instance", days: selected.days, ...(await aggregate(user.id, selected.since, [eq(schema.usageLogs.instanceId, id)])) });
});

app.get("/key/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [owned] = await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.userId, user.id))).limit(1);
  if (!owned) return c.json({ error: "API key not found" }, 404);
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  return c.json({ id, kind: "key", days: selected.days, ...(await aggregate(user.id, selected.since, [eq(schema.usageLogs.apiKeyId, id)])) });
});

app.get("/compare", async (c) => {
  const selected = range(c);
  if (!selected) return c.json({ error: "days must be one of 1, 7, 30, 90" }, 400);
  const models = (c.req.query("models") || "").split(",").filter(Boolean);
  const providers = (c.req.query("providers") || "").split(",").filter(Boolean);
  if ((models.length && providers.length) || Math.max(models.length, providers.length) > 5)
    return c.json({ error: "compare either one to five models or one to five providers" }, 400);
  const kind = models.length ? "model" : "provider";
  const ids = models.length ? models : providers;
  if (!ids.length) return c.json({ days: selected.days, kind, entities: [] });
  if (kind === "model") {
    const entities = await Promise.all(ids.map(async (id) => {
      const stats = await aggregate(c.get("user").id, selected.since, [await modelUsageCondition(id)]);
      return {
        id,
        requests: stats.sample.requests,
        confidence: stats.sample.confidence,
        successRate: stats.totals.successRate,
        avgLatency: stats.latency.avg,
        p95Latency: stats.latency.p95,
        avgTtfb: stats.ttfb.p50,
        avgTokensPerSecond: stats.throughput.avg,
        totalCost: stats.totals.totalCost,
      };
    }));
    return c.json({ days: selected.days, kind, entities });
  }
  const column = schema.usageLogs.providerId;
  const rows = await db.select({
    id: column, requests: sql<number>`count(*)::int`,
    successful: sql<number>`count(*) filter (where ${schema.usageLogs.outcome} = 'success')::int`,
    avgLatency: sql<number | null>`avg(${schema.usageLogs.latencyMs})`,
    p95Latency: sql<number | null>`percentile_cont(.95) within group (order by ${schema.usageLogs.latencyMs}) filter (where ${schema.usageLogs.latencyMs} is not null)`,
    avgTtfb: sql<number | null>`avg(${schema.usageLogs.ttfbMs})`,
    avgTokensPerSecond: sql<number | null>`avg(${schema.usageLogs.tokensPerSecond})`,
    totalCost: sql<string | null>`sum(${schema.usageLogs.costUsd})`,
  }).from(schema.usageLogs).where(and(eq(schema.usageLogs.userId, c.get("user").id), gte(schema.usageLogs.createdAt, selected.since), inArray(column, ids))).groupBy(column);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return c.json({ days: selected.days, kind, entities: ids.map((id) => {
    const r = byId.get(id); const requests = r?.requests || 0;
    return { id, requests, confidence: confidence(requests), successRate: requests ? ((r?.successful || 0) / requests) * 100 : null, avgLatency: numberOrNull(r?.avgLatency), p95Latency: numberOrNull(r?.p95Latency), avgTtfb: numberOrNull(r?.avgTtfb), avgTokensPerSecond: numberOrNull(r?.avgTokensPerSecond), totalCost: numberOrNull(r?.totalCost) };
  }) });
});

export default app;
