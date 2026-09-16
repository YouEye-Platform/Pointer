import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { planCompatibilityRedirects } from "../services/catalog-reconciliation-core";
import { benchmarkDescriptor, benchmarkRegistry } from "../services/benchmark-registry";
import { resolveModelIconKey, resolveProviderIconKey } from "../services/brand-icons";
import { sourceTtlMs } from "../services/sources/config";
import { projectCatalogAvailability } from "../services/catalog-availability";
import { catalogSortDirection } from "../services/catalog-sort";
import { calculateCatalogRankings, compareRecommended } from "../services/catalog-ranking";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);

const numberOrNull = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function loadCatalog(userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const [active] = await tx.select().from(schema.catalogGenerations).where(eq(schema.catalogGenerations.state, "active")).limit(1);
    if (!active) return null;
    const [
      entities,
      routes,
      benchmarks,
      links,
      organizations,
      assets,
      generationSources,
      sourceStates,
      aliases,
      providers,
      providerModels,
      availableAccountModels,
    ] = await Promise.all([
      tx.select().from(schema.catalogGenerationEntities).where(eq(schema.catalogGenerationEntities.generationId, active.id)),
      tx.select().from(schema.catalogGenerationProviderRoutes).where(eq(schema.catalogGenerationProviderRoutes.generationId, active.id)),
      tx.select().from(schema.catalogGenerationBenchmarkLinks).where(eq(schema.catalogGenerationBenchmarkLinks.generationId, active.id)),
      tx.select().from(schema.catalogGenerationObservationLinks).where(eq(schema.catalogGenerationObservationLinks.generationId, active.id)),
      tx.select().from(schema.catalogGenerationOrganizations).where(eq(schema.catalogGenerationOrganizations.generationId, active.id)),
      tx.select().from(schema.catalogGenerationAssets).where(eq(schema.catalogGenerationAssets.generationId, active.id)),
      tx.select({ sourceId: schema.catalogGenerationSnapshots.sourceId }).from(schema.catalogGenerationSnapshots).where(eq(schema.catalogGenerationSnapshots.generationId, active.id)),
      tx.select().from(schema.sourceSyncStates),
      tx.select().from(schema.catalogGenerationAliases).where(eq(schema.catalogGenerationAliases.generationId, active.id)),
      tx.select().from(schema.providers),
      tx.select().from(schema.providerModels),
      userId
        ? tx.select({
          providerModelId: schema.providerAccountModels.providerModelId,
          providerAccountId: schema.providerAccounts.id,
          providerId: schema.providerAccounts.providerId,
          nickname: schema.providerAccounts.nickname,
        })
          .from(schema.providerAccounts)
          .innerJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
          .innerJoin(schema.providerAccountModels, eq(schema.providerAccountModels.providerAccountId, schema.providerAccounts.id))
          .where(and(
            eq(schema.providerAccounts.userId, userId),
            eq(schema.providerAccounts.status, "active"),
          ))
        : Promise.resolve([]),
    ]);
    const supported = new Set(links.map((link) => link.entityId));
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const providerModelsById = new Map(providerModels.map((model) => [model.id, model]));
    const availableProviderModelKeys = new Set(availableAccountModels.map((row) => row.providerModelId));
    const organizationById = new Map(organizations.map((organization) => [organization.organizationId, organization]));
    const assetByOrganization = new Map<string, (typeof assets)[number]>();
    for (const asset of [...assets].sort((left, right) => {
      const kind = Number(left.kind !== "logo") - Number(right.kind !== "logo");
      return kind || left.assetId.localeCompare(right.assetId);
    })) {
      if (!assetByOrganization.has(asset.organizationId)) assetByOrganization.set(asset.organizationId, asset);
    }
    const activeSourceIds = new Set(generationSources.map((source) => source.sourceId));
    const activeBenchmarkDescriptors = benchmarkRegistry
      .filter((descriptor) => activeSourceIds.has(descriptor.id));
    const rawItemRows = entities.map((entity) => {
      const organization = entity.organizationId ? organizationById.get(entity.organizationId) : null;
      const asset = entity.organizationId ? assetByOrganization.get(entity.organizationId) ?? null : null;
      const providerProjection = projectCatalogAvailability(
        routes.filter((route) => route.entityId === entity.entityId).map((route) => {
        const provider = providersById.get(route.providerId);
        const providerModel = providerModelsById.get(route.providerModelId);
        return {
          providerModelKey: route.providerModelId,
          providerId: route.providerId,
          providerName: provider?.name ?? route.providerId,
          providerIconKey: provider ? resolveProviderIconKey(provider) : route.providerId,
          rawModelId: route.rawModelId,
          pricing: {
            input: numberOrNull(route.inputPrice),
            output: numberOrNull(route.outputPrice),
            currency: "USD" as const,
            source: providerModel?.priceSource ?? null,
            fetchedAt: providerModel?.priceFetchedAt?.toISOString() ?? null,
          },
          capabilities: {
            tools: route.supportsTools,
            vision: route.supportsVision,
            streaming: route.supportsStreaming,
          },
          contextWindow: route.contextWindow,
          maxOutput: route.maxOutput,
        };
        }),
        availableProviderModelKeys,
      );
      const providerRows = providerProjection.routes
        .map((route) => ({
          ...route,
          accounts: availableAccountModels
            .filter((row) => row.providerModelId === route.providerModelKey)
            .map((row) => ({
              id: row.providerAccountId,
              nickname: row.nickname,
            }))
            .sort((left, right) => (left.nickname ?? "").localeCompare(right.nickname ?? "") || left.id.localeCompare(right.id)),
        }))
        .sort((left, right) => left.providerName.localeCompare(right.providerName) || left.rawModelId.localeCompare(right.rawModelId));
      const benchmarkRows = benchmarks.filter((benchmark) => benchmark.entityId === entity.entityId).map((benchmark) => ({
        id: `${benchmark.benchmarkId}:${benchmark.sourceModel}`,
        benchmarkId: benchmark.benchmarkId,
        sourceModel: benchmark.sourceModel,
        entityId: benchmark.entityId,
        metrics: benchmark.metrics as Record<string, string | number | boolean | null>,
        provenance: benchmark.provenance as { source: string; sourceUrl: string; license: string; fetchedAt: string },
        fetchedAt: benchmark.fetchedAt.toISOString(),
        presentation: (() => {
          const descriptor = benchmarkDescriptor(benchmark.benchmarkId);
          const metrics = benchmark.metrics as Record<string, string | number | boolean | null>;
          const score = descriptor ? metrics[descriptor.scoreMetric] : null;
          const rank = descriptor?.rankMetric ? metrics[descriptor.rankMetric] : null;
          return {
            label: descriptor?.label ?? benchmark.benchmarkId,
            score: typeof score === "number" ? score : null,
            rank: typeof rank === "number" ? rank : null,
            unit: descriptor?.unit ?? "points",
            higherIsBetter: descriptor?.higherIsBetter ?? true,
          };
        })(),
      })).sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId) || left.sourceModel.localeCompare(right.sourceModel));
      const aliasRows = aliases.filter((alias) => alias.entityId === entity.entityId).map((alias) => ({
        source: alias.sourceId,
        alias: alias.alias,
        provenance: { observationId: alias.observationId },
      })).sort((left, right) => left.source.localeCompare(right.source) || left.alias.localeCompare(right.alias));
      return {
        id: entity.entityId,
        slug: entity.stableSlug,
        name: entity.preferredName,
        nameProvenance: entity.nameProvenance,
        creator: organization?.canonicalName ?? null,
        creatorIconKey: entity.organizationId?.replace(/^org\//, "") ?? null,
        modelIconKey: resolveModelIconKey({
          id: entity.entityId,
          name: entity.preferredName,
          creator: organization?.canonicalName ?? null,
        }),
        description: entity.description,
        contextWindow: entity.contextWindow,
        maxOutput: entity.maxOutput,
        capabilities: {
          reasoning: false,
          vision: entity.supportsVision,
          tools: entity.supportsTools,
          streaming: entity.supportsStreaming,
        },
        referencePricing: {
          input: numberOrNull(entity.referenceInputPrice),
          output: numberOrNull(entity.referenceOutputPrice),
          currency: "USD" as const,
          source: entity.metadataSource === "openrouter" ? "openrouter" : null,
          fetchedAt: entity.metadataFetchedAt?.toISOString() ?? null,
        },
        providerCount: providerProjection.providerCount,
        availableProviderCount: providerProjection.availableProviderCount,
        available: providerProjection.available,
        providers: providerRows,
        aliases: aliasRows,
        benchmarks: benchmarkRows,
        metadataSource: entity.metadataSource,
        metadataFetchedAt: entity.metadataFetchedAt?.toISOString() ?? null,
        releasedAt: entity.releasedAt?.toISOString() ?? null,
        organization: organization ? {
          id: organization.organizationId,
          name: organization.canonicalName,
          aliases: organization.aliases as string[],
          websiteUrl: organization.websiteUrl,
        } : null,
        asset: asset ? {
          id: asset.assetId,
          organizationId: asset.organizationId,
          kind: asset.kind,
          mediaType: asset.mimeType,
          contentHash: asset.contentHash,
          sourceUrl: asset.originUrl,
          license: asset.license,
          fetchedAt: asset.fetchedAt.toISOString(),
          active: true,
        } : null,
        routes: providerRows.map((route) => ({
          id: `${route.providerId}:${route.rawModelId}`,
          providerId: route.providerId,
          providerModelId: route.rawModelId,
          entityId: entity.entityId,
          active: true,
        })),
        supportedByActiveObservation: supported.has(entity.entityId),
      };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const rankingProjection = calculateCatalogRankings(rawItemRows, activeBenchmarkDescriptors);
    const itemRows = rawItemRows.map((item) => ({
      ...item,
      benchmarks: item.benchmarks.map((benchmark) => {
        const ranking = rankingProjection.benchmarkRanks.get(benchmark.benchmarkId)?.get(item.id) ?? null;
        return {
          ...benchmark,
          presentation: {
            ...benchmark.presentation,
            effectiveRank: ranking?.rank ?? null,
            rankDerived: ranking?.rankDerived ?? false,
            population: ranking?.population ?? null,
            percentile: ranking?.percentile ?? null,
          },
        };
      }),
      recommendedRanking: rankingProjection.recommendedRankings.get(item.id) ?? null,
    }));
    const sourceNow = Date.now();
    const sourceTtl = sourceTtlMs();
    return {
      contractVersion: "1" as const,
      snapshotId: active.id,
      generatedAt: (active.completedAt ?? active.createdAt).toISOString(),
      items: itemRows,
      benchmarkDescriptors: activeBenchmarkDescriptors,
      ranking: {
        sort: "recommended" as const,
        method: "mean_percentile" as const,
        sourceIds: activeBenchmarkDescriptors
          .filter((descriptor) => descriptor.rankingPriority !== null)
          .map((descriptor) => descriptor.id),
      },
      sources: sourceStates.filter((source) => activeSourceIds.has(source.sourceId)).map((source) => ({
        sourceId: source.sourceId,
        status: source.status as "never_synced" | "disabled" | "syncing" | "ok" | "error",
        stale: source.status === "disabled" ? false : !source.fetchedAt || sourceNow - source.fetchedAt.getTime() > sourceTtl,
        lastAttemptAt: source.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
        fetchedAt: source.fetchedAt?.toISOString() ?? null,
        recordCount: source.recordCount,
        error: source.errorCode ? { code: source.errorCode, message: source.errorMessage ?? "Source sync failed" } : null,
      })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    };
  });
}

