import { sql } from "drizzle-orm";
import { db, schema } from "../db";
import { sourceRefreshIntervalMs } from "./sources/config";

export type OperationalSettings = {
  sourceRefreshHours: number;
  balanceRefreshMinutes: number;
  usageRetentionDays: number;
  catalogDiagnosticDays: number;
};

const defaults: OperationalSettings = {
  sourceRefreshHours: sourceRefreshIntervalMs() / (60 * 60 * 1000),
  balanceRefreshMinutes: 5,
  usageRetentionDays: 30,
  catalogDiagnosticDays: 7,
};

export async function operationalSettings(): Promise<OperationalSettings> {
  const rows = await db.select().from(schema.systemSettings);
  const values = new Map(rows.map((row) => [row.key, Number(row.value)]));
  const valid = (key: string, fallback: number) => {
    const value = values.get(key);
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    sourceRefreshHours: valid("source_refresh_hours", defaults.sourceRefreshHours),
    balanceRefreshMinutes: valid("balance_refresh_minutes", defaults.balanceRefreshMinutes),
    usageRetentionDays: valid("usage_retention_days", defaults.usageRetentionDays),
    catalogDiagnosticDays: valid("catalog_diagnostic_days", defaults.catalogDiagnosticDays),
  };
}

export async function pruneExpiredUsage(retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '1s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    return tx.execute(sql`delete from usage_logs where id in (
      select id from usage_logs where created_at < ${cutoff.toISOString()} order by created_at limit 10000
    ) returning id`);
  });
}
