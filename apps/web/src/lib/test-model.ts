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

export interface TestModelTargetsResponse {
  models: TestModelTarget[];
  providers: Array<{ id: string; name: string; iconKey: string; modelCount: number }>;
}

export interface TestModelSelection {
  modelId: string;
  targetId: string;
}

export function resolveTestSelection(models: TestModelTarget[], selection: TestModelSelection) {
  const model = models.find((item) => item.id === selection.modelId);
  const target = model?.providers.find((item) => item.id === selection.targetId);
  return model && target ? { model, target } : null;
}

export function defaultTestSelection(models: TestModelTarget[]): TestModelSelection {
  const model = models.find((item) => item.providers.length > 0);
  return model ? { modelId: model.id, targetId: model.providers[0]!.id } : { modelId: "", targetId: "" };
}

export function defaultComparisonSelection(models: TestModelTarget[], primary: TestModelSelection): TestModelSelection {
  const resolved = resolveTestSelection(models, primary);
  const alternateProvider = resolved?.model.providers.find((target) => target.id !== resolved.target.id);
  if (resolved && alternateProvider) return { modelId: resolved.model.id, targetId: alternateProvider.id };

  for (const model of models) {
    const target = model.providers.find((item) => item.id !== primary.targetId || model.id !== primary.modelId);
    if (target) return { modelId: model.id, targetId: target.id };
  }
  return primary;
}