export async function loadCatalogDetail(slug: string, userId?: string) {
  const catalog = await loadCatalog(userId);
  if (!catalog) return { catalog: null, item: null };
  const direct = catalog.items.find((candidate) => candidate.id === slug || candidate.slug === slug);
  if (direct) return { catalog, item: direct };
  const [historicalEntities, historicalAliases] = await Promise.all([
    db.select({ id: schema.modelEntities.id, stableSlug: schema.modelEntities.stableSlug }).from(schema.modelEntities),
    db.select({ alias: schema.catalogGenerationAliases.alias, entityId: schema.catalogGenerationAliases.entityId })
      .from(schema.catalogGenerationAliases)
      .where(eq(schema.catalogGenerationAliases.sourceId, "pointer:entity-redirect")),
  ]);
  const redirect = planCompatibilityRedirects({
    currentEntities: catalog.items.map((item) => ({ id: item.id, stableSlug: item.slug })),
    historicalEntities,
    currentRemaps: [],
    historicalAliases,
  }).find((candidate) => candidate.alias === slug);
  return { catalog, item: redirect ? catalog.items.find((candidate) => candidate.id === redirect.entityId) ?? null : null };
}

app.get("/", async (c) => {
  const catalog = await loadCatalog(c.get("user").id);
  if (!catalog) return c.json({ error: { code: "catalog_unavailable", message: "No active catalog generation" } }, 503);
  let items = catalog.items;
  const search = c.req.query("search")?.trim().toLowerCase();
  const creator = c.req.query("creator")?.trim().toLowerCase();
  const capability = c.req.query("capability")?.trim();
  const provider = c.req.query("provider")?.trim();
  const availability = c.req.query("availability") ?? "all";
  const source = c.req.query("source")?.trim();
  if (search) items = items.filter((item) => item.name.toLowerCase().includes(search)
    || item.id.toLowerCase().includes(search)
    || item.aliases.some((alias) => alias.alias.toLowerCase().includes(search)));
  if (creator) items = items.filter((item) => item.creator?.toLowerCase() === creator);
  if (capability && capability in (items[0]?.capabilities ?? {})) {
    items = items.filter((item) => item.capabilities[capability as keyof typeof item.capabilities]);
  }
  if (provider) items = items.filter((item) => item.providers.some((row) => row.providerId === provider));
  if (availability === "available") items = items.filter((item) => item.available);
  if (availability === "unavailable") items = items.filter((item) => !item.available);
  if (source) items = items.filter((item) => item.metadataSource === source || item.benchmarks.some((row) => row.benchmarkId === source));

  const sort = c.req.query("sort") ?? "recommended";
  const order = catalogSortDirection(sort, c.req.query("order"));
  items.sort((left, right) => {
    let result = 0;
    if (sort === "recommended") {
      return compareRecommended(left, right);
    } else if (sort === "newest") {
      const leftReleased = left.releasedAt ? Date.parse(left.releasedAt) : -1;
      const rightReleased = right.releasedAt ? Date.parse(right.releasedAt) : -1;
      result = leftReleased - rightReleased;
    } else if (sort === "price") {
      if (left.referencePricing.input === null || right.referencePricing.input === null) {
        return left.referencePricing.input === right.referencePricing.input
          ? left.id.localeCompare(right.id)
          : left.referencePricing.input === null ? 1 : -1;
      }
      result = left.referencePricing.input - right.referencePricing.input;
    } else if (sort === "context") result = (left.contextWindow ?? -1) - (right.contextWindow ?? -1);
    else if (sort === "providers") result = left.providerCount - right.providerCount;
    else if (sort.startsWith("benchmark:")) {
      const sourceId = sort.slice("benchmark:".length);
      const leftBenchmark = left.benchmarks.find((benchmark) => benchmark.benchmarkId === sourceId);
      const rightBenchmark = right.benchmarks.find((benchmark) => benchmark.benchmarkId === sourceId);
      const leftPercentile = leftBenchmark?.presentation.percentile ?? null;
      const rightPercentile = rightBenchmark?.presentation.percentile ?? null;
      if (leftPercentile === null || rightPercentile === null) {
        return leftPercentile === rightPercentile ? left.id.localeCompare(right.id) : leftPercentile === null ? 1 : -1;
      }
      result = leftPercentile - rightPercentile;
    } else result = left.name.localeCompare(right.name);
    return result === 0 ? left.id.localeCompare(right.id) : result * order;
  });

  const facets = {
    creators: [...new Set(catalog.items.map((item) => item.creator).filter((value): value is string => Boolean(value)))].sort(),
    providers: [...new Map(catalog.items.flatMap((item) => item.providers).map((item) => [item.providerId, { id: item.providerId, name: item.providerName, available: item.available }])).values()]
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize")) || 50));
  return c.json({
    ...catalog,
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: items.length,
    facets,
  });
});

app.get("/detail", async (c) => {
  const slug = c.req.query("slug")?.trim();
  if (!slug) return c.json({ error: "slug is required" }, 400);
  const { catalog, item } = await loadCatalogDetail(slug, c.get("user").id);
  if (!catalog) return c.json({ error: { code: "catalog_unavailable", message: "No active catalog generation" } }, 503);
  if (!item) return c.json({ error: "Model not found" }, 404);
  return c.json({
    contractVersion: catalog.contractVersion,
    snapshotId: catalog.snapshotId,
    generatedAt: catalog.generatedAt,
    ...item,
    benchmarkDescriptors: catalog.benchmarkDescriptors,
    ranking: catalog.ranking,
    sources: catalog.sources,
  });
});

export default app;
