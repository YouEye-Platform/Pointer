import { describe, expect, test } from "bun:test";
import { loadManifests } from "../providers/manifest-loader";
import type { ProviderManifest } from "../providers/types";
import { resolveDiscoveredModelCapabilities } from "./model-capabilities";

function manifest(
  capabilityFallbacks: NonNullable<
    NonNullable<ProviderManifest["models"]>["capabilityFallbacks"]
  >
): ProviderManifest {
  return {
    id: "subscription-provider",
    name: "Subscription Provider",
    type: "openai-compatible",
    baseUrl: "https://provider.example.test/v1",
    auth: { type: "oauth-device-flow" },
    models: { capabilityFallbacks },
  };
}

describe("discovered model capability fallbacks", () => {
  test("fills omitted capabilities for an exact model ID", () => {
    const capabilities = resolveDiscoveredModelCapabilities(
      {},
      manifest([
        {
          modelId: "grok-4.5",
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: false,
        },
      ]),
      "GROK-4.5"
    );

    expect(capabilities).toEqual({
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: false,
    });
  });

  test("keeps explicit provider booleans authoritative", () => {
    const capabilities = resolveDiscoveredModelCapabilities(
      {
        supportsTools: false,
        supports_vision: false,
        supports_streaming: true,
      },
      manifest([
        {
          modelId: "grok-4.5",
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: false,
        },
      ]),
      "grok-4.5"
    );

    expect(capabilities).toEqual({
      supportsTools: false,
      supportsVision: false,
      supportsStreaming: true,
    });
  });

  test("retains supported-parameter inference ahead of fallbacks", () => {
    const capabilities = resolveDiscoveredModelCapabilities(
      { supported_parameters: ["tools", "vision"] },
      manifest([
        {
          modelId: "model-a",
          supportsTools: false,
          supportsVision: false,
        },
      ]),
      "model-a"
    );

    expect(capabilities.supportsTools).toBe(true);
    expect(capabilities.supportsVision).toBe(true);
  });

  test("maps provider-declared image-input capability without model IDs", () => {
    const capabilities = resolveDiscoveredModelCapabilities(
      { supportsImageInput: true },
      manifest([]),
      "new-dynamic-model"
    );

    expect(capabilities.supportsVision).toBe(true);
  });

  test("does not leak a fallback onto another model", () => {
    const capabilities = resolveDiscoveredModelCapabilities(
      {},
      manifest([{ modelId: "grok-4.5", supportsVision: true }]),
      "grok-text-only"
    );

    expect(capabilities).toEqual({
      supportsTools: false,
      supportsVision: false,
      supportsStreaming: true,
    });
  });

  test("declares the documented Grok 4.5 vision fallback in its manifest", async () => {
    const grok = (await loadManifests()).find(
      (candidate) => candidate.id === "xai-grok"
    );

    expect(grok).toBeDefined();
    expect(
      resolveDiscoveredModelCapabilities({}, grok!, "grok-4.5").supportsVision
    ).toBe(true);
  });
});
