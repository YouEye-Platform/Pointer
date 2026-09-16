import { db, schema } from "../db";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { registry } from "../providers/registry";
import { scheduleCanonicalCatalogSync } from "./catalog-sync";
import { stageProviderInventorySnapshot } from "./catalog-reconciliation";
import { resolveDiscoveredModelCapabilities } from "./model-capabilities";
import {
  fetchProviderModels,
  resolveProviderModelCatalogIdentity,
  resolveProviderModelDiscoveryUrl,
} from "../providers/model-discovery";

// Sync models for a single provider by ID
export async function syncProviderModels(providerId: string, userId?: string, accountId?: string): Promise<number> {
  const resolved = userId && accountId
    ? await registry.getProviderForAccount(providerId, accountId, userId)
    : registry.getProvider(providerId);
  if (!resolved) return 0;
  const synced = await syncSingleProvider(resolved, userId, accountId);
  if (synced > 0) await scheduleCanonicalCatalogSync();
  return synced;
}

// Internal: sync models for a single resolved provider
async function syncSingleProvider(resolved: { manifest: any; handler: any; dbRecord: any }, userId?: string, accountId?: string): Promise<number> {
  const { manifest, handler, dbRecord } = resolved;
  let synced = 0;
  let inventoryComplete = true;
  const observedModelIds = new Set<string>();

  try {
    // Get an API key (use dbRecord.id for multi-instance support)
    const keyConditions = [eq(schema.providerKeys.providerId, dbRecord.id)];
    if (userId) keyConditions.push(eq(schema.providerKeys.userId, userId));
    if (accountId) keyConditions.push(eq(schema.providerKeys.providerAccountId, accountId));
    const [anyKey] = await db
      .select()
      .from(schema.providerKeys)
      .where(and(...keyConditions))
      .limit(1);

    if (!anyKey) {
      console.log(`[sync] Skipping ${dbRecord.id}: no API key available`);
      return 0;
    }

    const apiKey = await registry.getProviderApiKey(dbRecord.id, anyKey.userId, accountId);
    if (!apiKey) {
      console.log(`[sync] Skipping ${dbRecord.id}: credential is unavailable or expired`);
      return 0;
    }
    const oauthCredential = await registry.getProviderOAuthCredential(
      dbRecord.id,
      anyKey.userId,
      accountId
    );

    // 1. Try API-based discovery first
    if (manifest.models?.discovery?.enabled || manifest.endpoints?.models) {
      let models: any[] = [];

      if (handler?.fetchModels) {
        models = await handler.fetchModels(
          manifest,
          apiKey,
          oauthCredential ?? undefined
        );
      } else {
        models = await fetchProviderModels(manifest, apiKey);
        if (handler?.transformModelList) {
          models = handler.transformModelList(models, manifest);
        }
      }

      if (models.length > 0) {
        console.log(`[sync] ${dbRecord.id}: found ${models.length} models via discovery`);
        for (const model of models) {
          const modelId = discoveredModelId(model, manifest);
          if (modelId) observedModelIds.add(modelId);
          synced += await upsertModel(model, manifest, dbRecord);
        }
      } else if (manifest.models?.discovery?.enabled || manifest.endpoints?.models) {
        console.log(`[sync] ${dbRecord.id}: discovery returned 0 models`);
        inventoryComplete = false;
      }
    }

    // 2. Process any manifest-declared static fallback models.
    if (manifest.models?.static?.length > 0) {
      console.log(`[sync] ${dbRecord.id}: inserting ${manifest.models.static.length} static models`);
      for (const staticModel of manifest.models.static) {
        const model = {
          id: staticModel.id,
          name: staticModel.name || staticModel.id,
          description: staticModel.description || null,
          context_length: staticModel.contextWindow,
          maxOutput: staticModel.maxOutput,
          supportsTools: staticModel.supportsTools ?? false,
          supportsVision: staticModel.supportsVision ?? false,
          supportsStreaming: staticModel.supportsStreaming ?? true,
          supportedGenerationMethods: staticModel.supportedGenerationMethods,
          nativeFormat: staticModel.nativeFormat,
          nativeEndpoint: staticModel.nativeEndpoint,
          inputPrice: staticModel.inputPrice,
          outputPrice: staticModel.outputPrice,
        };
        observedModelIds.add(staticModel.id);
        synced += await upsertModel(model, { ...manifest, models: { discovery: null } }, dbRecord);
      }
    }

    if (synced > 0 && inventoryComplete) {
      const rows = await db.select().from(schema.providerModels).where(eq(schema.providerModels.providerId, dbRecord.id));
      const observedRows = rows.filter((row) => observedModelIds.has(row.providerModelId) || observedModelIds.has(row.modelId));
      if (observedRows.length !== observedModelIds.size) throw new Error(`Provider inventory ${dbRecord.id} was only partially persisted`);

      if (accountId) {
        await db.transaction(async (tx) => {
          await tx.delete(schema.providerAccountModels)
            .where(eq(schema.providerAccountModels.providerAccountId, accountId));
          if (observedRows.length > 0) {
            await tx.insert(schema.providerAccountModels).values(observedRows.map((row) => ({
              id: `pam_${nanoid(16)}`,
              providerAccountId: accountId,
              providerModelId: row.id,
            }))).onConflictDoNothing();
          }
        });
      }

      const unionRows = accountId
        ? await db.select({ providerModelId: schema.providerAccountModels.providerModelId })
          .from(schema.providerAccountModels)
          .innerJoin(schema.providerAccounts, eq(schema.providerAccounts.id, schema.providerAccountModels.providerAccountId))
          .innerJoin(schema.providerModels, eq(schema.providerModels.id, schema.providerAccountModels.providerModelId))
          .where(and(
            eq(schema.providerAccounts.status, "active"),
            eq(schema.providerModels.providerId, dbRecord.id),
          ))
        : observedRows.map((row) => ({ providerModelId: row.id }));
      const unionIds = new Set(unionRows.map((row) => row.providerModelId));
      const inventoryRows = accountId ? rows.filter((row) => unionIds.has(row.id)) : observedRows;
      const inventory = inventoryRows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        providerName: dbRecord.name,
        rawModelId: row.providerModelId,
        catalogIdentity: resolveProviderModelCatalogIdentity(
          row.rawMetadata,
          manifest
        ),
        displayName: row.displayName,
        existingModelId: row.modelId,
        inputPrice: row.inputPrice,
        outputPrice: row.outputPrice,
        contextWindow: row.contextWindow,
        maxOutput: row.maxOutput,
        supportsTools: row.supportsTools ?? false,
        supportsVision: row.supportsVision ?? false,
        supportsStreaming: row.supportsStreaming ?? false,
      }));
      await stageProviderInventorySnapshot({
        providerId: dbRecord.id,
        providerName: dbRecord.name,
        sourceUrl: resolveProviderModelDiscoveryUrl(manifest).toString(),
        records: inventory,
      });
    }

    // Update provider status
    if (synced > 0) {
      await db
        .update(schema.providers)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(schema.providers.id, dbRecord.id));
    } else if (!inventoryComplete) {
      await db
        .update(schema.providers)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(schema.providers.id, dbRecord.id));
    }
  } catch (err) {
    console.error(`[sync] Error syncing ${dbRecord.id}:`, err);
    synced = 0;
    await db
      .update(schema.providers)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(schema.providers.id, dbRecord.id));
  }

  return synced;
}

