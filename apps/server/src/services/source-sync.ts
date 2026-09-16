import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../db";
import { AiderAdapter } from "./sources/aider";
import { LMArenaAdapter, LM_ARENA_CONFIGS } from "./sources/lmarena";
import { LiveBenchAdapter } from "./sources/livebench";
import { OpenRouterAdapter } from "./sources/openrouter";
import { BenchLmAdapter } from "./sources/benchlm";
import { ArtificialAnalysisAdapter } from "./sources/artificial-analysis";
import {
  ARTIFICIAL_ANALYSIS_SOURCE_ID,
  getBenchmarkCredential,
  hasBenchmarkCredential,
} from "./benchmark-credentials";
import { sourceTtlMs } from "./sources/config";
import { stageSourceInventorySnapshot } from "./catalog-reconciliation";
import {
  SourceFetchError,
  type NormalizedBenchmarkRecord,
  type NormalizedReferenceModel,
  type SourceAdapter,
  type SourceSnapshot,
  type SourceState,
} from "./sources/types";

type SourceRecord = NormalizedReferenceModel | NormalizedBenchmarkRecord;

export interface SourceSnapshotStore {
  markAttempt(sourceId: string, at: Date): Promise<void>;
  markDisabled(sourceId: string, at: Date): Promise<void>;
  replace(snapshot: SourceSnapshot<SourceRecord>, at: Date): Promise<void>;
  markFailure(sourceId: string, at: Date, error: SourceFetchError): Promise<void>;
  listStates(): Promise<Array<{
    sourceId: string;
    status: string;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    fetchedAt: Date | null;
    recordCount: number;
    errorCode: string | null;
    errorMessage: string | null;
  }>>;
}

export class PostgresSourceSnapshotStore implements SourceSnapshotStore {
  async markDisabled(sourceId: string, at: Date) {
    await db.insert(schema.sourceSyncStates).values({
      sourceId,
      status: "disabled",
      errorCode: null,
      errorMessage: null,
      updatedAt: at,
    }).onConflictDoUpdate({
      target: schema.sourceSyncStates.sourceId,
      set: { status: "disabled", errorCode: null, errorMessage: null, updatedAt: at },
    });
  }

  async markAttempt(sourceId: string, at: Date) {
    await db.insert(schema.sourceSyncStates).values({ sourceId, status: "syncing", lastAttemptAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: schema.sourceSyncStates.sourceId, set: { status: "syncing", lastAttemptAt: at, updatedAt: at } });
  }

  async replace(snapshot: SourceSnapshot<SourceRecord>, at: Date) {
    await db.transaction(async (tx) => {
      await stageSourceInventorySnapshot(tx, snapshot, at);
      await tx.delete(schema.sourceRecords).where(eq(schema.sourceRecords.sourceId, snapshot.sourceId));
      for (let offset = 0; offset < snapshot.records.length; offset += 250) {
        const values = snapshot.records.slice(offset, offset + 250).map((record) => ({
          id: nanoid(),
          sourceId: snapshot.sourceId,
          recordKey: "id" in record ? record.id : `${record.benchmarkId}:${record.sourceModelId ?? record.sourceModel}`,
          kind: "id" in record ? "reference_model" : "benchmark",
          payload: record,
          provenance: snapshot.provenance,
          fetchedAt: new Date(snapshot.provenance.fetchedAt),
        }));
        await tx.insert(schema.sourceRecords).values(values);
      }
      await tx.update(schema.sourceSyncStates).set({
        status: "ok",
        lastSuccessAt: at,
        fetchedAt: new Date(snapshot.provenance.fetchedAt),
        recordCount: snapshot.records.length,
        errorCode: null,
        errorMessage: null,
        updatedAt: at,
      }).where(eq(schema.sourceSyncStates.sourceId, snapshot.sourceId));
    });
  }

  async markFailure(sourceId: string, at: Date, error: SourceFetchError) {
    await db.insert(schema.sourceSyncStates).values({
      sourceId,
      status: "error",
      lastAttemptAt: at,
      errorCode: error.code,
      errorMessage: error.message.slice(0, 500),
      updatedAt: at,
    }).onConflictDoUpdate({
      target: schema.sourceSyncStates.sourceId,
      set: { status: "error", errorCode: error.code, errorMessage: error.message.slice(0, 500), updatedAt: at },
    });
  }

