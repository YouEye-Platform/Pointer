import { describe, expect, test } from "bun:test";
import { catalogApiProviderSchema } from "./catalog-contracts";

const provider = {
  providerModelKey: "provider-model-1",
  providerId: "provider-a",
  providerName: "Provider A",
  providerIconKey: null,
  rawModelId: "provider/model-a",
  pricing: { input: null, output: null, currency: "USD" as const, source: null, fetchedAt: null },
  capabilities: { tools: true, vision: false, streaming: true },
  contextWindow: 128_000,
  maxOutput: 8_192,
  available: true,
  accounts: [{ id: "account-a", nickname: null }],
};

describe("catalog provider API contract", () => {
  test("requires exact provider-model identity and binary user availability", () => {
    expect(catalogApiProviderSchema.parse(provider)).toEqual(provider);
    expect(catalogApiProviderSchema.safeParse({ ...provider, providerModelKey: undefined }).success).toBe(false);
    expect(catalogApiProviderSchema.safeParse({ ...provider, available: undefined }).success).toBe(false);
  });

  test("rejects obsolete instance and credential-derived availability fields", () => {
    const obsoleteCredentialField = ["credential", "Usable"].join("");
    expect(catalogApiProviderSchema.safeParse({
      ...provider,
      availability: {
        configured: true,
        [obsoleteCredentialField]: true,
        instances: ["instance-a"],
      },
    }).success).toBe(false);
  });
});
