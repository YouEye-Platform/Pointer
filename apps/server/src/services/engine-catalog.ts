import { createHash } from "node:crypto";
import { modelLabel } from "@pointer/contracts/model-label";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db";
import { enginePool, initialEngineConfig } from "./engine";
import { stageProviderInventorySnapshot, reconcileCatalog } from "./catalog-reconciliation";
import { invalidateModelResolutionCache } from "./model-resolution";
import { sourceSync } from "./source-sync";
import { engineModelMetadata } from "./engine-model-metadata";

const providerSchema = z.object({
  name: z.string().min(1), adapter: z.string(), baseUrl: z.string(),
  disabled: z.boolean().optional(),
});
const modelSchema = z.object({
  provider: z.string(), id: z.string().min(1), namespaced: z.string().min(1),
  displayName: z.string().optional(), disabled: z.boolean().optional(),
  displayNameSource: z.string().optional(),
  native: z.boolean().optional(), initialSelectionPending: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.string()).optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  reasoningEfforts: z.array(z.string()).optional(),
});
const identity = (prefix: string, ...parts: string[]) =>
  prefix + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** Project non-secret engine inventory into Pointer's catalog and account scopes. */
export async function syncEngineCatalog(owner: string, includeReference = true) {
  // Hold one engine lease while gathering both projections, including response
  // consumption. Invalid or failed discovery never erases the previous inventory.
  const inventory = await enginePool.run(owner, initialEngineConfig, async engine => {
    const providers = await engine.providers();
    if (!providers.ok) { await providers.body?.cancel(); throw new Error("Provider discovery failed"); }
    const providerRows = z.array(providerSchema).parse(await providers.json());
    const readModels = async () => {
      const models = await engine.management("/api/models");
      if (!models.ok) { await models.body?.cancel(); throw new Error("Model discovery failed"); }
      return z.array(modelSchema).parse(await models.json());
    };
    let modelRows = await readModels();
    // Pointer groups alone decide which routes an app can use. The private
    // engine's discovery visibility must not introduce a second selection gate.
    let changed = false;
    for (const provider of providerRows.filter(row => !row.disabled)) {
      const rows = modelRows.filter(row => row.provider === provider.name);
      if (!rows.some(row => row.disabled) || rows.some(row => row.initialSelectionPending)) continue;
      const result = await engine.management("/api/model-visibility", { method: "PUT",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "provider", provider: provider.name,
          enabled: true, targets: rows.map(row => ({ id: row.id, native: row.native === true })) }) });
      await result.body?.cancel();
      if (!result.ok) throw new Error("Model availability could not be synchronized");
      changed = true;
    }
    if (changed) modelRows = await readModels();
    return Response.json({ providers: providerRows, models: modelRows });
  });
  const discovered = await inventory.json() as {
    providers: z.infer<typeof providerSchema>[]; models: z.infer<typeof modelSchema>[];
  };
  let count = 0;
  for (const provider of discovered.providers) {
    // Custom endpoints with the same short name can represent different owners'
    // inventories. Keep their binding identities independent and stable.
    // An explicitly migrated binding retains its product UUIDs and route
    // references. New providers continue to receive owner-scoped identities.
    const [bound] = await db.select().from(schema.providerAccounts).where(and(
      eq(schema.providerAccounts.userId, owner), eq(schema.providerAccounts.engineProvider, provider.name),
    )).limit(1);
    const providerId = bound?.providerId ?? identity("ep_", owner, provider.name);
    const accountId = bound?.id ?? identity("pa_", owner, provider.name);
    const models = discovered.models.filter(row => row.provider === provider.name && !row.disabled);
    const records = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"engine-catalog:" + owner}))`);
      if (!bound) await tx.insert(schema.providers).values({
        id: providerId, name: provider.name, type: "openai-compatible", baseUrl: provider.baseUrl,
        status: provider.disabled ? "disabled" : "active", isBuiltin: false,
      }).onConflictDoUpdate({ target: schema.providers.id, set: {
        baseUrl: provider.baseUrl, status: provider.disabled ? "disabled" : "active", updatedAt: new Date(),
      } });
      await tx.insert(schema.providerAccounts).values({
        id: accountId, userId: owner, providerId, engineProvider: provider.name,
        baseUrl: provider.baseUrl, status: provider.disabled ? "disabled" : "active",
      }).onConflictDoUpdate({ target: schema.providerAccounts.id, set: { baseUrl: provider.baseUrl, updatedAt: new Date() } });
      await tx.update(schema.providerAccounts).set({ status: provider.disabled ? "disabled" : "active", updatedAt: new Date() })
        .where(eq(schema.providerAccounts.id, accountId));
      const previousModels = await tx.select({ model: schema.providerModels })
        .from(schema.providerModels).where(eq(schema.providerModels.providerId, providerId));
      // Replace availability only after a successful complete engine discovery.
      // Keep provider model identities so saved groups survive disappearance.
      await tx.delete(schema.providerAccountModels).where(eq(schema.providerAccountModels.providerAccountId, accountId));
      const records = [];
      for (const model of models) {
        const retained = previousModels.find(row => row.model.providerModelId === model.id)?.model;
        const id = retained?.id ?? identity("pm_", providerId, model.namespaced);
        const values = {
          id, providerId, modelId: retained?.modelId ?? model.namespaced, providerModelId: model.id,
          displayName: modelLabel(model), contextWindow: model.contextWindow ?? null,
          maxOutput: model.maxOutputTokens ?? null, supportsVision: model.inputModalities?.includes("image") ?? false,
          supportsTools: model.supportsTools ?? null,
          rawMetadata: engineModelMetadata(model),
        };
        await tx.insert(schema.providerModels).values(values)
          .onConflictDoUpdate({ target: schema.providerModels.id, set: values });
        await tx.insert(schema.providerAccountModels).values({
          id: identity("pam_", accountId, id), providerAccountId: accountId, providerModelId: id,
          discoveredAt: new Date(), rawMetadata: values.rawMetadata,
        }).onConflictDoUpdate({ target: schema.providerAccountModels.id, set: { discoveredAt: new Date(), rawMetadata: values.rawMetadata } });
        records.push({ ...values, providerName: provider.name, rawModelId: model.id, engineInventory: true,
          // Presentation fallback must not become invented provider identity evidence.
          displayName: model.displayNameSource === "fallback" ? model.id : model.displayName ?? model.id,
          existingModelId: values.modelId, inputPrice: null, outputPrice: null,
          supportsTools: model.supportsTools ?? false, supportsStreaming: true,
        });
      }
      return records;
    });
    if (records.length) {
      await stageProviderInventorySnapshot({ providerId, providerName: provider.name, sourceUrl: provider.baseUrl, records });
      count += records.length;
    }
  }
  // A removed connection must immediately cease to be selectable/routable.
  const names = new Set(discovered.providers.map(row => row.name));
  const prior = await db.select().from(schema.providerAccounts).where(and(
    eq(schema.providerAccounts.userId, owner), isNotNull(schema.providerAccounts.engineProvider),
  ));
  for (const account of prior) if (!names.has(account.engineProvider!))
    await db.update(schema.providerAccounts).set({ status: "disabled", updatedAt: new Date() })
      .where(eq(schema.providerAccounts.id, account.id));
  let catalogWarning: string | undefined;
  if (includeReference) {
    // Reference metadata and benchmark evidence are one catalog, including on
    // installations that deliberately turn periodic background jobs off.
    const states = await sourceSync.states();
    const failures: string[] = [];
    for (const state of states) {
      const attempted = state.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : 0;
      if ((state.stale || state.status === "never_synced") && Date.now() - attempted > 15 * 60_000) {
        try { await sourceSync.refresh(state.sourceId); }
        catch { failures.push(state.sourceId); }
      }
    }
    if (failures.length) catalogWarning = `Connected models refreshed. Catalog sources unavailable: ${failures.join(", ")}. Previously saved evidence is retained.`;
  }
  if (count || includeReference) await reconcileCatalog();
  invalidateModelResolutionCache();
  return { connections: discovered.providers.length, models: count, ...(catalogWarning ? { catalogWarning } : {}) };
}
