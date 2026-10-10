import { expect, test } from "bun:test";
import { engineModelMetadata } from "./engine-model-metadata";

test("engine discovery retains reasoning support and supported efforts for native clients", () => {
  expect(engineModelMetadata({ namespaced: "fixture/model", supportsReasoning: true, reasoningEfforts: ["low", "high", "max"] }))
    .toEqual({ engineSelector: "fixture/model", supportsReasoning: true, wireCapabilities: { reasoningEfforts: ["low", "high", "max"] } });
});
test("unknown capabilities remain unknown; explicit denials and future effort values do not invent support", () => {
  expect(engineModelMetadata({ namespaced: "fixture/model" })).toEqual({ engineSelector: "fixture/model" });
  expect(engineModelMetadata({ namespaced: "fixture/model", supportsTools: false, supportsReasoning: false, reasoningEfforts: ["high"] }))
    .toEqual({ engineSelector: "fixture/model", supportsTools: false, supportsReasoning: false });
  expect(engineModelMetadata({ namespaced: "fixture/model", supportsReasoning: true, reasoningEfforts: ["future", "low"] }).wireCapabilities)
    .toEqual({ reasoningEfforts: ["low"] });
});
