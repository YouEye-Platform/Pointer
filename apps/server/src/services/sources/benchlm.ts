import { z } from "zod";
import { fetchBoundedJson } from "./http";
import { sourceTimeoutMs } from "./config";
import {
  SourceFetchError,
  type NormalizedBenchmarkRecord,
  type SourceAdapter,
  type SourceFetchOptions,
  type SourceProvenance,
  type SourceSnapshot,
} from "./types";

const MODELS_URL = "https://benchlm.ai/data/models.json";

const rowSchema = z.object({
  slug: z.string().optional(),
  canonicalModelKey: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  creator: z.string().nullable().optional(),
  releaseDate: z.string().nullable().optional(),
  contextWindowTokens: z.union([z.number(), z.string()]).nullable().optional(),
  displayScore: z.union([z.number(), z.string()]).nullable().optional(),
  provisionalDisplayScore: z.union([z.number(), z.string()]).nullable().optional(),
  overallRank: z.union([z.number(), z.string()]).nullable().optional(),
  scores: z.record(z.unknown()).optional(),
  ranking: z.record(z.unknown()).optional(),
  coverage: z.record(z.unknown()).optional(),
  benchmarks: z.record(z.unknown()).optional(),
}).passthrough();

const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
};

const safeKey = (value: string) =>
  value.trim().replace(/[^a-zA-Z0-9]+(.)/g, (_match, character: string) => character.toUpperCase());

const flattenNumeric = (value: unknown, prefix: string, target: Record<string, string | number | boolean | null>) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childKey = safeKey(prefix ? `${prefix}_${key}` : key);
    const number = finiteNumber(child);
    if (number !== null) target[childKey] = number;
    else flattenNumeric(child, childKey, target);
  }
};

export class BenchLmAdapter implements SourceAdapter<NormalizedBenchmarkRecord> {
  readonly id = "benchlm";
  readonly sourceUrl = "https://benchlm.ai/data";
  readonly license = "MIT";
  readonly timeoutMs = sourceTimeoutMs(30_000);
  readonly maxBytes = 16 * 1024 * 1024;

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedBenchmarkRecord>> {
    const payload = await fetchBoundedJson(process.env.BENCHLM_MODELS_URL || MODELS_URL, {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      fetchImpl: options.fetchImpl,
    });
    const rows = payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).items)
      ? (payload as { items: unknown[] }).items
      : null;
    if (!rows) throw new SourceFetchError("BenchLM returned malformed model data", "malformed");
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };
    const records: NormalizedBenchmarkRecord[] = [];
    for (const raw of rows) {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) throw new SourceFetchError("BenchLM model row does not match the expected contract", "malformed");
      const row = parsed.data;
      const stableId = String(row.canonicalModelKey ?? row.slug ?? "").trim();
      const sourceModel = String(row.model ?? row.name ?? stableId).trim();
      if (!stableId || !sourceModel) continue;
      const metrics: Record<string, string | number | boolean | null> = {
        displayScore: finiteNumber((row.scores as Record<string, unknown> | undefined)?.displayScore
          ?? (row.scores as Record<string, unknown> | undefined)?.overallScore
          ?? row.displayScore
          ?? row.provisionalDisplayScore),
        rank: finiteNumber((row.ranking as Record<string, unknown> | undefined)?.overallRank ?? row.overallRank),
        releaseDate: row.releaseDate ?? null,
        contextWindowTokens: finiteNumber(row.contextWindowTokens),
      };
      flattenNumeric((row.scores as Record<string, unknown> | undefined)?.displayCategoryScores, "category", metrics);
      flattenNumeric(row.benchmarks, "benchmark", metrics);
      records.push({
        benchmarkId: this.id,
        sourceModelId: stableId,
        sourceModel,
        creator: row.creator ?? null,
        aliases: [row.slug].filter((value): value is string => Boolean(value)),
        metrics,
        raw: { coverage: row.coverage ?? null },
        provenance,
      });
    }
    if (records.length === 0) throw new SourceFetchError("BenchLM returned no models", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
