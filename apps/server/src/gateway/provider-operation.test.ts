import { describe, expect, test } from "bun:test";
import {
  buildProviderGatewayOperationUrl,
  resolveProviderGatewayEndpoint,
  resolveProviderGatewayOperation,
} from "./provider-operation";
import type { ProviderManifest } from "../providers/types";
import { loadManifests } from "../providers/manifest-loader";

function manifest(overrides: Partial<ProviderManifest>): ProviderManifest {
  return {
    id: "fixture",
    name: "Fixture",
    type: "openai-compatible",
    baseUrl: "https://fixtures.invalid",
    auth: { type: "bearer" },
    ...overrides,
  };
}

describe("provider gateway operations", () => {
  test("uses the explicit operation declaration", () => {
    expect(resolveProviderGatewayOperation(manifest({
      gateway: { operations: { generate: { format: "responses", endpoint: "/responses" } } },
    }))).toEqual({ operation: "generate", format: "responses", endpoint: "/responses", declaration: "manifest" });
  });

  test("the declared endpoint overrides a legacy endpoint for the same format", () => {
    expect(resolveProviderGatewayOperation(manifest({
      type: "anthropic-compatible",
      endpoints: { messages: "/v1/messages" },
      gateway: { operations: { generate: { format: "messages", endpoint: "/gateway/messages" } } },
    }))).toMatchObject({ endpoint: "/gateway/messages", declaration: "manifest" });
  });

  test("builds request URLs from the declared endpoint", () => {
    const configured = manifest({
      baseUrl: "https://fixtures.invalid/root/",
      endpoints: { chatCompletions: "/legacy/chat/completions" },
      gateway: { operations: { generate: { format: "responses", endpoint: "/gateway/responses" } } },
    });
    expect(resolveProviderGatewayEndpoint(configured)).toBe("/gateway/responses");
    expect(buildProviderGatewayOperationUrl(configured.baseUrl, configured)).toBe(
      "https://fixtures.invalid/root/gateway/responses",
    );
  });

  test("builds Anthropic request URLs from the declared endpoint", () => {
    const configured = manifest({
      type: "anthropic-compatible",
      baseUrl: "https://fixtures.invalid",
      endpoints: { messages: "/v1/messages" },
      gateway: { operations: { generate: { format: "messages", endpoint: "/gateway/messages" } } },
    });
    expect(buildProviderGatewayOperationUrl(configured.baseUrl, configured)).toBe(
      "https://fixtures.invalid/gateway/messages",
    );
  });

  test("builds encoded native Google operation URLs", () => {
    const configured = manifest({
      type: "custom",
      baseUrl: "https://generativelanguage.googleapis.com",
      gateway: {
        operations: {
          generate: {
            format: "google-generate-content",
            endpoint: "/v1beta/models/{model}:generateContent",
          },
          streamGenerate: {
            format: "google-generate-content",
            endpoint: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
          },
          countTokens: {
            format: "google-generate-content",
            endpoint: "/v1beta/models/{model}:countTokens",
          },
        },
      },
    });
    expect(buildProviderGatewayOperationUrl(
      configured.baseUrl,
      configured,
      "streamGenerate",
      "models/gemini 3/pro",
    )).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini%203%2Fpro:streamGenerateContent?alt=sse",
    );
    expect(buildProviderGatewayOperationUrl(
      configured.baseUrl,
      configured,
      "countTokens",
      "gemini-3-pro",
    )).toEndWith("/v1beta/models/gemini-3-pro:countTokens");
  });

  test("retains an explicit per-request endpoint override", () => {
    const configured = manifest({
      gateway: { operations: { generate: { format: "responses", endpoint: "/gateway/responses" } } },
    });
    expect(resolveProviderGatewayEndpoint(configured, "/explicit/override")).toBe(
      "/explicit/override",
    );
  });

  test("legacy custom providers use endpoints without inspecting auth", () => {
    const oauthChat = resolveProviderGatewayOperation(manifest({
      auth: { type: "oauth-device-flow" },
      endpoints: { chatCompletions: "/chat/completions" },
    }));
    expect(oauthChat.format).toBe("chat-completions");
    expect(oauthChat.declaration).toBe("inferred");
  });

  test("fails closed for an invalid explicit operation", () => {
    const invalid = manifest({
      gateway: { operations: { generate: { format: "responses", endpoint: "https://untrusted.invalid/responses" } } },
    });
    expect(() => resolveProviderGatewayOperation(invalid)).toThrow("Invalid generate gateway operation declaration");
  });

  test("every first-party provider declares its generation operation", async () => {
    const manifests = await loadManifests();
    expect(manifests.length).toBeGreaterThan(0);
    expect(manifests.filter((entry) => !entry.gateway?.operations.generate)).toEqual([]);
    for (const entry of manifests) {
      expect(resolveProviderGatewayOperation(entry).declaration).toBe("manifest");
    }
  });
});
