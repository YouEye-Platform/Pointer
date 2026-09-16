import type {
  IProviderHandler,
  ProviderManifest,
  StaticModel,
} from "../../src/providers/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

const handler: IProviderHandler = {
  transformModelList(rawModels: unknown[], _config: ProviderManifest): StaticModel[] {
    return rawModels.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== "string") return [];
      const id = raw.name.replace(/^models\//, "");
      if (!id) return [];
      const methods = Array.isArray(raw.supportedGenerationMethods)
        ? raw.supportedGenerationMethods.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const generationCapable = methods.includes("generateContent");
      return [{
        id,
        name: typeof raw.displayName === "string" ? raw.displayName : id,
        contextWindow: positiveInteger(raw.inputTokenLimit),
        maxOutput: positiveInteger(raw.outputTokenLimit),
        supportsStreaming: methods.includes("streamGenerateContent") || generationCapable,
        supportsTools: generationCapable,
        supportsVision: generationCapable && !id.toLowerCase().includes("embedding"),
        supportedGenerationMethods: methods,
        nativeFormat: "google-generate-content",
      }];
    });
  },
};

export default handler;
