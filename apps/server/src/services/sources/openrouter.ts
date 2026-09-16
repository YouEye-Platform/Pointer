import { z } from "zod";
import { fetchBoundedJson } from "./http";
import { sourceTimeoutMs } from "./config";
import {
  SourceFetchError,
  type NormalizedReferenceModel,
  type SourceAdapter,
  type SourceFetchOptions,
  type SourceProvenance,
  type SourceSnapshot,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_LICENSE = "Public API; model metadata and pricing redistributed with source attribution";

const modelSchema = z.object({
  id: z.string().min(1),
  canonical_slug: z.string().nullable().optional(),
  created: z.number().int().positive().nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  context_length: z.number().int().positive().nullable().optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  }).passthrough().optional(),
  pricing: z.object({
    prompt: z.union([z.string(), z.number()]).nullable().optional(),
    completion: z.union([z.string(), z.number()]).nullable().optional(),
    input_cache_read: z.union([z.string(), z.number()]).nullable().optional(),
    input_cache_write: z.union([z.string(), z.number()]).nullable().optional(),
  }).passthrough().optional(),
  supported_parameters: z.array(z.string()).optional(),
  top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable().optional() }).passthrough().optional(),
}).passthrough();

const responseSchema = z.union([
  z.object({ data: z.array(modelSchema) }).passthrough(),
  z.array(modelSchema),
]);

const perMillion = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
};

const creatorFromId = (id: string) => id.includes("/") ? id.split("/", 1)[0] : "unknown";

export class OpenRouterAdapter implements SourceAdapter<NormalizedReferenceModel> {
  readonly id = "openrouter";
  readonly sourceUrl = OPENROUTER_URL;
  readonly license = OPENROUTER_LICENSE;
  readonly timeoutMs = sourceTimeoutMs(20_000);
  readonly maxBytes = 16 * 1024 * 1024;

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedReferenceModel>> {
    const raw = await fetchBoundedJson(this.sourceUrl, {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      fetchImpl: options.fetchImpl,
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new SourceFetchError("OpenRouter response failed schema validation", "malformed");
    const models = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
    if (models.length === 0) throw new SourceFetchError("OpenRouter returned an empty model catalog", "empty");

    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };

    const records = models
      .filter((model) => {
        const input = model.architecture?.input_modalities ?? ["text"];
        const output = model.architecture?.output_modalities ?? ["text"];
        return input.includes("text") && output.includes("text");
      })
      .map((model): NormalizedReferenceModel => ({
        id: model.id,
        canonicalSlug: model.canonical_slug ?? null,
        displayName: model.name ?? model.id,
        creator: creatorFromId(model.id),
        description: model.description ?? null,
        contextWindow: model.context_length ?? null,
        maxOutput: model.top_provider?.max_completion_tokens ?? null,
        inputModalities: model.architecture?.input_modalities ?? ["text"],
        outputModalities: model.architecture?.output_modalities ?? ["text"],
        supportedParameters: model.supported_parameters ?? [],
        inputPricePerMillion: perMillion(model.pricing?.prompt),
        outputPricePerMillion: perMillion(model.pricing?.completion),
        cacheReadPricePerMillion: perMillion(model.pricing?.input_cache_read),
        cacheWritePricePerMillion: perMillion(model.pricing?.input_cache_write),
        releasedAt: model.created ? new Date(model.created * 1000).toISOString() : null,
        raw: model,
        provenance,
      }));

    if (records.length === 0) throw new SourceFetchError("OpenRouter returned no text models", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
