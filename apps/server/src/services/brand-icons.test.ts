import { describe, expect, test } from "bun:test";
import { resolveModelIconKey, resolveProviderIconKey } from "./brand-icons";

describe("brand icon identity", () => {
  test("normalizes built-in provider manifests to stable brand keys", () => {
    expect(resolveProviderIconKey({
      id: "google-gemini-r4nd0m",
      manifestPath: "providers.d/google-gemini.yaml",
    })).toBe("gemini");
    expect(resolveProviderIconKey({
      id: "openai-codex-r4nd0m",
      manifestPath: "providers.d/openai-codex.yaml",
    })).toBe("openai");
    expect(resolveProviderIconKey({
      id: "zai-r4nd0m",
      manifestPath: "providers.d/zai.yaml",
    })).toBe("zhipu");
    expect(resolveProviderIconKey({
      id: "xai-grok-r4nd0m",
      manifestPath: "providers.d/xai-grok.yaml",
    })).toBe("grok");
  });

  test("keeps a deterministic key for custom providers", () => {
    expect(resolveProviderIconKey({ id: "my-compatible-api-a1b2c3" })).toBe("my-compatible-api");
  });

  test("prefers a model-family icon over its creator icon", () => {
    expect(resolveModelIconKey({
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      creator: "Anthropic",
    })).toBe("claude");
    expect(resolveModelIconKey({
      id: "google/gemma-3-27b",
      name: "Gemma 3 27B",
      creator: "Google",
    })).toBe("gemma");
    expect(resolveModelIconKey({
      id: "openai/o3",
      name: "o3",
      creator: "OpenAI",
    })).toBe("openai");
  });

  test("falls back to a known creator and leaves unknown identities neutral", () => {
    expect(resolveModelIconKey({
      id: "meta/experimental",
      name: "Experimental",
      creator: "Meta",
    })).toBe("meta");
    expect(resolveModelIconKey({
      id: "local/custom",
      name: "Custom Model",
      creator: "Example Labs",
    })).toBeNull();
  });
});
