import { describe, expect, test } from "bun:test";
import {
  parseProviderCredential,
  serializeOAuthCredential,
} from "./provider-credential-codec";

describe("provider credential envelopes", () => {
  test("preserves legacy API keys as opaque strings", () => {
    expect(parseProviderCredential("test-api-key")).toEqual({
      kind: "api-key",
      value: "test-api-key",
    });
  });

  test("round-trips a refreshable OAuth credential without changing its shape", () => {
    const serialized = serializeOAuthCredential(
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
        tokenType: "Bearer",
        scope: "openid offline_access",
        userId: "provider-user",
      },
      "https://auth.example.test",
      "public-client-id"
    );

    expect(parseProviderCredential(serialized)).toEqual({
      kind: "oauth2",
      value: {
        kind: "pointer-provider-oauth2",
        version: 1,
        issuer: "https://auth.example.test",
        clientId: "public-client-id",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
        tokenType: "Bearer",
        scope: "openid offline_access",
        userId: "provider-user",
      },
    });
  });

  test("does not treat arbitrary JSON as an OAuth credential", () => {
    const value = JSON.stringify({ accessToken: "not-marked" });
    expect(parseProviderCredential(value)).toEqual({ kind: "api-key", value });
  });

  test("fails closed for a marked but invalid OAuth envelope", () => {
    const value = JSON.stringify({
      kind: "pointer-provider-oauth2",
      version: 1,
      accessToken: "access-token",
      issuer: "https://auth.example.test",
      clientId: "public-client-id",
      expiresAt: "not-a-date",
    });
    expect(parseProviderCredential(value)).toEqual({ kind: "invalid-oauth2" });
  });
});
