import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCatalogSync } from "./catalog-sync-state";
import { accountConnection } from "./provider-state";

describe("owner catalog reconciliation", () => {
  test("simultaneous views share discovery, freshness is owner scoped, force refreshes", async () => {
    let calls = 0, clock = 100;
    let finish!: () => void;
    const sync = createCatalogSync(() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); }, () => clock);
    const first = sync("owner-a");
    assert.equal(sync("owner-a"), first);
    finish(); await first;
    await sync("owner-a"); assert.equal(calls, 1);
    const other = sync("owner-b"); assert.equal(calls, 2); finish(); await other;
    const forced = sync("owner-a", true); assert.equal(calls, 3); finish(); await forced;
    clock += 15_001;
    const stale = sync("owner-a"); assert.equal(calls, 4); finish(); await stale;
  });
  test("failed discovery is immediately retryable and requires an owner", async () => {
    let calls = 0;
    const sync = createCatalogSync(async () => { if (++calls === 1) throw new Error("offline"); });
    await assert.rejects(sync(""), /signed-in owner/);
    assert.equal(calls, 0);
    await assert.rejects(sync("owner"), /offline/);
    await sync("owner"); assert.equal(calls, 2);
  });
});

describe("provider connection evidence", () => {
  test("an engine placeholder does not mean a connected account", () => {
    assert.equal(accountConnection([]).setup, false);
    assert.equal(accountConnection([{ isMain: true, hasCredential: false, needsReauth: true }]).setup, false);
  });
  test("retains configured accounts that need attention without calling them connected", () => {
    assert.deepEqual(accountConnection([{ hasCredential: true, needsReauth: true }]), { setup: true, label: "Sign-in required" });
    assert.equal(accountConnection([{ hasCredential: true, paused: true }]).label, "Paused");
    assert.equal(accountConnection([{ hasCredential: true, needsReauth: true }, { hasCredential: true }]).label, "Connected");
  });
});
