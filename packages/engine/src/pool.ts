import { createHash } from "node:crypto";
import { join } from "node:path";
import { EngineProcess, type EngineConfig } from "./process";

export class EngineCapacityError extends Error {
  constructor() { super("All engine slots are busy"); }
}

type Slot = {
  engine: Promise<EngineProcess>;
  users: number;
  retiring: boolean;
  holds: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
};

/** Internal owner scope; callers must authenticate before selecting an owner. */
export class EnginePool {
  private slots = new Map<string, Slot>();
  private closing = false;

  constructor(private root: string, private maximum = 2, private idleMs = 60_000) {
    if (!Number.isInteger(maximum) || maximum < 1 || !Number.isFinite(idleMs) || idleMs < 1)
      throw new Error("Invalid engine capacity policy");
  }

  async run(owner: string, initial: EngineConfig, action: (engine: EngineProcess) => Promise<Response>): Promise<Response> {
    if (this.closing) throw new Error("Engine pool is stopping");
    if (!owner || owner.length > 1024) throw new Error("Invalid engine owner");
    const key = createHash("sha256").update(owner).digest("hex");
    let slot = this.slots.get(key);
    if (slot?.retiring) throw new EngineCapacityError();
    if (!slot) {
      if (this.slots.size >= this.maximum) {
        const idle = [...this.slots].find(([, candidate]) => candidate.users === 0 && !candidate.retiring && !this.hasHold(candidate));
        if (!idle) throw new EngineCapacityError();
        await this.retire(idle[0], idle[1]);
      }
      // Recheck after an asynchronous retirement: another request may have
      // acquired this owner or the released capacity while stop was pending.
      if (this.closing) throw new Error("Engine pool is stopping");
      slot = this.slots.get(key);
      if (slot?.retiring) throw new EngineCapacityError();
      if (!slot) {
        if (this.slots.size >= this.maximum) throw new EngineCapacityError();
        slot = { engine: EngineProcess.start(join(this.root, key), initial), users: 0, retiring: false, holds: new Map() };
        this.slots.set(key, slot);
      }
    }
    clearTimeout(slot.timer);
    slot.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot!.users--;
      if (slot!.users === 0 && !slot!.retiring) {
        slot!.timer = setTimeout(() => { void this.retire(key, slot!).catch(() => {}); }, this.idleMs);
        slot!.timer.unref?.();
      }
    };
    try {
      const engine = await slot.engine;
      const response = await action(engine);
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { controller.close(); reader.releaseLock(); release(); }
            else controller.enqueue(next.value);
          } catch (error) { controller.error(error); reader.releaseLock(); release(); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { reader.releaseLock(); release(); }
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      release();
      // A failed start has no reusable process. Keep request/provider errors
      // separate: those do not authorize restarting an otherwise live engine.
      if (await slot.engine.then(() => false, () => true)) {
        clearTimeout(slot.timer);
        if (this.slots.get(key) === slot) this.slots.delete(key);
      }
      throw error;
    }
  }

  private async retire(key: string, slot: Slot) {
    if (slot.retiring || slot.users !== 0) return;
    if (this.hasHold(slot)) {
      clearTimeout(slot.timer);
      slot.timer = setTimeout(() => { void this.retire(key, slot).catch(() => {}); },
        Math.max(1, Math.min(...slot.holds.values()) - Date.now()));
      slot.timer.unref?.();
      return;
    }
    slot.retiring = true;
    clearTimeout(slot.timer);
    await slot.engine.then(engine => engine.stop(), () => {});
    if (this.slots.get(key) === slot) this.slots.delete(key);
  }

  private hasHold(slot: Slot): boolean {
    for (const [operation, deadline] of slot.holds) if (deadline <= Date.now()) slot.holds.delete(operation);
    return slot.holds.size > 0;
  }

  /** Retain background login state between HTTP polls, without adding capacity. */
  hold(owner: string, operation: string, milliseconds = 16 * 60_000) {
    if (!operation || operation.length > 1024 || milliseconds < 1 || milliseconds > 20 * 60_000)
      throw new Error("Invalid engine operation lease");
    const key = createHash("sha256").update(owner).digest("hex");
    const slot = this.slots.get(key);
    if (!slot || slot.retiring) throw new Error("Engine operation has no active process");
    slot.holds.set(operation, Date.now() + milliseconds);
  }

  releaseHold(owner: string, operation: string) {
    const slot = this.slots.get(createHash("sha256").update(owner).digest("hex"));
    slot?.holds.delete(operation);
  }

  async stop() {
    this.closing = true;
    await Promise.all([...this.slots.values()].map(async slot => {
      slot.retiring = true;
      clearTimeout(slot.timer);
      await slot.engine.then(engine => engine.stop(), () => {});
    }));
    this.slots.clear();
  }
}
