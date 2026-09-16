import { db, schema } from "../db";
import { eq, and, asc, inArray, isNotNull } from "drizzle-orm";
import { isModelAllowed, type ApiKeyContext } from "../middleware/api-key";
import {
  POSITIONAL_MODEL_ALIASES,
  RESERVED_MODEL_ALIASES,
  normalizeManualModelAlias,
  normalizeModelLookupKey,
} from "./model-aliases";

export type ModelEntry = {
  displayName: string;
  modelId: string;
  providerId: string;
  providerAccountId: string | null;
  providerModelId: string;
  catalogEntityId: string | null;
  nativeFormat: "chat-completions" | "messages" | "responses" | "google-generate-content" | null;
  nativeEndpoint: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  providerMethods: string[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
  };
};

type CatalogRow = {
  name: string;
  contextWindow: number | null;
  maxOutput: number | null;
  isReasoning: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
};

export type ProviderModelLookupRow = {
  id?: string;
  providerId: string;
  modelId: string;
  providerModelId: string;
  canonicalModelId: string | null;
  catalogEntityId: string | null;
  inputPrice: string | null;
  outputPrice: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  supportsStreaming: boolean | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  nativeFormat?: string | null;
  nativeEndpoint?: string | null;
  rawMetadata?: unknown;
};

