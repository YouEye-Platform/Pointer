import { describe, expect, test } from "bun:test";
import handler from "./google-gemini";
import type { ProviderManifest } from "../../src/providers/types";

const manifest: ProviderManifest = {
  id: "google-gemini",
  name: "Google Gemini",
  type: "custom",
  baseUrl: "https://generativelanguage.googleapis.com",
  auth: { type: "header", header: "x-goog-api-key" },
};

describe("native Google Gemini provider handler", () => {
  test("normalizes Google model resources without exposing the models prefix", () => {
    expect(handler.transformModelList?.([
      {
        name: "models/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        inputTokenLimit: 1_000_000,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { displayName: "invalid" },
    ], manifest)).toEqual([
      {
        id: "gemini-3-pro",
        name: "Gemini 3 Pro",
        contextWindow: 1_000_000,
        maxOutput: 65_536,
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: true,
        supportedGenerationMethods: ["generateContent", "countTokens"],
        nativeFormat: "google-generate-content",
      },
      {
        id: "gemini-embedding-001",
        name: "gemini-embedding-001",
        contextWindow: undefined,
        maxOutput: undefined,
        supportsStreaming: false,
        supportsTools: false,
        supportsVision: false,
        supportedGenerationMethods: ["embedContent"],
        nativeFormat: "google-generate-content",
      },
    ]);
  });
});
