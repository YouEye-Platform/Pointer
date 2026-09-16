import { describe, expect, test } from "bun:test";
import { loadManifests } from "./manifest-loader";
import {
  fetchProviderModels,
  matchesDiscoveryFilter,
  ProviderModelDiscoveryError,
  resolveProviderModelCatalogIdentity,
  resolveProviderModelDiscoveryUrl,
} from "./model-discovery";
import type { ProviderManifest } from "./types";

function manifest(
  overrides: Partial<ProviderManifest> = {}
): ProviderManifest {
  return {
    id: "provider",
    name: "Provider",
    type: "openai-compatible",
    baseUrl: "https://inference.example.test/v1",
    auth: { type: "bearer" },
    endpoints: { models: "/models" },
    models: {
      discovery: {
        enabled: true,
        listPath: "data",
        idField: "id",
      },
    },
    ...overrides,
  };
}

function mockFetch(
  responses: Array<{ status?: number; body: unknown }>,
  calls: Array<{ url: string; init?: RequestInit }>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("provider model discovery", () => {
  test("derives provider-declared catalogue identity without changing the routing ID", () => {
    const provider = manifest({
      models: {
        discovery: {
          enabled: true,
          catalogIdentity: {
            field: "metadata.identityUrl",
            stripPrefix: "https://catalog.example.test/",
            minimumSegments: 2,
          },
        },
      },
    });

    expect(resolveProviderModelCatalogIdentity({
      id: "accounts/provider/models/model-a",
      metadata: {
        identityUrl: "https://catalog.example.test/acme/model-a?revision=main",
      },
    }, provider)).toBe("acme/model-a");
    expect(resolveProviderModelCatalogIdentity({
      metadata: { identityUrl: "https://catalog.example.test/acme/" },
    }, provider)).toBeNull();
    expect(resolveProviderModelCatalogIdentity({
      metadata: { identityUrl: "https://other.example.test/acme/model-a" },
    }, provider)).toBeNull();
    expect(resolveProviderModelCatalogIdentity({
      metadata: { identityUrl: "https://catalog.example.test/acme//model-a" },
    }, provider)).toBeNull();
    expect(resolveProviderModelCatalogIdentity({}, provider)).toBeNull();
  });

  test("uses a discovery URL override, static query, token pagination, filters, and deduplication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = manifest({
      id: "fireworks",
      headers: { "X-Title": "Pointer" },
      models: {
        discovery: {
          enabled: true,
          url: "https://catalog.example.test/v1/accounts/fireworks/models",
          query: { filter: "supports_serverless=true" },
          listPath: "models",
          idField: "name",
          filters: [
            { path: "state", equals: "READY" },
            { path: "status.code", equals: "OK" },
            { path: "kind", notEquals: "EMBEDDING_MODEL" },
          ],
          pagination: {
            cursorParam: "pageToken",
            cursorPath: "nextPageToken",
            pageSizeParam: "pageSize",
            pageSize: 200,
          },
        },
      },
    });

    const models = await fetchProviderModels(
      provider,
      "secret-credential",
      mockFetch(
        [
          {
            body: {
              models: [
                {
                  name: "accounts/fireworks/models/model-a",
                  state: "READY",
                  status: { code: "OK" },
                  kind: "HF_BASE_MODEL",
                },
                {
                  name: "accounts/fireworks/models/embedding-a",
                  state: "READY",
                  status: { code: "OK" },
                  kind: "EMBEDDING_MODEL",
                },
                {
                  name: "accounts/fireworks/models/unhealthy-a",
                  state: "READY",
                  status: { code: "INTERNAL" },
                  kind: "HF_BASE_MODEL",
                },
              ],
              nextPageToken: "next-page",
            },
          },
          {
            body: {
              models: [
                {
                  name: "accounts/fireworks/models/model-a",
                  state: "READY",
                  status: { code: "OK" },
                  kind: "HF_BASE_MODEL",
                },
                {
                  name: "accounts/fireworks/models/model-b",
                  state: "READY",
                  status: { code: "OK" },
                  kind: "CUSTOM_MODEL",
                },
              ],
            },
          },
        ],
        calls
      )
    );

    expect(models.map((model) => model.name)).toEqual([
      "accounts/fireworks/models/model-a",
      "accounts/fireworks/models/model-b",
    ]);
    expect(calls).toHaveLength(2);

    const first = new URL(calls[0].url);
    expect(first.origin + first.pathname).toBe(
      "https://catalog.example.test/v1/accounts/fireworks/models"
    );
    expect(first.searchParams.get("filter")).toBe("supports_serverless=true");
    expect(first.searchParams.get("pageSize")).toBe("200");
    expect(first.searchParams.has("pageToken")).toBe(false);

    const second = new URL(calls[1].url);
    expect(second.searchParams.get("pageToken")).toBe("next-page");
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(calls[0].init?.headers).toEqual({
      "X-Title": "Pointer",
      Authorization: "Bearer secret-credential",
    });
    expect(calls.every((call) => !call.url.includes("secret-credential"))).toBe(
      true
    );
  });

  test("follows boolean/cursor pagination and preserves Anthropic authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = manifest({
      id: "anthropic",
      type: "anthropic-compatible",
      baseUrl: "https://api.anthropic.com",
      auth: { type: "bearer" },
      endpoints: { models: "/v1/models" },
      models: {
        discovery: {
          enabled: true,
          listPath: "data",
          idField: "id",
          pagination: {
            cursorParam: "after_id",
            cursorPath: "last_id",
            hasMorePath: "has_more",
            pageSizeParam: "limit",
            pageSize: 1000,
          },
        },
      },
    });

    const models = await fetchProviderModels(
      provider,
      "anthropic-secret",
      mockFetch(
        [
          {
            body: {
              data: [{ id: "model-a" }],
              has_more: true,
              last_id: "model-a",
            },
          },
          {
            body: {
              data: [{ id: "model-b" }],
              has_more: false,
              last_id: "model-b",
            },
          },
        ],
        calls
      )
    );

    expect(models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("1000");
    expect(new URL(calls[1].url).searchParams.get("after_id")).toBe(
      "model-a"
    );
    expect(calls[0].init?.headers).toEqual({
      "x-api-key": "anthropic-secret",
      "anthropic-version": "2023-06-01",
    });
  });

  test("accepts a root-array response and nested primitive predicates", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = manifest({
      models: {
        discovery: {
          enabled: true,
          listPath: "data",
          idField: "id",
          filters: [
            { path: "capabilities.completion_chat", equals: true },
            { path: "archived", notEquals: true },
            { path: "kind", in: ["base", "fine-tuned"] },
            { path: "visibility", notIn: ["private"] },
            { path: "id", exists: true },
          ],
        },
      },
    });

    const models = await fetchProviderModels(
      provider,
      "credential",
      mockFetch(
        [
          {
            body: [
              {
                id: "model-a",
                capabilities: { completion_chat: true },
                archived: false,
                kind: "base",
              },
              {
                id: "model-b",
                capabilities: { completion_chat: false },
                archived: false,
                kind: "base",
              },
            ],
          },
        ],
        calls
      )
    );

    expect(models.map((model) => model.id)).toEqual(["model-a"]);
    expect(matchesDiscoveryFilter({ value: null }, {
      path: "value",
      equals: null,
    })).toBe(true);
  });

  test("rejects incomplete, repeated, excessive, and malformed pagination", async () => {
    const basePagination = {
      cursorParam: "after",
      cursorPath: "next",
      hasMorePath: "has_more",
      maxPages: 2,
    };

    await expect(fetchProviderModels(
      manifest({
        models: {
          discovery: {
            enabled: true,
            listPath: "data",
            idField: "id",
            pagination: { ...basePagination, maxPages: 3 },
          },
        },
      }),
      "credential",
      mockFetch(
        [{ body: { data: [{ id: "a" }], has_more: true } }],
        []
      )
    )).rejects.toThrow("reported another page without a cursor");

    await expect(fetchProviderModels(
      manifest({
        models: {
          discovery: {
            enabled: true,
            listPath: "data",
            idField: "id",
            pagination: basePagination,
          },
        },
      }),
      "credential",
      mockFetch(
        [
          { body: { data: [{ id: "a" }], has_more: true, next: "same" } },
          { body: { data: [{ id: "b" }], has_more: true, next: "same" } },
        ],
        []
      )
    )).rejects.toThrow("returned a repeated page cursor");

    await expect(fetchProviderModels(
      manifest({
        models: {
          discovery: {
            enabled: true,
            listPath: "data",
            idField: "id",
            pagination: basePagination,
          },
        },
      }),
      "credential",
      mockFetch(
        [
          { body: { data: [{ id: "a" }], has_more: true, next: "page-2" } },
          { body: { data: [{ id: "b" }], has_more: true, next: "page-3" } },
        ],
        []
      )
    )).rejects.toThrow("exceeded 2 pages");

    await expect(fetchProviderModels(
      manifest(),
      "credential",
      mockFetch([{ body: { data: { id: "not-an-array" } } }], [])
    )).rejects.toThrow("returned a non-array model list");
  });

  test("reports safe upstream failures without returning bodies or credentials", async () => {
    const error = await fetchProviderModels(
      manifest({ id: "safe-provider" }),
      "credential-that-must-not-leak",
      mockFetch(
        [{
          status: 401,
          body: {
            error: "raw-upstream-body-that-must-not-leak",
          },
        }],
        []
      )
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderModelDiscoveryError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("safe-provider");
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain("credential-that-must-not-leak");
    expect(error.message).not.toContain("raw-upstream-body-that-must-not-leak");
  });

  test("validates page-size and filter configuration", async () => {
    expect(() => resolveProviderModelDiscoveryUrl(manifest({
      models: {
        discovery: {
          enabled: true,
          pagination: {
            cursorParam: "cursor",
            cursorPath: "next",
            pageSizeParam: "limit",
          },
        },
      },
    }))).toThrow("invalid page-size configuration");

    expect(() => matchesDiscoveryFilter(
      { id: "model-a" },
      { path: "id" }
    )).toThrow("has no predicate");
  });
});

