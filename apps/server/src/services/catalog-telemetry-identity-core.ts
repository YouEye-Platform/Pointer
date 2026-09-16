export interface CatalogTelemetryIdentity {
  value: string;
  entityId: string;
}

export function unambiguousTelemetryModelIds(
  entityId: string,
  identities: CatalogTelemetryIdentity[],
): string[] {
  const entityIdsByValue = new Map<string, Set<string>>();
  for (const identity of identities) {
    if (!identity.value) continue;
    const entityIds = entityIdsByValue.get(identity.value) ?? new Set<string>();
    entityIds.add(identity.entityId);
    entityIdsByValue.set(identity.value, entityIds);
  }

  const compatible = [...entityIdsByValue]
    .filter(([, entityIds]) => entityIds.size === 1 && entityIds.has(entityId))
    .map(([value]) => value)
    .filter((value) => value !== entityId)
    .sort((left, right) => left.localeCompare(right));

  return [entityId, ...compatible];
}
