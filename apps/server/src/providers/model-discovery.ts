import { providerAuthHeaders } from "./auth-headers";
import type {
  ProviderManifest,
  ProviderModelDiscoveryFilter,
  ProviderModelDiscoveryPrimitive,
} from "./types";

type UnknownRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;

const DEFAULT_LIST_PATH = "data";
const DEFAULT_MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;

export class ProviderModelDiscoveryError extends Error {
  providerId: string;
  status?: number;

  constructor(providerId: string, message: string, status?: number) {
    super(`Model discovery for ${providerId} ${message}`);
    this.name = "ProviderModelDiscoveryError";
    this.providerId = providerId;
    this.status = status;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function discoveryValueAtPath(
  value: unknown,
  path: string
): unknown {
  if (!path) return value;
  return path
    .split(".")
    .reduce<unknown>(
      (current, segment) =>
        isRecord(current) ? current[segment] : undefined,
      value
    );
}

function isPrimitive(value: unknown): value is ProviderModelDiscoveryPrimitive {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  );
}

function primitiveEquals(
  left: unknown,
  right: ProviderModelDiscoveryPrimitive
): boolean {
  return isPrimitive(left) && Object.is(left, right);
}

export function matchesDiscoveryFilter(
  model: unknown,
  filter: ProviderModelDiscoveryFilter
): boolean {
  if (!filter.path) {
    throw new Error("Provider model discovery filter path is required");
  }

  const value = discoveryValueAtPath(model, filter.path);
  let predicates = 0;

  if (filter.equals !== undefined) {
    predicates += 1;
    if (!primitiveEquals(value, filter.equals)) return false;
  }
  if (filter.notEquals !== undefined) {
    predicates += 1;
    if (primitiveEquals(value, filter.notEquals)) return false;
  }
  if (filter.in !== undefined) {
    predicates += 1;
    if (!filter.in.some((candidate) => primitiveEquals(value, candidate))) {
      return false;
    }
  }
  if (filter.notIn !== undefined) {
    predicates += 1;
    if (filter.notIn.some((candidate) => primitiveEquals(value, candidate))) {
      return false;
    }
  }
  if (filter.exists !== undefined) {
    predicates += 1;
    if ((value !== undefined) !== filter.exists) return false;
  }

  if (predicates === 0) {
    throw new Error(
      `Provider model discovery filter ${filter.path} has no predicate`
    );
  }
  return true;
}

export function resolveProviderModelCatalogIdentity(
  model: unknown,
  manifest: ProviderManifest | null | undefined
): string | null {
  const identity = manifest?.models?.discovery?.catalogIdentity;
  if (!identity?.field) return null;

  const raw = discoveryValueAtPath(model, identity.field);
  if (typeof raw !== "string") return null;
  let candidate = raw.trim();
  if (!candidate) return null;

  if (identity.stripPrefix !== undefined) {
    if (!identity.stripPrefix || !candidate.startsWith(identity.stripPrefix)) {
      return null;
    }
    candidate = candidate.slice(identity.stripPrefix.length);
  }

  candidate = candidate.split(/[?#]/, 1)[0]?.replace(/^\/+|\/+$/g, "") ?? "";
  const segments = candidate.split("/");
  const minimumSegments = identity.minimumSegments ?? 1;
  if (
    !Number.isInteger(minimumSegments)
    || minimumSegments <= 0
    || segments.some((segment) => !segment)
    || segments.length < minimumSegments
  ) {
    return null;
  }
  return candidate;
}

export function resolveProviderModelDiscoveryUrl(
  manifest: ProviderManifest
): URL {
  const discovery = manifest.models?.discovery;
  const endpoint = manifest.endpoints?.models || "/models";
  const rawUrl =
    discovery?.url
    || `${manifest.baseUrl.replace(/\/$/, "")}${endpoint}`;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderModelDiscoveryError(
      manifest.id,
      "has an invalid endpoint"
    );
  }

  for (const [key, value] of Object.entries(discovery?.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const pagination = discovery?.pagination;
  if (
    pagination
    && (!pagination.cursorParam || !pagination.cursorPath)
  ) {
    throw new ProviderModelDiscoveryError(
      manifest.id,
      "has invalid cursor pagination configuration"
    );
  }
  if (pagination?.pageSizeParam || pagination?.pageSize !== undefined) {
    if (
      !pagination.pageSizeParam
      || !Number.isInteger(pagination.pageSize)
      || (pagination.pageSize ?? 0) <= 0
    ) {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        "has invalid page-size configuration"
      );
    }
    url.searchParams.set(
      pagination.pageSizeParam,
      String(pagination.pageSize)
    );
  }

  return url;
}

function pageModels(
  providerId: string,
  json: unknown,
  listPath: string
): unknown[] {
  const extracted = discoveryValueAtPath(json, listPath);
  if (Array.isArray(extracted)) return extracted;
  if (Array.isArray(json)) return json;
  throw new ProviderModelDiscoveryError(
    providerId,
    `returned a non-array model list at ${listPath}`
  );
}

function nextPageCursor(
  manifest: ProviderManifest,
  json: unknown
): string | null {
  const pagination = manifest.models?.discovery?.pagination;
  if (!pagination) return null;

  const cursor = discoveryValueAtPath(json, pagination.cursorPath);
  if (
    cursor !== undefined
    && cursor !== null
    && typeof cursor !== "string"
  ) {
    throw new ProviderModelDiscoveryError(
      manifest.id,
      `returned a non-string cursor at ${pagination.cursorPath}`
    );
  }

  if (pagination.hasMorePath) {
    const hasMore = discoveryValueAtPath(json, pagination.hasMorePath);
    if (typeof hasMore !== "boolean") {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        `returned no boolean at ${pagination.hasMorePath}`
      );
    }
    if (!hasMore) return null;
    if (!cursor) {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        "reported another page without a cursor"
      );
    }
    return cursor;
  }

  return cursor || null;
}

function deduplicateModels(
  manifest: ProviderManifest,
  models: unknown[]
): UnknownRecord[] {
  const discovery = manifest.models?.discovery;
  const idPath = discovery?.idField || "id";
  const seen = new Set<string>();
  const unique: UnknownRecord[] = [];

  for (const model of models) {
    if (!isRecord(model)) continue;
    const id = discoveryValueAtPath(model, idPath);
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    unique.push(model);
  }

  return unique;
}

export async function fetchProviderModels(
  manifest: ProviderManifest,
  credential: string,
  fetchImplementation: FetchImplementation = fetch
): Promise<UnknownRecord[]> {
  const discovery = manifest.models?.discovery;
  const url = resolveProviderModelDiscoveryUrl(manifest);
  const headers: Record<string, string> = {
    ...(manifest.headers || {}),
    ...providerAuthHeaders(manifest, credential),
  };
  const pagination = discovery?.pagination;
  const maxPages = pagination?.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages <= 0 || maxPages > 1000) {
    throw new ProviderModelDiscoveryError(
      manifest.id,
      "has invalid maximum-page configuration"
    );
  }

  const cursors = new Set<string>();
  const models: unknown[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        "request failed"
      );
    }
    if (!response.ok) {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        `returned HTTP ${response.status}`,
        response.status
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        "returned invalid JSON"
      );
    }

    models.push(
      ...pageModels(
        manifest.id,
        json,
        discovery?.listPath || DEFAULT_LIST_PATH
      )
    );

    const cursor = nextPageCursor(manifest, json);
    if (!cursor) break;
    if (cursors.has(cursor)) {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        "returned a repeated page cursor"
      );
    }
    if (page === maxPages) {
      throw new ProviderModelDiscoveryError(
        manifest.id,
        `exceeded ${maxPages} pages`
      );
    }
    cursors.add(cursor);
    url.searchParams.set(pagination!.cursorParam, cursor);
  }

  const eligible = discovery?.filters?.length
    ? models.filter((model) =>
        discovery.filters!.every((filter) =>
          matchesDiscoveryFilter(model, filter)
        )
      )
    : models;

  return deduplicateModels(manifest, eligible);
}