  listStates() {
    return db.select().from(schema.sourceSyncStates);
  }
}

export class SourceSyncCoordinator {
  private readonly inFlight = new Map<string, Promise<SourceSnapshot<SourceRecord> | null>>();

  constructor(
    private readonly adapters: Map<string, SourceAdapter<SourceRecord>>,
    private readonly store: SourceSnapshotStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = sourceTtlMs()
  ) {}

  sourceIds(): string[] {
    return [...this.adapters.keys()];
  }

  refresh(sourceId: string): Promise<SourceSnapshot<SourceRecord> | null> {
    const existing = this.inFlight.get(sourceId);
    if (existing) return existing;
    const adapter = this.adapters.get(sourceId);
    if (!adapter) return Promise.reject(new SourceFetchError(`Unknown source: ${sourceId}`, "malformed"));

    const refresh = this.runRefresh(adapter).finally(() => this.inFlight.delete(sourceId));
    this.inFlight.set(sourceId, refresh);
    return refresh;
  }

  async acceptValidatedSnapshot(snapshot: SourceSnapshot<SourceRecord>): Promise<SourceSnapshot<SourceRecord>> {
    if (!this.adapters.has(snapshot.sourceId)) {
      throw new SourceFetchError(`Unknown source: ${snapshot.sourceId}`, "malformed");
    }
    const acceptedAt = this.now();
    await this.store.markAttempt(snapshot.sourceId, acceptedAt);
    await this.store.replace(snapshot, this.now());
    return snapshot;
  }

  async refreshAll() {
    const results = await Promise.allSettled(this.sourceIds().map((sourceId) => this.refresh(sourceId)));
    return results.map((result, index) => ({ sourceId: this.sourceIds()[index], result }));
  }

  async states(): Promise<SourceState[]> {
    const now = this.now().getTime();
    const rows = await this.store.listStates();
    const byId = new Map(rows.map((row) => [row.sourceId, row]));
    return this.sourceIds().map((sourceId) => {
      const row = byId.get(sourceId);
      const fetchedAt = row?.fetchedAt ?? null;
      return {
        sourceId,
        status: (row?.status ?? "never_synced") as SourceState["status"],
        stale: row?.status === "disabled" ? false : !fetchedAt || now - fetchedAt.getTime() > this.ttlMs,
        lastAttemptAt: row?.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        fetchedAt: fetchedAt?.toISOString() ?? null,
        recordCount: row?.recordCount ?? 0,
        error: row?.errorCode ? { code: row.errorCode as SourceFetchError["code"], message: row.errorMessage ?? "Source sync failed" } : null,
      };
    });
  }

  private async runRefresh(adapter: SourceAdapter<SourceRecord>) {
    if (adapter.enabled && !(await adapter.enabled())) {
      await this.store.markDisabled(adapter.id, this.now());
      return null;
    }
    const attemptedAt = this.now();
    await this.store.markAttempt(adapter.id, attemptedAt);
    try {
      const snapshot = await adapter.fetch({ now: this.now });
      await this.store.replace(snapshot, this.now());
      return snapshot;
    } catch (error) {
      const sourceError = error instanceof SourceFetchError
        ? error
        : new SourceFetchError(error instanceof Error ? error.message : "Unknown source error", "malformed");
      await this.store.markFailure(adapter.id, this.now(), sourceError);
      throw sourceError;
    }
  }
}

const adapters = new Map<string, SourceAdapter<SourceRecord>>([
  ["openrouter", new OpenRouterAdapter()],
  ...LM_ARENA_CONFIGS.map((definition) =>
    [definition.id, new LMArenaAdapter(undefined, definition)] as [string, SourceAdapter<SourceRecord>]),
  ["benchlm", new BenchLmAdapter()],
  ["livebench", new LiveBenchAdapter()],
  ["aider", new AiderAdapter()],
  [ARTIFICIAL_ANALYSIS_SOURCE_ID, new ArtificialAnalysisAdapter(
    () => getBenchmarkCredential(ARTIFICIAL_ANALYSIS_SOURCE_ID),
    () => hasBenchmarkCredential(ARTIFICIAL_ANALYSIS_SOURCE_ID)
  )],
]);

export const sourceSync = new SourceSyncCoordinator(adapters, new PostgresSourceSnapshotStore());