function providerMethods(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const methods = (value as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
  return Array.isArray(methods)
    ? methods.filter((method): method is string => typeof method === "string")
    : [];
}

export function buildProviderModelLookup(rows: ProviderModelLookupRow[]) {
  const byModelId = new Map<string, ProviderModelLookupRow>();
  const byProviderModelId = new Map<string, ProviderModelLookupRow>();
  const byCanonicalId = new Map<string, ProviderModelLookupRow>();
  const byCatalogEntityId = new Map<string, ProviderModelLookupRow>();
  const byRecordId = new Map<string, ProviderModelLookupRow>();
  const byBaseName = new Map<string, ProviderModelLookupRow>();

  for (const row of rows) {
    const modelId = row.modelId.toLowerCase();
    const providerModelId = row.providerModelId.toLowerCase();
    if (row.id) byRecordId.set(`${row.providerId}:${row.id.toLowerCase()}`, row);
    byModelId.set(`${row.providerId}:${modelId}`, row);
    byProviderModelId.set(`${row.providerId}:${providerModelId}`, row);
    if (row.canonicalModelId) {
      byCanonicalId.set(`${row.providerId}:${row.canonicalModelId.toLowerCase()}`, row);
    }
    if (row.catalogEntityId) {
      byCatalogEntityId.set(`${row.providerId}:${row.catalogEntityId.toLowerCase()}`, row);
    }
    const slash = modelId.indexOf("/");
    if (slash > 0) byBaseName.set(`${row.providerId}:${modelId.slice(slash + 1)}`, row);
  }

  return (providerId: string, requestedModelId: string): ProviderModelLookupRow | null => {
    const modelId = requestedModelId.toLowerCase();
    let row = byModelId.get(`${providerId}:${modelId}`);
    if (row) return row;
    const slash = modelId.indexOf("/");
    if (slash > 0) {
      const base = modelId.slice(slash + 1);
      row = byModelId.get(`${providerId}:${base}`) ?? byBaseName.get(`${providerId}:${base}`);
      if (row) return row;
    }
    return byProviderModelId.get(`${providerId}:${modelId}`)
      ?? byCanonicalId.get(`${providerId}:${modelId}`)
      ?? byCatalogEntityId.get(`${providerId}:${modelId}`)
      ?? byRecordId.get(`${providerId}:${modelId}`)
      ?? null;
  };
}

// ── Lookup Caches ─────────────────────────────────────────────

export type InstanceModelIndex = {
  advertisedModels: ModelEntry[];
  routesByName: Map<string, ModelEntry>;
};

const instanceLookupCache = new Map<string, { index: InstanceModelIndex; builtAt: number }>();

export function invalidateModelResolutionCache(instanceId?: string) {
  if (instanceId) instanceLookupCache.delete(instanceId);
  else instanceLookupCache.clear();
}
const LOOKUP_TTL_MS = 60_000; // 1 minute

function normalizeNativeFormat(
  value: string | null | undefined
): ModelEntry["nativeFormat"] {
  return value === "chat-completions"
    || value === "messages"
    || value === "responses"
    || value === "google-generate-content"
    ? value
    : null;
}

let catalogCache: { data: Map<string, CatalogRow>; builtAt: number } | null = null;
const CATALOG_TTL_MS = 5 * 60_000; // 5 minutes

// ── Display Name Helpers ──────────────────────────────────────

const COMMON_PREFIXES = [
  "anthropic", "openai", "google", "meta-llama", "mistralai",
  "deepseek", "qwen", "x-ai", "z-ai", "moonshotai",
];

function stripCreatorPrefix(name: string): string {
  const colonIdx = name.indexOf(": ");
  if (colonIdx > 0 && colonIdx < 30) return name.slice(colonIdx + 2);
  return name;
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function resolveDisplayName(modelId: string, catalog: Map<string, CatalogRow>): string {
  // 1. Exact match in catalog
  const entry = catalog.get(modelId);
  if (entry && entry.name !== modelId) return stripCreatorPrefix(entry.name);

  // 2. Try with common provider prefixes for unprefixed IDs
  for (const prefix of COMMON_PREFIXES) {
    const prefixed = `${prefix}/${modelId}`;
    const prefixedEntry = catalog.get(prefixed);
    if (prefixedEntry && prefixedEntry.name !== prefixed) return stripCreatorPrefix(prefixedEntry.name);
  }

  // 3. Fallback: title-case the model ID (strip leading provider prefix first)
  const slashIdx = modelId.indexOf("/");
  const base = slashIdx > 0 ? modelId.slice(slashIdx + 1) : modelId;
  return titleCase(base);
}

export type ModelIndexInput = {
  displayName: string;
  modelId: string;
  providerId: string;
  providerAccountId?: string | null;
  entry: ModelEntry;
};

function modelRouteIdentity(modelId: string, providerId: string, providerAccountId?: string | null): string {
  return `${providerId}\u0000${providerAccountId ?? ""}\u0000${modelId}`;
}

function uniqueAdvertisedName(
  input: ModelIndexInput,
  usedNames: Set<string>,
): string {
  const base = normalizeManualModelAlias(input.displayName) || input.modelId;
  const baseKey = normalizeModelLookupKey(base);
  if (RESERVED_MODEL_ALIASES.has(baseKey)) {
    throw new Error(`Public model name is reserved for positional routing: ${base}`);
  }
  if (usedNames.has(baseKey)) {
    throw new Error(`Duplicate public model name: ${base}`);
  }
  return base;
}

export function buildModelIndex(
  advertisedInputs: ModelIndexInput[],
  roleCandidates: Array<Pick<ModelIndexInput, "modelId" | "providerId" | "providerAccountId">>,
): InstanceModelIndex {
  const advertisedModels: ModelEntry[] = [];
  const routesByName = new Map<string, ModelEntry>();
  const advertisedByIdentity = new Map<string, ModelEntry>();
  const usedNames = new Set<string>();

  for (const input of advertisedInputs) {
    const displayName = uniqueAdvertisedName(input, usedNames);
    const key = normalizeModelLookupKey(displayName);
    const entry = { ...input.entry, displayName };
    usedNames.add(key);
    routesByName.set(key, entry);
    advertisedModels.push(entry);
    advertisedByIdentity.set(modelRouteIdentity(input.modelId, input.providerId, input.providerAccountId), entry);
  }

  for (const [slot, aliases] of POSITIONAL_MODEL_ALIASES.entries()) {
    const candidate = roleCandidates[slot];
    if (!candidate) continue;
    const entry = advertisedByIdentity.get(modelRouteIdentity(candidate.modelId, candidate.providerId, candidate.providerAccountId));
    if (!entry) continue;
    for (const alias of aliases) routesByName.set(alias, entry);
  }

  return { advertisedModels, routesByName };
}

async function getCatalogCache(): Promise<Map<string, CatalogRow>> {
  if (catalogCache && Date.now() - catalogCache.builtAt < CATALOG_TTL_MS) {
    return catalogCache.data;
  }

  const rows = await db
    .select({
      modelId: schema.modelCatalog.modelId,
      name: schema.modelCatalog.name,
      contextWindow: schema.modelCatalog.contextWindow,
      maxOutput: schema.modelCatalog.maxOutput,
      isReasoning: schema.modelCatalog.isReasoning,
      supportsVision: schema.modelCatalog.supportsVision,
      supportsTools: schema.modelCatalog.supportsTools,
      supportsStreaming: schema.modelCatalog.supportsStreaming,
    })
    .from(schema.modelCatalog);

  const map = new Map<string, CatalogRow>();
  for (const r of rows) {
    map.set(r.modelId, {
      name: r.name,
      contextWindow: r.contextWindow,
      maxOutput: r.maxOutput,
      isReasoning: r.isReasoning ?? false,
      supportsVision: r.supportsVision ?? false,
      supportsTools: r.supportsTools ?? false,
      supportsStreaming: r.supportsStreaming ?? true,
    });
  }

  catalogCache = { data: map, builtAt: Date.now() };
  return map;
}

// ── Instance Lookup Builder ───────────────────────────────────

export async function buildInstanceModelIndex(instanceId: string): Promise<InstanceModelIndex> {
  const catalog = await getCatalogCache();

  // 1. Get instance's model group
  const [inst] = await db
    .select({
      modelGroupId: schema.instances.modelGroupId,
      origin: schema.instances.origin,
      state: schema.instances.state,
    })
    .from(schema.instances)
    .where(eq(schema.instances.id, instanceId))
    .limit(1);

  // 2. Load group entries (ordered by position)
  let groupEntries: { modelId: string; providerId: string; providerAccountId: string | null; providerModelKey: string | null; alias: string | null; position: number | null }[] = [];
  if (inst?.modelGroupId) {
    groupEntries = await db
      .select({
        modelId: schema.modelGroupEntries.modelId,
        providerId: schema.modelGroupEntries.providerId,
        providerAccountId: schema.modelGroupEntries.providerAccountId,
        providerModelKey: schema.modelGroupEntries.providerModelKey,
        alias: schema.modelGroupEntries.alias,
        position: schema.modelGroupEntries.position,
      })
      .from(schema.modelGroupEntries)
      .where(and(eq(schema.modelGroupEntries.groupId, inst.modelGroupId), eq(schema.modelGroupEntries.enabled, true)))
      .orderBy(
        asc(schema.modelGroupEntries.position),
        asc(schema.modelGroupEntries.createdAt),
        asc(schema.modelGroupEntries.id),
      );
  }

  // 3. Load all instance models (single query, filter in memory)
  // Managed application instances are group-authoritative. Direct instance
  // models remain a standalone feature and may narrow/extend only local
  // instances.
  const allInstanceModels = inst?.origin === "managed"
    ? []
    : await db
      .select({
        modelId: schema.instanceModels.modelId,
        providerId: schema.instanceModels.providerId,
        providerAccountId: schema.instanceModels.providerAccountId,
        alias: schema.instanceModels.alias,
        source: schema.instanceModels.source,
        priority: schema.instanceModels.priority,
      })
      .from(schema.instanceModels)
      .where(and(eq(schema.instanceModels.instanceId, instanceId), eq(schema.instanceModels.enabled, true)));

  const customModels = allInstanceModels.filter((m) => m.source !== "provider");
  const providerToggled = allInstanceModels.filter((m) => m.source === "provider");

  // Collect all provider IDs for batch query
  const allProviderIds = new Set<string>();
  for (const e of groupEntries) allProviderIds.add(e.providerId);
  for (const e of allInstanceModels) allProviderIds.add(e.providerId);

  // 4. Batch load provider_models for spec resolution + providerModelId lookup
  let allPMs: ProviderModelLookupRow[] = [];
  if (allProviderIds.size > 0) {
    allPMs = await db
      .select({
        id: schema.providerModels.id,
        providerId: schema.providerModels.providerId,
        modelId: schema.providerModels.modelId,
        providerModelId: schema.providerModels.providerModelId,
        canonicalModelId: schema.providerModels.canonicalModelId,
        catalogEntityId: schema.providerModels.catalogEntityId,
        inputPrice: schema.providerModels.inputPrice,
        outputPrice: schema.providerModels.outputPrice,
        contextWindow: schema.providerModels.contextWindow,
        maxOutput: schema.providerModels.maxOutput,
        supportsStreaming: schema.providerModels.supportsStreaming,
        supportsTools: schema.providerModels.supportsTools,
        supportsVision: schema.providerModels.supportsVision,
        nativeFormat: schema.providerModels.nativeFormat,
        nativeEndpoint: schema.providerModels.nativeEndpoint,
        rawMetadata: schema.providerModels.rawMetadata,
      })
      .from(schema.providerModels)
      .where(and(
        inArray(schema.providerModels.providerId, [...allProviderIds]),
        isNotNull(schema.providerModels.catalogEntityId)
      ));
  }

  const lookupPM = buildProviderModelLookup(allPMs);

  function buildEntry(displayName: string, modelId: string, providerId: string, providerModelKey?: string | null, providerAccountId?: string | null): ModelEntry {
    const pm = lookupPM(providerId, providerModelKey ?? modelId) ?? lookupPM(providerId, modelId);
    let cat = catalog.get(modelId) || null;
    if (!cat) {
      for (const prefix of COMMON_PREFIXES) {
        cat = catalog.get(`${prefix}/${modelId}`) || null;
        if (cat) break;
      }
    }

    return {
      displayName,
      modelId,
      providerId,
      providerAccountId: providerAccountId ?? null,
      providerModelId: pm?.providerModelId || modelId,
      catalogEntityId: pm?.catalogEntityId ?? null,
      nativeFormat: normalizeNativeFormat(pm?.nativeFormat),
      nativeEndpoint: pm?.nativeEndpoint ?? null,
      contextWindow: pm?.contextWindow ?? cat?.contextWindow ?? null,
      maxOutput: pm?.maxOutput ?? cat?.maxOutput ?? null,
      inputPrice: pm?.inputPrice != null ? Number(pm.inputPrice) : null,
      outputPrice: pm?.outputPrice != null ? Number(pm.outputPrice) : null,
      providerMethods: providerMethods(pm?.rawMetadata),
      capabilities: {
        streaming: pm?.supportsStreaming ?? cat?.supportsStreaming ?? true,
        tools: (pm?.supportsTools || cat?.supportsTools) ?? false,
        vision: pm?.supportsVision ?? cat?.supportsVision ?? false,
        reasoning: cat?.isReasoning ?? false,
      },
    };
  }

  // 5. Build advertised entries independently from accepted routing aliases.
  const addedModels = new Set<string>(); // exact provider/account/model route for dedup

  const pending: ModelIndexInput[] = [];

  // Group entries (highest priority)
  for (const e of groupEntries) {
    const key = modelRouteIdentity(e.modelId, e.providerId, e.providerAccountId);
    if (addedModels.has(key)) continue;
    addedModels.add(key);
    const name = e.alias || resolveDisplayName(e.modelId, catalog);
    pending.push({
      displayName: name,
      modelId: e.modelId,
      providerId: e.providerId,
      providerAccountId: e.providerAccountId,
      entry: buildEntry(name, e.modelId, e.providerId, e.providerModelKey, e.providerAccountId),
    });
  }

  // Custom instance models (skipped if same modelId:providerId already from group)
  for (const e of customModels) {
    const key = modelRouteIdentity(e.modelId, e.providerId, e.providerAccountId);
    if (addedModels.has(key)) continue;
    addedModels.add(key);
    const name = e.alias || resolveDisplayName(e.modelId, catalog);
    pending.push({
      displayName: name,
      modelId: e.modelId,
      providerId: e.providerId,
      providerAccountId: e.providerAccountId,
      entry: buildEntry(name, e.modelId, e.providerId, null, e.providerAccountId),
    });
  }

  // Provider-toggled models (format: providerId/modelId)
  for (const e of providerToggled) {
    const key = modelRouteIdentity(e.modelId, e.providerId, e.providerAccountId);
    if (addedModels.has(key)) continue;
    addedModels.add(key);
    const name = `${e.providerId}/${e.modelId}`;
    pending.push({
      displayName: name,
      modelId: e.modelId,
      providerId: e.providerId,
      providerAccountId: e.providerAccountId,
      entry: buildEntry(name, e.modelId, e.providerId, null, e.providerAccountId),
    });
  }

  const index = buildModelIndex(pending, groupEntries);
  instanceLookupCache.set(instanceId, { index, builtAt: Date.now() });
  return index;
}

async function getInstanceModelIndex(instanceId: string): Promise<InstanceModelIndex | null> {
  let cached = instanceLookupCache.get(instanceId);
  if (!cached || Date.now() - cached.builtAt > LOOKUP_TTL_MS) {
    await buildInstanceModelIndex(instanceId);
    cached = instanceLookupCache.get(instanceId);
  }
  return cached?.index ?? null;
}

// ── Model Resolution (Display Name Lookup) ────────────────────

export async function resolveModel(
  modelInput: string,
  apiKey: ApiKeyContext["apiKey"]
): Promise<Pick<
  ModelEntry,
  | "modelId"
  | "providerId"
  | "providerAccountId"
  | "providerModelId"
  | "catalogEntityId"
  | "nativeFormat"
  | "nativeEndpoint"
  | "providerMethods"
  | "contextWindow"
  | "maxOutput"
  | "capabilities"
> | null> {
  const index = await getInstanceModelIndex(apiKey.instanceId);
  if (!index) return null;

  const entry = index.routesByName.get(normalizeModelLookupKey(modelInput));
  if (entry && isModelAllowed(apiKey.allowedModels, entry.modelId)) {
    return {
      modelId: entry.modelId,
      providerId: entry.providerId,
      providerAccountId: entry.providerAccountId,
      providerModelId: entry.providerModelId,
      catalogEntityId: entry.catalogEntityId,
      nativeFormat: entry.nativeFormat,
      nativeEndpoint: entry.nativeEndpoint,
      providerMethods: entry.providerMethods,
      contextWindow: entry.contextWindow,
      maxOutput: entry.maxOutput,
      capabilities: entry.capabilities,
    };
  }

  return null;
}

export async function listModelsForApiKey(apiKey: ApiKeyContext["apiKey"]): Promise<ModelEntry[]> {
  const index = await getInstanceModelIndex(apiKey.instanceId);
  if (!index) return [];
  return index.advertisedModels.filter((entry) => isModelAllowed(apiKey.allowedModels, entry.modelId));
}
