export interface SourceProvenance {
  source: string;
  sourceUrl: string;
  license: string;
  fetchedAt: string;
}

export interface SourceAdapter<T> {
  readonly id: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  enabled?(): Promise<boolean>;
  fetch(options?: SourceFetchOptions): Promise<SourceSnapshot<T>>;
}

export interface SourceFetchOptions {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SourceSnapshot<T> {
  sourceId: string;
  records: T[];
  provenance: SourceProvenance;
}

export type SourceSyncStatus = "never_synced" | "disabled" | "syncing" | "ok" | "error";

export interface SourceState {
  sourceId: string;
  status: SourceSyncStatus;
  stale: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  fetchedAt: string | null;
  recordCount: number;
  error: { code: SourceFetchError["code"]; message: string } | null;
}

export interface NormalizedReferenceModel {
  id: string;
  canonicalSlug: string | null;
  displayName: string;
  creator: string;
  description: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cacheReadPricePerMillion: number | null;
  cacheWritePricePerMillion: number | null;
  releasedAt?: string | null;
  raw: unknown;
  provenance: SourceProvenance;
}

export interface NormalizedBenchmarkRecord {
  benchmarkId: string;
  sourceModelId?: string;
  sourceModel: string;
  creator?: string | null;
  aliases?: string[];
  metrics: Record<string, string | number | boolean | null>;
  raw: unknown;
  provenance: SourceProvenance;
}

export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "upstream" | "oversized" | "malformed" | "empty" | "disabled",
    readonly status?: number
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}
