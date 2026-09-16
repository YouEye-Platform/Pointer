import { parquetRead } from "hyparquet";
import { fetchBoundedBytes, fetchBoundedJson } from "./http";
import { sourceTimeoutMs } from "./config";
import {
  SourceFetchError,
  type NormalizedBenchmarkRecord,
  type SourceAdapter,
  type SourceFetchOptions,
  type SourceProvenance,
  type SourceSnapshot,
} from "./types";

type ParquetParser = (bytes: Uint8Array) => Promise<unknown[]>;

export const LM_ARENA_CONFIGS = [
  { id: "lmarena", config: "text_style_control" },
  { id: "lmarena-vision", config: "vision_style_control" },
  { id: "lmarena-search", config: "search_style_control" },
  { id: "lmarena-document", config: "document_style_control" },
  { id: "lmarena-webdev", config: "webdev" },
  { id: "lmarena-agent", config: "agent" },
] as const;

async function parseParquet(bytes: Uint8Array): Promise<unknown[]> {
  let rows: unknown[] = [];
  try {
    await parquetRead({ file: bytes.buffer as ArrayBuffer, onComplete(value: unknown[]) { rows = value; } });
  } catch {
    throw new SourceFetchError("LMArena returned malformed parquet", "malformed");
  }
  return rows;
}

const numberOrNull = (value: unknown) => {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
};

const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};

export class LMArenaAdapter implements SourceAdapter<NormalizedBenchmarkRecord> {
  readonly id: string;
  readonly config: string;
  readonly sourceUrl = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";
  readonly license = "CC-BY-4.0";
  readonly timeoutMs = sourceTimeoutMs(30_000);
  readonly maxBytes = 32 * 1024 * 1024;

  constructor(
    private readonly parser: ParquetParser = parseParquet,
    definition: { id: string; config: string } = LM_ARENA_CONFIGS[0]
  ) {
    this.id = definition.id;
    this.config = definition.config;
  }

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedBenchmarkRecord>> {
    const listing = await fetchBoundedJson(
      `https://huggingface.co/api/datasets/lmarena-ai/leaderboard-dataset/parquet/${this.config}/latest`,
      {
        timeoutMs: this.timeoutMs,
        maxBytes: 1024 * 1024,
        fetchImpl: options.fetchImpl,
      }
    );
    if (!Array.isArray(listing) || typeof listing[0] !== "string") {
      throw new SourceFetchError("LMArena returned malformed parquet discovery data", "malformed");
    }
    const bytes = await fetchBoundedBytes(listing[0], {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      fetchImpl: options.fetchImpl,
      headers: { Accept: "application/octet-stream" },
    });
    const rows = await this.parser(bytes);
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };
    const seen = new Set<string>();
    const records: NormalizedBenchmarkRecord[] = [];
    for (const rawRow of rows) {
      if (!rawRow || (typeof rawRow !== "object" && !Array.isArray(rawRow))) continue;
      const row = rawRow as Record<string, unknown> & unknown[];
      const category = String(row.category ?? row[9] ?? "");
      const sourceModel = String(row.model ?? row.model_name ?? row[0] ?? "");
      const rating = numberOrNull(row.rating ?? row.score ?? row[3]);
      if ((category && category !== "overall") || !sourceModel || rating === null || seen.has(sourceModel)) continue;
      const organization = String(row.organization ?? row[1] ?? "") || null;
      const date = row.leaderboard_publish_date ?? row.date ?? row.last_updated_datetime ?? row[10] ?? null;
      if (date !== null && Number.isNaN(Date.parse(String(date)))) {
        throw new SourceFetchError("LMArena returned an invalid leaderboard date", "malformed");
      }
      seen.add(sourceModel);
      records.push({
        benchmarkId: this.id,
        sourceModelId: sourceModel,
        sourceModel,
        creator: organization,
        metrics: {
          organization,
          modelLicense: String(row.license ?? row[2] ?? "") || null,
          arenaScore: rating,
          ciLow: numberOrNull(row.rating_lower ?? row.ci_low ?? row[4]),
          ciHigh: numberOrNull(row.rating_upper ?? row.ci_high ?? row[5]),
          votes: numberOrNull(row.vote_count ?? row.votes ?? row[7]),
          rank: numberOrNull(row.rank ?? row[8]),
          category: category || "overall",
          leaderboardDate: date === null ? null : String(date),
        },
        raw: jsonSafe(rawRow),
        provenance,
      });
    }
    if (records.length === 0) throw new SourceFetchError("LMArena produced no overall scores", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
