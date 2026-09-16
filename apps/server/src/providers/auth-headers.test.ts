import { describe, expect, test } from "bun:test";
import { providerAuthHeaders } from "./auth-headers";
import type { ProviderManifest } from "./types";

function manifest(
  overrides: Partial<ProviderManifest>
): ProviderManifest {
  return {
    id: "provider",
    name: "Provider",
    type: "openai-compatible",
    baseUrl: "https://api.example.test",
    auth: { type: "bearer" },
    ...overrides,
  };
}

describe("provider authentication headers", () => {
  test("preserves Anthropic-compatible x-api-key authentication", () => {
    expect(providerAuthHeaders(
      manifest({ type: "anthropic-compatible" }),
      "anthropic-key"
    )).toEqual({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01",
    });
  });

  test("uses bearer authentication for OpenAI-compatible API and OAuth providers", () => {
    expect(providerAuthHeaders(manifest({}), "api-key")).toEqual({
      Authorization: "Bearer api-key",
    });
    expect(providerAuthHeaders(
      manifest({ auth: { type: "oauth-device-flow" } }),
      "access-token"
    )).toEqual({
      Authorization: "Bearer access-token",
    });
  });

  test("honors explicit custom header authentication", () => {
    expect(providerAuthHeaders(
      manifest({ auth: { type: "header", header: "x-provider-key" } }),
      "api-key"
    )).toEqual({ "x-provider-key": "api-key" });
    expect(providerAuthHeaders(
      manifest({ auth: { type: "header", header: "x-goog-api-key" } }),
      "api-key"
    )).toEqual({ "x-goog-api-key": "api-key" });
  });
});
