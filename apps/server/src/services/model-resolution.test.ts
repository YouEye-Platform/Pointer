import { describe, expect, test } from "bun:test";
import {
  buildModelIndex,
  buildProviderModelLookup,
  type ModelEntry,
  type ModelIndexInput,
  type ProviderModelLookupRow,
} from "./model-resolution";
import {
  isReservedModelAlias,
  normalizeManualModelAlias,
  normalizeModelLookupKey,
  POSITIONAL_MODEL_ALIASES,
} from "./model-aliases";

function providerModel(overrides: Partial<ProviderModelLookupRow> = {}): ProviderModelLookupRow {
  return {
    id: "provider-model-deepseek-v3",
    providerId: "deepinfra",
    modelId: "deepseek-ai/DeepSeek-V3",
    providerModelId: "deepseek-ai/DeepSeek-V3",
    canonicalModelId: "deepseek/deepseek-chat",
    catalogEntityId: "model/deepseek-chat",
    inputPrice: null,
    outputPrice: null,
    contextWindow: 128_000,
    maxOutput: null,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    nativeFormat: null,
    nativeEndpoint: null,
    ...overrides,
  };
}

function modelEntry(name: string, modelId: string, providerId: string): ModelEntry {
  return {
    displayName: name,
    modelId,
    providerId,
    providerAccountId: null,
    providerModelId: `raw/${modelId}`,
    catalogEntityId: `entity/${modelId}`,
    nativeFormat: null,
    nativeEndpoint: null,
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputPrice: 1,
    outputPrice: 2,
    providerMethods: [],
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
    },
  };
}

function indexInput(name: string, modelId: string, providerId: string): ModelIndexInput {
  return {
    displayName: name,
    modelId,
    providerId,
    entry: modelEntry(name, modelId, providerId),
  };
}

describe("provider model lookup", () => {
  test("resolves a canonical catalog ID to the provider's raw model ID", () => {
    const row = providerModel();
    const lookup = buildProviderModelLookup([row]);

    expect(lookup("deepinfra", "deepseek/deepseek-chat")?.providerModelId).toBe("deepseek-ai/DeepSeek-V3");
    expect(lookup("deepinfra", "deepseek/deepseek-chat")?.catalogEntityId).toBe("model/deepseek-chat");
  });

  test("continues to resolve explicit provider and raw IDs case-insensitively", () => {
    const row = providerModel();
    const lookup = buildProviderModelLookup([row]);

    expect(lookup("deepinfra", "DEEPSEEK-AI/DEEPSEEK-V3")).toBe(row);
    expect(lookup("deepinfra", "deepseek-ai/deepseek-v3")).toBe(row);
    expect(lookup("openrouter", "deepseek/deepseek-chat")).toBeNull();
  });

  test("prefers the exact provider-model key and catalog entity identity", () => {
    const first = providerModel();
    const second = providerModel({
      id: "provider-model-deepseek-r1",
      modelId: "deepseek-ai/DeepSeek-R1",
      providerModelId: "deepseek-ai/DeepSeek-R1",
      canonicalModelId: "deepseek/deepseek-reasoner",
      catalogEntityId: "model/deepseek-reasoner",
    });
    const lookup = buildProviderModelLookup([first, second]);

    expect(lookup("deepinfra", "provider-model-deepseek-r1")).toBe(second);
    expect(lookup("deepinfra", "model/deepseek-reasoner")).toBe(second);
    expect(lookup("deepinfra", "model/deepseek-chat")).toBe(first);
  });
});

describe("hidden positional model aliases", () => {
  test("maps all role vocabularies onto the first three group entries without advertising them", () => {
    const inputs = [
      indexInput("GPT 5.5", "gpt-5.5", "openai-codex"),
      indexInput("Grok 4.5", "grok-4.5", "xai"),
      indexInput("Claude Utility", "claude-utility", "openrouter"),
    ];
    const index = buildModelIndex(inputs, inputs);

    expect(index.advertisedModels.map((entry) => entry.displayName)).toEqual([
      "GPT 5.5",
      "Grok 4.5",
      "Claude Utility",
    ]);
    expect(index.advertisedModels.map((entry) => normalizeModelLookupKey(entry.displayName)))
      .not.toContain("default");

    for (const [slot, aliases] of POSITIONAL_MODEL_ALIASES.entries()) {
      for (const alias of aliases) {
        expect(index.routesByName.get(alias)?.modelId).toBe(inputs[slot]?.modelId);
      }
    }
  });

  test("creates aliases only for available group slots", () => {
    const first = indexInput("First", "first", "provider-a");
    const second = indexInput("Second", "second", "provider-b");

    const empty = buildModelIndex([], []);
    expect(empty.routesByName.size).toBe(0);

    const one = buildModelIndex([first], [first]);
    expect(one.routesByName.get("opus")?.modelId).toBe("first");
    expect(one.routesByName.has("sonnet")).toBe(false);

    const two = buildModelIndex([first, second], [first, second]);
    expect(two.routesByName.get("sonnet")?.modelId).toBe("second");
    expect(two.routesByName.has("haiku")).toBe(false);
  });

  test("does not assign role aliases to custom or provider-toggled advertised models", () => {
    const group = indexInput("Group model", "group", "provider-a");
    const custom = indexInput("Custom", "custom", "provider-b");
    const toggled = indexInput("provider-c/toggled", "toggled", "provider-c");
    const index = buildModelIndex([group, custom, toggled], [group]);

    expect(index.routesByName.get("default")?.modelId).toBe("group");
    expect(index.routesByName.has("secondary")).toBe(false);
    expect(index.routesByName.get("custom")?.modelId).toBe("custom");
    expect(index.routesByName.get("provider-c/toggled")?.modelId).toBe("toggled");
  });

  test("fails closed when a public model name is reserved", () => {
    const catalogCollision = indexInput("Default", "model-named-default", "provider-a");
    const first = indexInput("Actual first", "first", "provider-b");

    expect(() => buildModelIndex([catalogCollision, first], [first]))
      .toThrow("Public model name is reserved");
  });

  test("fails closed when public model names collide", () => {
    const first = indexInput("Same", "model-a", "provider-a");
    const second = indexInput("Same", "model-b", "provider-a");

    expect(() => buildModelIndex([first, second], [first, second]))
      .toThrow("Duplicate public model name");
  });

  test("keeps the same model from multiple accounts requestable through explicit aliases", () => {
    const first = indexInput("Same", "model-a", "provider-a");
    const second = indexInput("Same Backup", "model-a", "provider-a");
    second.entry.providerAccountId = "account-b";
    const index = buildModelIndex([first, second], [first, second]);

    expect(index.advertisedModels.map((entry) => entry.displayName)).toEqual(["Same", "Same Backup"]);
    expect(index.routesByName.get("same backup")?.providerAccountId).toBe("account-b");
  });

  test("normalizes lookup keys and manual aliases without accepting reserved aliases", () => {
    expect(normalizeModelLookupKey("  OpUs ")).toBe("opus");
    expect(normalizeManualModelAlias("  My Alias  ")).toBe("My Alias");
    expect(normalizeManualModelAlias("   ")).toBeNull();
    expect(isReservedModelAlias("  Utility ")).toBe(true);
    expect(isReservedModelAlias("My Utility")).toBe(false);
  });
});