describe("built-in provider discovery contracts", () => {
  test("declares current dynamic provider contracts without model ID inventories", async () => {
    const manifests = await loadManifests();
    const byId = new Map(manifests.map((candidate) => [
      candidate.id,
      candidate,
    ]));

    expect(manifests).toHaveLength(19);
    for (const id of [
      "custom-openai-compatible",
      "custom-anthropic-compatible",
      "custom-google-gemini-compatible",
    ]) {
      expect(byId.get(id)?.endpoint?.mode).toBe("required");
      expect(byId.get(id)?.models?.discovery?.enabled).toBe(true);
    }

    const fireworks = byId.get("fireworks")!;
    expect(fireworks.models?.discovery).toMatchObject({
      url: "https://api.fireworks.ai/v1/accounts/fireworks/models",
      query: { filter: "supports_serverless=true" },
      listPath: "models",
      idField: "name",
      nameField: "displayName",
      catalogIdentity: {
        field: "huggingFaceUrl",
        stripPrefix: "https://huggingface.co/",
        minimumSegments: 2,
      },
      pagination: {
        cursorParam: "pageToken",
        cursorPath: "nextPageToken",
        pageSize: 200,
      },
    });
    expect(fireworks.models?.static ?? []).toHaveLength(0);

    expect(byId.get("anthropic")?.models?.discovery?.pagination).toMatchObject({
      cursorParam: "after_id",
      cursorPath: "last_id",
      hasMorePath: "has_more",
      pageSize: 1000,
    });
    expect(byId.get("zai")?.baseUrl).toBe(
      "https://api.z.ai/api/paas/v4"
    );
    expect(byId.get("xai")?.endpoints?.models).toBe("/language-models");
    expect(byId.get("xai")?.models?.discovery?.listPath).toBe("models");
    expect(byId.get("kimi")?.baseUrl).toBe(
      "https://api.moonshot.ai/v1"
    );
    expect(byId.get("openrouter")?.endpoints?.models).toBe("/models/user");
    expect(byId.get("mistral")?.models?.discovery?.filters).toContainEqual({
      path: "capabilities.completion_chat",
      equals: true,
    });
    expect(byId.get("together")?.models?.discovery?.filters).toContainEqual({
      path: "type",
      equals: "chat",
    });

    for (const candidate of manifests) {
      const discoveryUrl = resolveProviderModelDiscoveryUrl(candidate);
      expect(discoveryUrl.protocol).toBe("https:");
      expect(discoveryUrl.pathname).not.toMatch(
        /\/(chat\/completions|responses|messages)$/
      );
    }
  });
});
