import { expect, test } from "bun:test";
import { modelLabel } from "@pointer/contracts/model-label";

test("readable labels preserve explicit names, custom IDs and exact route versions", () => {
  expect(modelLabel({ id: "gpt-6.1-sol" })).toBe("GPT-6.1 Sol");
  expect(modelLabel({ id: "glm-5.3-flash", namespaced: "go/glm-5.3-flash", displayName: "go/glm-5.3-flash", displayNameSource: "fallback" })).toBe("GLM-5.3 Flash");
  expect(modelLabel({ id: "kimi-k2.7-code" })).toBe("Kimi K2.7 Code");
  expect(modelLabel({ id: "mimo-v2.6-pro" })).toBe("MiMo V2.6 Pro");
  expect(modelLabel({ id: "gpt-6-sol", displayName: "My private selection", displayNameSource: "operator" })).toBe("My private selection");
  expect(modelLabel({ id: "lab/arbitrary-architecture:q4" })).toBe("lab/arbitrary-architecture:q4");
  expect(modelLabel({ id: "deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash (provider name)", displayNameSource: "provider" })).toBe("DeepSeek V4.1 Flash (provider name)");
});
