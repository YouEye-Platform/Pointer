import { resolveProviderIconKey } from "./brand-icons";

export interface TestModelTargetRow {
  providerId: string;
  providerName: string;
  providerAccountId: string;
  providerAccountNickname: string | null;
  providerStatus: string;
  providerManifestPath: string | null;
  modelId: string;
  providerModelId: string;
  catalogEntityId?: string | null;
  canonicalModelId: string | null;
  canonicalName: string | null;
}

export interface TestModelProviderTarget {
  id: string;
  providerId: string;
  providerName: string;
  providerAccountId: string;
  providerAccountNickname: string | null;
  providerIconKey: string;
  rawModelId: string;
}

export interface TestModelTarget {
  id: string;
  name: string;
  canonicalModelId: string | null;
  providers: TestModelProviderTarget[];
}

export interface TestModelProviderFacet {
  id: string;
  name: string;
  iconKey: string;
  modelCount: number;
}

export function buildTestModelTargets(rows: TestModelTargetRow[], preferredOrder: readonly string[] = []): {
  models: TestModelTarget[];
  providers: TestModelProviderFacet[];
} {
  const modelMap = new Map<string, TestModelTarget>();

  for (const row of rows) {
    if (row.providerStatus !== "active") continue;

    // Only canonical identities are merged across providers. Provider-only rows
    // remain distinct so equal raw IDs cannot imply a false identity match.
    const id = row.catalogEntityId ?? row.canonicalModelId ?? `provider:${row.providerId}:${row.providerModelId}`;
    const model = modelMap.get(id) ?? {
      id,
      name: row.canonicalName?.trim() || row.modelId,
      canonicalModelId: row.canonicalModelId,
      providers: [],
    };
    const targetId = JSON.stringify([row.providerId, row.providerAccountId, row.providerModelId]);
    if (!model.providers.some((provider) => provider.id === targetId)) {
      model.providers.push({
        id: targetId,
        providerId: row.providerId,
        providerName: row.providerName,
        providerAccountId: row.providerAccountId,
        providerAccountNickname: row.providerAccountNickname,
        providerIconKey: resolveProviderIconKey({
          id: row.providerId,
          manifestPath: row.providerManifestPath,
        }),
        rawModelId: row.providerModelId,
      });
    }
    modelMap.set(id, model);
  }

  const preferredIndex = new Map(preferredOrder.map((id, index) => [id, index]));
  const models = [...modelMap.values()]
    .map((model) => ({
      ...model,
      providers: model.providers.sort((left, right) =>
        left.providerName.localeCompare(right.providerName) || left.rawModelId.localeCompare(right.rawModelId)),
    }))
    .sort((left, right) => {
      const leftIndex = preferredIndex.get(left.id);
      const rightIndex = preferredIndex.get(right.id);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined || rightIndex === undefined) return leftIndex === undefined ? 1 : -1;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      }
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });

  const providerMap = new Map<string, TestModelProviderFacet>();
  for (const model of models) {
    const countedProviders = new Set<string>();
    for (const target of model.providers) {
      if (countedProviders.has(target.providerId)) continue;
      countedProviders.add(target.providerId);
      const provider = providerMap.get(target.providerId) ?? {
        id: target.providerId,
        name: target.providerName,
        iconKey: target.providerIconKey,
        modelCount: 0,
      };
      provider.modelCount += 1;
      providerMap.set(target.providerId, provider);
    }
  }

  return {
    models,
    providers: [...providerMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}
