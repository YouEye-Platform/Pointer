import { wireCapabilityOverridesSchema } from "../gateway/wire-capabilities";

/** Preserve capabilities advertised by the engine without guessing from names. */
export function engineModelMetadata(model: {
  namespaced: string; supportsTools?: boolean; supportsReasoning?: boolean; reasoningEfforts?: string[];
}) {
  const efforts = model.reasoningEfforts?.filter(effort =>
    wireCapabilityOverridesSchema.safeParse({ reasoningEfforts: [effort] }).success);
  return {
    engineSelector: model.namespaced,
    ...(model.supportsTools === undefined ? {} : { supportsTools: model.supportsTools }),
    ...(model.supportsReasoning === undefined ? {} : { supportsReasoning: model.supportsReasoning }),
    ...(model.supportsReasoning !== false && efforts?.length ? { wireCapabilities: { reasoningEfforts: efforts } } : {}),
  };
}
