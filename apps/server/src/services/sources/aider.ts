import YAML from "yaml";
import { z } from "zod";
import { fetchBoundedBytes } from "./http";
import { sourceTimeoutMs } from "./config";
import {
  SourceFetchError,
  type NormalizedBenchmarkRecord,
  type SourceAdapter,
  type SourceFetchOptions,
  type SourceProvenance,
  type SourceSnapshot,
} from "./types";

const URLS = {
  polyglot: "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml",
  edit: "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml",
} as const;

const rowSchema = z.object({
  model: z.string().min(1),
  edit_format: z.string().nullable().optional(),
  pass_rate_1: z.union([z.string(), z.number()]).nullable().optional(),
  pass_rate_2: z.union([z.string(), z.number()]).nullable().optional(),
  seconds_per_case: z.union([z.string(), z.number()]).nullable().optional(),
  total_cost: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();

const numberOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export class AiderAdapter implements SourceAdapter<NormalizedBenchmarkRecord> {
  readonly id = "aider";
  readonly sourceUrl = "https://github.com/Aider-AI/aider";
  readonly license = "Apache-2.0";
  readonly timeoutMs = sourceTimeoutMs(20_000);
  readonly maxBytes = 4 * 1024 * 1024;

  async fetch(options: SourceFetchOptions = {}): Promise<SourceSnapshot<NormalizedBenchmarkRecord>> {
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    const provenance: SourceProvenance = {
      source: this.id,
      sourceUrl: this.sourceUrl,
      license: this.license,
      fetchedAt,
    };
    const byModel = new Map<string, { metrics: NormalizedBenchmarkRecord["metrics"]; raw: unknown[] }>();

    for (const [leaderboard, url] of Object.entries(URLS)) {
      const bytes = await fetchBoundedBytes(url, {
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        fetchImpl: options.fetchImpl,
        headers: { Accept: "application/yaml, text/yaml, text/plain" },
      });
      let decoded: unknown;
      try {
        decoded = YAML.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new SourceFetchError(`Aider ${leaderboard} returned malformed YAML`, "malformed");
      }
      const parsed = z.array(rowSchema).safeParse(decoded);
      if (!parsed.success) throw new SourceFetchError(`Aider ${leaderboard} failed schema validation`, "malformed");
      if (parsed.data.length === 0) throw new SourceFetchError(`Aider ${leaderboard} returned no rows`, "empty");

      for (const row of parsed.data) {
        const entry = byModel.get(row.model) ?? { metrics: {}, raw: [] };
        entry.metrics[`${leaderboard}EditFormat`] = row.edit_format ?? null;
        entry.metrics[`${leaderboard}PassRate1`] = numberOrNull(row.pass_rate_1);
        entry.metrics[`${leaderboard}PassRate2`] = numberOrNull(row.pass_rate_2);
        entry.metrics[`${leaderboard}SecondsPerCase`] = numberOrNull(row.seconds_per_case);
        entry.metrics[`${leaderboard}TotalCost`] = numberOrNull(row.total_cost);
        entry.raw.push(row);
        byModel.set(row.model, entry);
      }
    }

    const records = [...byModel.entries()].map(([sourceModel, entry]): NormalizedBenchmarkRecord => ({
      benchmarkId: "aider",
      sourceModel,
      metrics: entry.metrics,
      raw: entry.raw,
      provenance,
    })).sort((a, b) => a.sourceModel.localeCompare(b.sourceModel));
    if (records.length === 0) throw new SourceFetchError("Aider produced no benchmark records", "empty");
    return { sourceId: this.id, records, provenance };
  }
}
