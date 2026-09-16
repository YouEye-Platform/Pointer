import { parquetRead } from "hyparquet";
import { z } from "zod";
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

const INDEX_URL = "https://huggingface.co/api/datasets/livebench/model_judgment/parquet/default/leaderboard";
type ParquetParser = (bytes: Uint8Array) => Promise<unknown[]>;

async function parseParquet(bytes: Uint8Array): Promise<unknown[]> {
  let rows: unknown[] = [];
  try {
    await parquetRead({ file: bytes.buffer as ArrayBuffer, onComplete(value: unknown[]) { rows = value; } });
  } catch {
    throw new SourceFetchError("LiveBench returned malformed parquet", "malformed");
  }
  return rows;
}

const rowSchema = z.union([
  z.object({ model: z.string(), score: z.number(), category: z.string() }).passthrough(),
  z.array(z.unknown()).min(7),
]);

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export class LiveBenchAdapter implements SourceAdapter<NormalizedBenchmarkRecord> {
  readonly id = "livebench";
  readonly sourceUrl = "https://huggingface.co/datasets/livebench/model_judgment";
  readonly license = "Official Hugging Face dataset; redistribution with source attribution";
  readonly timeoutMs = sourceTimeoutMs(30_000);
  readonly maxBytes = 32 * 1024 * 1024;

  constructor(private readonly parser: ParquetParser = parseParquet) {}

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedBenchmarkRecord>> {
    const indexRaw = await fetchBoundedJson(INDEX_URL, {
      timeoutMs: this.timeoutMs,
      maxBytes: 1024 * 1024,
      fetchImpl: options.fetchImpl,
    });
    const index = z.array(z.string().url()).min(1).max(32).safeParse(indexRaw);
    if (!index.success) throw new SourceFetchError("LiveBench parquet index failed validation", "malformed");
    const parquet = await fetchBoundedBytes(index.data[0], {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
      fetchImpl: options.fetchImpl,
      headers: { Accept: "application/octet-stream" },
    });
    const rawRows = await this.parser(parquet);
    const grouped = new Map<string, Map<string, number[]>>();
    for (const rawRow of rawRows) {
      const parsed = rowSchema.safeParse(rawRow);
      if (!parsed.success) continue;
      const row = parsed.data;
      const sourceModel = Array.isArray(row) ? String(row[2] ?? "") : row.model;
      const score = Number(Array.isArray(row) ? row[3] : row.score);
      const category = Array.isArray(row) ? String(row[6] ?? "") : row.category;
      if (!sourceModel || !Number.isFinite(score) || !category) continue;
      const categories = grouped.get(sourceModel) ?? new Map<string, number[]>();
      categories.set(category, [...(categories.get(category) ?? []), score]);
      grouped.set(sourceModel, categories);
    }

    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };
    const records = [...grouped.entries()].map(([sourceModel, categories]): NormalizedBenchmarkRecord => {
      const metrics: NormalizedBenchmarkRecord["metrics"] = {};
      for (const [category, values] of categories) metrics[category] = round(values.reduce((a, b) => a + b, 0) / values.length);
      const values = Object.values(metrics).filter((value): value is number => typeof value === "number");
      metrics.overall = round(values.reduce((a, b) => a + b, 0) / values.length);
      return { benchmarkId: "livebench", sourceModel, metrics, raw: null, provenance };
    }).sort((a, b) => a.sourceModel.localeCompare(b.sourceModel));
    if (records.length === 0) throw new SourceFetchError("LiveBench produced no benchmark scores", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
