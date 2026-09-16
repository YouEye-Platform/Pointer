import { describe, expect, test } from "bun:test";
import {
  MODEL_FIELD_PRECEDENCE,
  buildModelMatchIndex,
  friendlyModelName,
  matchCanonicalModel,
  normalizeModelAggressive,
  normalizeModelLight,
} from "./model-identity";

const identities = [
  { id: "openai/gpt-4o-2024-08-06", name: "GPT-4o (2024-08-06)" },
  { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
  { id: "google/gemini-pro-1.5", name: "Gemini Pro 1.5" },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
];

describe("model identity normalization", () => {
  test("covers provider prefixes, dots, underscores, dates, thinking and free variants", () => {
    expect(normalizeModelLight("openai/gpt_4o_2024-08-06:free")).toBe("gpt-4o-2024-08-06");
    expect(normalizeModelAggressive("openai/gpt_4o_2024-08-06:free")).toBe("gpt-4o");
    expect(normalizeModelAggressive("anthropic.claude-3.7-sonnet-thinking")).toBe("claude-3-7-sonnet");
    expect(normalizeModelAggressive("Claude 3.7 Sonnet (32k thinking)")).toBe("claude-3-7-sonnet");
  });

  test("resolves known manual aliases", () => {
    const match = matchCanonicalModel("Gemini 1.5 Pro", buildModelMatchIndex(identities));
    expect(match).toEqual({ status: "matched", canonicalId: "google/gemini-pro-1.5", strategy: "manual" });
    expect(matchCanonicalModel("deepseek-v3", buildModelMatchIndex(identities))).toMatchObject({
      status: "matched",
      canonicalId: "deepseek/deepseek-chat",
    });
  });

  test("reports aggressive collisions instead of choosing the first row", () => {
    const index = buildModelMatchIndex([
      { id: "vendor/model-a-2024", name: "Model A 2024" },
      { id: "vendor/model-a-2025", name: "Model A 2025" },
    ]);
    expect(matchCanonicalModel("model-a", index)).toEqual({
      status: "ambiguous",
      candidates: ["vendor/model-a-2024", "vendor/model-a-2025"],
      normalized: "model-a",
    });
  });

  test("creates a stable friendly name for provider-only raw IDs", () => {
    expect(friendlyModelName("provider/acme_super-model-v2:free")).toBe("Acme Super Model V2");
  });

  test("keeps reference and provider pricing in separate precedence fields", () => {
    expect(MODEL_FIELD_PRECEDENCE.referencePricing).toEqual(["openrouter"]);
    expect(MODEL_FIELD_PRECEDENCE.providerPricing).toEqual(["provider"]);
  });
});