function discoveredModelId(model: any, manifest: any): string | null {
  const field = manifest.models?.discovery?.idField;
  const value = field ? model[field] : model.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function discoveredModelName(model: any, manifest: any, modelId: string): string {
  const field = manifest.models?.discovery?.nameField;
  const value = field ? model[field] : model.name;
  return typeof value === "string" && value.trim() ? value.trim() : modelId;
}

// Upsert a single model into catalog + provider_models
async function upsertModel(model: any, manifest: any, dbRecord: any): Promise<number> {
  const discovery = manifest.models?.discovery;
  const modelId = discoveredModelId(model, manifest);

  if (!modelId) return 0;
  const modelName = discoveredModelName(model, manifest, modelId);

  // Extract pricing
  let inputPrice: number | null = null;
  let outputPrice: number | null = null;
  let inputPriceObserved = false;
  let outputPriceObserved = false;

  const normalizePrice = (value: unknown, multiplier = 1): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * multiplier : null;
  };

  if (discovery?.pricingPath) {
    const pricing = discovery.pricingPath.split(".").reduce((obj: any, key: string) => obj?.[key], model);
    if (pricing) {
      const rawInput = discovery.inputPriceField ? pricing[discovery.inputPriceField] : pricing.input;
      const rawOutput = discovery.outputPriceField ? pricing[discovery.outputPriceField] : pricing.output;
      const multiplier = discovery.pricePerMillion ? 1 : 1_000_000;
      inputPriceObserved = rawInput != null;
      outputPriceObserved = rawOutput != null;
      inputPrice = inputPriceObserved ? normalizePrice(rawInput, multiplier) : null;
      outputPrice = outputPriceObserved ? normalizePrice(rawOutput, multiplier) : null;
    }
  } else if (model.inputPrice !== undefined) {
    inputPriceObserved = true;
    outputPriceObserved = model.outputPrice !== undefined;
    inputPrice = normalizePrice(model.inputPrice);
    outputPrice = outputPriceObserved ? normalizePrice(model.outputPrice) : null;
  }

  const {
    supportsTools,
    supportsVision,
    supportsStreaming,
  } = resolveDiscoveredModelCapabilities(model, manifest, modelId);

  const contextWindow = discovery?.contextField
    ? discovery.contextField.split(".").reduce((obj: any, key: string) => obj?.[key], model)
    : model.contextWindow || model.context_length;
  const nativeFormat = [
    "chat-completions",
    "messages",
    "responses",
    "google-generate-content",
  ].includes(
    model.nativeFormat
  )
    ? model.nativeFormat
    : null;
  const nativeEndpoint =
    typeof model.nativeEndpoint === "string"
    && model.nativeEndpoint.startsWith("/")
    && !model.nativeEndpoint.startsWith("//")
      ? model.nativeEndpoint
      : null;

  // Upsert into model catalog
  const existing = await db
    .select()
    .from(schema.modelCatalog)
    .where(eq(schema.modelCatalog.modelId, modelId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(schema.modelCatalog).values({
      modelId,
      name: modelName,
      description: model.description || null,
      contextWindow: contextWindow || null,
      maxOutput: model.top_provider?.max_completion_tokens || model.maxOutput || null,
      supportsTools,
      supportsVision,
      supportsStreaming,
    });
  } else {
    // Update capabilities if discovered (don't downgrade true→false)
    const updates: any = {};
    if (supportsTools && !existing[0].supportsTools) updates.supportsTools = true;
    if (supportsVision && !existing[0].supportsVision) updates.supportsVision = true;
    if (Object.keys(updates).length > 0) {
      await db.update(schema.modelCatalog).set(updates).where(eq(schema.modelCatalog.modelId, modelId));
    }
  }

  // Upsert provider model mapping (use dbRecord.id for multi-instance)
  const existingMapping = await db
    .select()
    .from(schema.providerModels)
    .where(and(eq(schema.providerModels.providerId, dbRecord.id), eq(schema.providerModels.modelId, modelId)))
    .limit(1);

  if (existingMapping.length === 0) {
    await db.insert(schema.providerModels).values({
      id: nanoid(),
      providerId: dbRecord.id,
      modelId,
      displayName: modelName,
      providerModelId: modelId,
      inputPrice: inputPrice?.toString() || null,
      outputPrice: outputPrice?.toString() || null,
      contextWindow: contextWindow || null,
      maxOutput: model.top_provider?.max_completion_tokens || model.maxOutput || null,
      supportsStreaming,
      supportsTools,
      supportsVision,
      nativeFormat,
      nativeEndpoint,
      priceSource: inputPrice !== null || outputPrice !== null ? "provider" : null,
      priceFetchedAt: inputPrice !== null || outputPrice !== null ? new Date() : null,
      rawMetadata: model,
    });
  } else {
    // Update pricing + capabilities (don't downgrade tools true→false)
    const pmUpdates: any = {
      displayName: modelName,
      inputPrice: inputPriceObserved ? inputPrice?.toString() ?? null : existingMapping[0].inputPrice,
      outputPrice: outputPriceObserved ? outputPrice?.toString() ?? null : existingMapping[0].outputPrice,
      contextWindow: contextWindow ?? existingMapping[0].contextWindow,
      maxOutput: model.top_provider?.max_completion_tokens ?? model.maxOutput ?? existingMapping[0].maxOutput,
      priceSource: inputPriceObserved || outputPriceObserved ? (inputPrice !== null || outputPrice !== null ? "provider" : null) : existingMapping[0].priceSource,
      priceFetchedAt: inputPriceObserved || outputPriceObserved ? new Date() : existingMapping[0].priceFetchedAt,
      rawMetadata: model,
      nativeFormat: nativeFormat ?? existingMapping[0].nativeFormat,
      nativeEndpoint: nativeEndpoint ?? existingMapping[0].nativeEndpoint,
    };
    if (supportsTools && !existingMapping[0].supportsTools) pmUpdates.supportsTools = true;
    if (supportsVision && !existingMapping[0].supportsVision) pmUpdates.supportsVision = true;
    await db
      .update(schema.providerModels)
      .set(pmUpdates)
      .where(eq(schema.providerModels.id, existingMapping[0].id));
  }

  return 1;
}

// Sync models from all providers that support model discovery or have static models
export async function syncModelCatalog(): Promise<number> {
  let totalSynced = 0;
  const providers = registry.getAllProviders();

  for (const resolved of providers) {
    const { manifest } = resolved;
    // Skip if no discovery AND no static models AND no models endpoint
    if (!manifest.models?.discovery?.enabled && !manifest.endpoints?.models && !manifest.models?.static?.length) {
      continue;
    }
    totalSynced += await syncSingleProvider(resolved);
  }

  console.log(`[sync] Total synced: ${totalSynced} models`);
  if (totalSynced > 0) await scheduleCanonicalCatalogSync();
  return totalSynced;
}
