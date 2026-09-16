import { sql } from "drizzle-orm";
import { db, schema } from "../db";
import { acquireCatalogWriteLock } from "./catalog-reconciliation";

// One generation per transaction, guarded by the same lock as activation.
// Never prune logical identities, user config or reviewed observation links.
export async function pruneCatalog(options: { budgetMs?: number; diagnosticDays?: number } = {}) {
  const started = Date.now();
  const budget = Math.max(1, Math.min(options.budgetMs ?? 20_000, 60_000));
  const days = Math.max(1, Math.min(options.diagnosticDays ?? 7, 365));
  const cutoff = new Date(started - days * 86_400_000);
  const result = { generations: 0, snapshots: 0, resolverRuns: 0, assets: 0, outcome: "completed" };
  try {
    for (let i = 0; i < 50; i++) {
      if (Date.now() - started >= budget) { result.outcome = "budget_exhausted"; break; }
      const count = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await acquireCatalogWriteLock(tx);
        const candidates = await tx.execute(sql`
          select g.id from catalog_generations g
          where g.state in ('retired', 'failed')
          and not exists (select 1 from resolver_runs r where r.generation_id = g.id and r.status = 'running')
          and (g.state = 'retired' or g.created_at < ${cutoff.toISOString()}
            or g.id not in (select id from catalog_generations where state = 'failed'
              order by created_at desc limit 50))
          and not exists (select 1 from catalog_generations p
            where p.state in ('active','building','ready')
            and (p.parent_generation_id = g.id or p.stats->>'previousGenerationId' = g.id))
          order by g.created_at limit 1`);
        if (!candidates.length) return 0;
        const id = String(candidates[0].id);
        // Runs use SET NULL on generation deletion, so remove their obsolete
        // decisions explicitly before deleting the generation.
        await tx.execute(sql`delete from resolver_runs where generation_id = ${id} and status <> 'running'`);
        await tx.execute(sql`delete from catalog_generations where id = ${id}`);
        return 1;
      });
      result.generations += count;
      if (!count) break;
      if (i === 49) result.outcome = "batch_cap";
    }
    if (Date.now() - started < budget) await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await acquireCatalogWriteLock(tx);
      const snapshots = await tx.execute(sql`
        delete from source_snapshots where id in (
          select s.id from source_snapshots s where not s.active
          and s.state in ('retired','failed') and s.fetched_at < ${cutoff.toISOString()}
          and not exists (select 1 from catalog_generation_snapshots r where r.snapshot_id = s.id)
          and not exists (select 1 from model_observations o join observation_entity_links l
            on l.observation_id = o.id where o.snapshot_id = s.id and l.review_state <> 'unreviewed')
          order by s.created_at limit 10
        ) returning id`);
      result.snapshots = snapshots.length;
      const runs = await tx.execute(sql`delete from resolver_runs where id in (
        select id from resolver_runs where generation_id is null and status <> 'running'
        and started_at < ${cutoff.toISOString()} order by started_at limit 10) returning id`);
      result.resolverRuns = runs.length;
      const assets = await tx.execute(sql`delete from catalog_assets where id in (
        select a.id from catalog_assets a where not a.active and a.created_at < ${cutoff.toISOString()}
        and not exists (select 1 from catalog_generation_assets r where r.asset_id = a.id)
        order by a.created_at limit 100) returning id`);
      result.assets = assets.length;
    });
  } catch {
    // Retention is retryable maintenance, not a reason to interrupt inference.
    result.outcome = "retry_needed";
  }
  const value = JSON.stringify({ ...result, completedAt: new Date().toISOString(), durationMs: Date.now() - started });
  await db.insert(schema.systemSettings).values({ key: "catalog_cleanup_status", value })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
  return JSON.parse(value);
}
