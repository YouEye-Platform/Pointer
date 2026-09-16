import { describe, expect, test } from "bun:test";
import { SourceFetchError, type SourceAdapter, type SourceSnapshot } from "./sources/types";

process.env.DATABASE_URL ||= "postgresql://pointer:pointer@127.0.0.1:5432/pointer_test";

class FakeStore {
  readonly snapshots = new Map<string, SourceSnapshot<any>>();
  readonly states = new Map<string, any>();

  async markAttempt(sourceId: string, at: Date) {
    this.states.set(sourceId, { ...this.states.get(sourceId), sourceId, status: "syncing", lastAttemptAt: at });
  }

  async markDisabled(sourceId: string, at: Date) {
    this.states.set(sourceId, {
      ...this.states.get(sourceId),
      sourceId,
      status: "disabled",
      updatedAt: at,
      errorCode: null,
      errorMessage: null,
    });
  }

  async replace(snapshot: SourceSnapshot<any>, at: Date) {
    this.snapshots.set(snapshot.sourceId, snapshot);
    this.states.set(snapshot.sourceId, {
      ...this.states.get(snapshot.sourceId),
      sourceId: snapshot.sourceId,
      status: "ok",
      lastSuccessAt: at,
      fetchedAt: new Date(snapshot.provenance.fetchedAt),
      recordCount: snapshot.records.length,
      errorCode: null,
      errorMessage: null,
    });
  }

  async markFailure(sourceId: string, at: Date, error: SourceFetchError) {
    this.states.set(sourceId, {
      ...this.states.get(sourceId),
      sourceId,
      status: "error",
      lastAttemptAt: at,
      errorCode: error.code,
      errorMessage: error.message,
      recordCount: this.snapshots.get(sourceId)?.records.length ?? 0,
    });
  }

  async listStates() {
    return [...this.states.values()];
  }
}

const snapshot = (sourceId: string, records = [{ id: "model-a" }]): SourceSnapshot<any> => ({
  sourceId,
  records,
  provenance: { source: sourceId, sourceUrl: `https://example.test/${sourceId}`, license: "test", fetchedAt: "2026-07-10T00:00:00.000Z" },
});

const adapter = (id: string, fetcher: () => Promise<SourceSnapshot<any>>): SourceAdapter<any> => ({
  id,
  sourceUrl: `https://example.test/${id}`,
  license: "test",
  timeoutMs: 100,
  maxBytes: 1000,
  fetch: fetcher,
});

describe("SourceSyncCoordinator", () => {
  test("a failed refresh preserves the source's last-known-good snapshot", async () => {
    const { SourceSyncCoordinator } = await import("./source-sync");
    const store = new FakeStore();
    let fail = false;
    const source = adapter("source-a", async () => {
      if (fail) throw new SourceFetchError("temporary failure", "upstream", 503);
      return snapshot("source-a");
    });
    const coordinator = new SourceSyncCoordinator(new Map([[source.id, source]]), store as any, () => new Date("2026-07-10T01:00:00Z"));

    await coordinator.refresh("source-a");
    fail = true;
    await expect(coordinator.refresh("source-a")).rejects.toMatchObject({ code: "upstream" });
    expect(store.snapshots.get("source-a")?.records).toEqual([{ id: "model-a" }]);
    const [state] = await coordinator.states();
    expect(state.status).toBe("error");
    expect(state.recordCount).toBe(1);
    expect(state.error?.code).toBe("upstream");
  });

  test("empty, malformed, oversized, and timed-out refreshes all preserve last-known-good data", async () => {
    const { SourceSyncCoordinator } = await import("./source-sync");
    for (const code of ["empty", "malformed", "oversized", "timeout"] as const) {
      const store = new FakeStore();
      let failure: SourceFetchError | null = null;
      const source = adapter(`source-${code}`, async () => {
        if (failure) throw failure;
        return snapshot(`source-${code}`, [{ id: "last-known-good" }]);
      });
      const coordinator = new SourceSyncCoordinator(new Map([[source.id, source]]), store as any);
      await coordinator.refresh(source.id);
      failure = new SourceFetchError(`${code} failure`, code);
      await expect(coordinator.refresh(source.id)).rejects.toMatchObject({ code });
      expect(store.snapshots.get(source.id)?.records).toEqual([{ id: "last-known-good" }]);
      expect((await coordinator.states())[0]).toMatchObject({ status: "error", recordCount: 1, error: { code } });
    }
  });

  test("overlapping refresh calls share one in-flight operation", async () => {
    const { SourceSyncCoordinator } = await import("./source-sync");
    const store = new FakeStore();
    let release!: () => void;
    let calls = 0;
    const source = adapter("source-a", () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(snapshot("source-a")); });
    });
    const coordinator = new SourceSyncCoordinator(new Map([[source.id, source]]), store as any);
    const first = coordinator.refresh("source-a");
    const second = coordinator.refresh("source-a");
    expect(second).toBe(first);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("one source failure does not prevent another source from committing", async () => {
    const { SourceSyncCoordinator } = await import("./source-sync");
    const store = new FakeStore();
    const good = adapter("good", async () => snapshot("good"));
    const bad = adapter("bad", async () => { throw new SourceFetchError("bad source", "malformed"); });
    const coordinator = new SourceSyncCoordinator(new Map([[good.id, good], [bad.id, bad]]), store as any);
    const results = await coordinator.refreshAll();
    expect(results.find((item) => item.sourceId === "good")?.result.status).toBe("fulfilled");
    expect(results.find((item) => item.sourceId === "bad")?.result.status).toBe("rejected");
    expect(store.snapshots.has("good")).toBe(true);
    expect(store.snapshots.has("bad")).toBe(false);
  });

  test("an unconfigured optional source is disabled without an error or upstream request", async () => {
    const { SourceSyncCoordinator } = await import("./source-sync");
    const store = new FakeStore();
    let calls = 0;
    const source = {
      ...adapter("optional", async () => {
        calls += 1;
        return snapshot("optional");
      }),
      enabled: async () => false,
    };
    const coordinator = new SourceSyncCoordinator(new Map([[source.id, source]]), store as any);
    await expect(coordinator.refresh(source.id)).resolves.toBeNull();
    expect(calls).toBe(0);
    expect((await coordinator.states())[0]).toMatchObject({ status: "disabled", stale: false, error: null });
  });
});
