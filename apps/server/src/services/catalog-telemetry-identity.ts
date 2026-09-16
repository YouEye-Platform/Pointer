import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { unambiguousTelemetryModelIds, type CatalogTelemetryIdentity } from "./catalog-telemetry-identity-core";

export async function resolveCatalogTelemetryModelIds(modelId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const [active] = await tx.select({ id: schema.catalogGenerations.id })
      .from(schema.catalogGenerations)
      .where(eq(schema.catalogGenerations.state, "active"))
      .limit(1);
    if (!active) return [modelId];

    const [entity] = await tx.select({ entityId: schema.catalogGenerationEntities.entityId })
      .from(schema.catalogGenerationEntities)
      .where(and(
        eq(schema.catalogGenerationEntities.generationId, active.id),
        eq(schema.catalogGenerationEntities.entityId, modelId),
      ))
      .limit(1);
    if (!entity) return [modelId];

    const [aliases, rawRoutes, providerModels] = await Promise.all([
      tx.select({ value: schema.catalogGenerationAliases.alias, entityId: schema.catalogGenerationAliases.entityId })
        .from(schema.catalogGenerationAliases)
        .where(eq(schema.catalogGenerationAliases.generationId, active.id)),
      tx.select({ value: schema.catalogGenerationProviderRoutes.rawModelId, entityId: schema.catalogGenerationProviderRoutes.entityId })
        .from(schema.catalogGenerationProviderRoutes)
        .where(eq(schema.catalogGenerationProviderRoutes.generationId, active.id)),
      tx.select({
        modelId: schema.providerModels.modelId,
        canonicalModelId: schema.providerModels.canonicalModelId,
        entityId: schema.catalogGenerationProviderRoutes.entityId,
      })
        .from(schema.catalogGenerationProviderRoutes)
        .innerJoin(schema.providerModels, eq(schema.providerModels.id, schema.catalogGenerationProviderRoutes.providerModelId))
        .where(eq(schema.catalogGenerationProviderRoutes.generationId, active.id)),
    ]);

    const identities: CatalogTelemetryIdentity[] = [
      ...aliases,
      ...rawRoutes,
      ...providerModels.flatMap((row) => [
        { value: row.modelId, entityId: row.entityId },
        ...(row.canonicalModelId ? [{ value: row.canonicalModelId, entityId: row.entityId }] : []),
      ]),
    ];
    return unambiguousTelemetryModelIds(modelId, identities);
  });
}
