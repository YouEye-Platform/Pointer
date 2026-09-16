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

const DEFAULT_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const DOCUMENTED_PAGE_SIZE = 200;
const MAX_PAGES = 20;

const rowSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
  model_creator: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
  }).passthrough().optional(),
  model_family: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    slug: z.string().optional(),
  }).passthrough().optional(),
  release_date: z.string().nullable().optional(),
  evaluations: z.record(z.unknown()).optional(),
  artificial_analysis_intelligence_index_cost: z.unknown().optional(),
  pricing: z.unknown().optional(),
  performance: z.unknown().optional(),
}).passthrough();

const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
};

const metricKey = (value: string) =>
  value.trim().replace(/^artificial_analysis_/, "").replace(/[^a-zA-Z0-9]+(.)/g, (_match, character: string) => character.toUpperCase());

const payloadRows = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") throw new SourceFetchError("Artificial Analysis returned malformed JSON", "malformed");
  const object = payload as Record<string, unknown>;
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.models)) return object.models;
  throw new SourceFetchError("Artificial Analysis response has no model data", "malformed");
};

const hasNextPage = (payload: unknown, rowCount: number, requestedPage: number): boolean => {
  if (!payload || typeof payload !== "object") return rowCount >= DOCUMENTED_PAGE_SIZE;
  const object = payload as Record<string, any>;
  const pagination = object.pagination ?? object.meta ?? {};
  const current = finiteNumber(pagination.page ?? pagination.current_page ?? pagination.currentPage);
  const total = finiteNumber(pagination.total_pages ?? pagination.totalPages ?? pagination.last_page);
  const hasMore = pagination.has_more ?? pagination.hasMore;
  if (current !== null && (!Number.isInteger(current) || current !== requestedPage)) {
    throw new SourceFetchError("Artificial Analysis returned contradictory pagination", "malformed");
  }
  if (total !== null && (!Number.isInteger(total) || total < requestedPage)) {
    throw new SourceFetchError("Artificial Analysis returned contradictory pagination", "malformed");
  }
  if (total !== null && total > MAX_PAGES) {
    throw new SourceFetchError(`Artificial Analysis exceeded ${MAX_PAGES} pages`, "oversized");
  }
  if (typeof hasMore === "boolean" && total !== null && hasMore !== (requestedPage < total)) {
    throw new SourceFetchError("Artificial Analysis returned contradictory pagination", "malformed");
  }
  if (typeof hasMore === "boolean") return hasMore;
  if (pagination.next_page != null || pagination.nextPage != null || pagination.next != null) {
    return Boolean(pagination.next_page ?? pagination.nextPage ?? pagination.next);
  }
  if (current !== null && total !== null) return current < total;
  return rowCount >= DOCUMENTED_PAGE_SIZE;
};

export class ArtificialAnalysisAdapter implements SourceAdapter<NormalizedBenchmarkRecord> {
  readonly id = "artificial-analysis";
  readonly sourceUrl = "https://artificialanalysis.ai/";
  readonly license = "Artificial Analysis API terms";
  readonly timeoutMs = sourceTimeoutMs(30_000);
  readonly maxBytes = 8 * 1024 * 1024;

  constructor(
    private readonly credential: () => Promise<string | null> = async () => null,
    private readonly available: () => Promise<boolean> = async () => Boolean(await credential())
  ) {}

  enabled(): Promise<boolean> {
    return this.available();
  }

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedBenchmarkRecord>> {
    const apiKey = await this.credential();
    if (!apiKey) throw new SourceFetchError("Artificial Analysis is not configured", "disabled");
    const baseUrl = process.env.ARTIFICIAL_ANALYSIS_API_URL || DEFAULT_URL;
    const rows: unknown[] = [];
    let intelligenceIndexVersion: number | null = null;
    let responseTier: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set("page", String(page));
      const payload = await fetchBoundedJson(url.toString(), {
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        fetchImpl: options.fetchImpl,
        headers: { Accept: "application/json", "x-api-key": apiKey },
      });
      if (payload && typeof payload === "object") {
        const envelope = payload as Record<string, unknown>;
        const version = finiteNumber(envelope.intelligence_index_version);
        if (version !== null) {
          if (intelligenceIndexVersion !== null && version !== intelligenceIndexVersion) {
            throw new SourceFetchError("Artificial Analysis changed index version during pagination", "malformed");
          }
          intelligenceIndexVersion = version;
        }
        if (typeof envelope.tier === "string") {
          if (responseTier !== null && envelope.tier !== responseTier) {
            throw new SourceFetchError("Artificial Analysis changed access tier during pagination", "malformed");
          }
          responseTier = envelope.tier;
        }
      }
      const pageRows = payloadRows(payload);
      rows.push(...pageRows);
      if (!hasNextPage(payload, pageRows.length, page)) break;
      if (page === MAX_PAGES) throw new SourceFetchError(`Artificial Analysis exceeded ${MAX_PAGES} pages`, "oversized");
    }

    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };
    const records: NormalizedBenchmarkRecord[] = [];
    for (const [index, raw] of rows.entries()) {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) throw new SourceFetchError("Artificial Analysis model row does not match the documented contract", "malformed");
      const row = parsed.data;
      const stableId = String(row.id ?? row.slug ?? "").trim();
      const sourceModel = String(row.name ?? row.slug ?? stableId).trim();
      if (!stableId || !sourceModel) throw new SourceFetchError("Artificial Analysis model is missing a stable ID or name", "malformed");
      const metrics: Record<string, string | number | boolean | null> = {
        rank: index + 1,
        artificialAnalysisId: stableId,
        slug: row.slug ?? null,
        creatorId: row.model_creator?.id == null ? null : String(row.model_creator.id),
        creatorSlug: row.model_creator?.slug ?? null,
        familyId: row.model_family?.id == null ? null : String(row.model_family.id),
        familySlug: row.model_family?.slug ?? null,
        releaseDate: row.release_date ?? null,
        intelligenceIndexVersion,
        responseTier,
      };
      for (const [key, value] of Object.entries(row.evaluations ?? {})) {
        const number = finiteNumber(value);
        if (number !== null) metrics[metricKey(key)] = number;
      }
      const intelligence = metrics.intelligenceIndex;
      if (typeof intelligence !== "number") {
        const fallback = finiteNumber((raw as Record<string, unknown>).intelligence_index);
        if (fallback !== null) metrics.intelligenceIndex = fallback;
      }
      const rawRecord = raw as Record<string, unknown>;
      for (const variantKey of ["reasoning_effort", "reasoning", "thinking", "configuration", "variant", "mode"]) {
        const value = rawRecord[variantKey];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          metrics[variantKey] = value;
        }
      }
      records.push({
        benchmarkId: this.id,
        sourceModelId: stableId,
        sourceModel,
        creator: row.model_creator?.name ?? null,
        aliases: [row.slug].filter((value): value is string => Boolean(value)),
        metrics,
        raw: {
          intelligenceIndexCost: row.artificial_analysis_intelligence_index_cost ?? null,
          pricing: row.pricing ?? null,
          performance: row.performance ?? null,
        },
        provenance,
      });
    }
    if (records.length === 0) throw new SourceFetchError("Artificial Analysis returned no models", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
