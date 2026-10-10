import { discoveredToolCapability, toolCapabilityValue } from "../gateway/tool-capability";
import type { ProviderManifest } from "../providers/types";

type UnknownRecord = Record<string, unknown>;

export type DiscoveredModelCapabilities = {
  supportsTools: boolean | null;
  supportsVision: boolean;
  supportsStreaming: boolean;
};

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value) => typeof value === "boolean") as
    | boolean
    | undefined;
}

function declaredParameter(
  model: UnknownRecord,
  parameter: string
): boolean | undefined {
  return Array.isArray(model.supported_parameters)
    && model.supported_parameters.includes(parameter)
    ? true
    : undefined;
}

function capabilityFallback(
  manifest: ProviderManifest,
  modelId: string
) {
  const normalizedModelId = modelId.toLowerCase();
  return manifest.models?.capabilityFallbacks?.find(
    (entry) =>
      typeof entry.modelId === "string"
      && entry.modelId.toLowerCase() === normalizedModelId
  );
}

/**
 * Resolves discovery capabilities without allowing a manifest fallback to
 * contradict an explicit provider boolean. Missing tool metadata remains unknown; vision stays conservative and streaming on.
 */
export function resolveDiscoveredModelCapabilities(
  model: UnknownRecord,
  manifest: ProviderManifest,
  modelId: string
): DiscoveredModelCapabilities {
  const fallback = capabilityFallback(manifest, modelId);

  return {
    supportsTools: toolCapabilityValue(discoveredToolCapability(model, fallback?.supportsTools)),
    supportsVision:
      firstBoolean(
        model.supports_vision,
        model.supportsVision,
        model.supportsImageInput,
        model.supports_image_input,
        declaredParameter(model, "vision"),
        fallback?.supportsVision
      ) ?? false,
    supportsStreaming:
      firstBoolean(
        model.supportsStreaming,
        model.supports_streaming,
        fallback?.supportsStreaming
      ) ?? true,
  };
}
