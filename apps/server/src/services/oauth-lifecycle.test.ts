import { describe, test, expect } from "bun:test";
import { renewOAuth, accessTokenExpiry, credentialStatus, type RenewableCredential } from "./oauth-lifecycle";
import { OAuthCredentialRefreshError } from "../providers/types";
const now = Date.parse("2030-01-01T00:00:00Z");
const base: RenewableCredential = {
  kind: "pointer-provider-oauth2", version: 1, issuer: "https://provider.test",
  clientId: "public-client", accessToken: "fixture-access", refreshToken: "fixture-refresh",
  expiresAt: new Date(now - 1).toISOString(),
};
describe("OAuth lifecycle", () => {
  test("fresh credentials make no refresh request", async () => {
    const value = await renewOAuth({ ...base, expiresAt: new Date(now + 600_000).toISOString() },
      async () => { throw new Error("must not call"); }, now);
    expect(value).toEqual({ accessToken: base.accessToken });
  });
  test("persists rotated refresh and last refresh metadata", async () => {
    const value = await renewOAuth(base, async () => ({ accessToken: "new", refreshToken: "rotated" }), now);
    expect(value.updated?.refreshToken).toBe("rotated");
    expect(value.updated?.lastRefreshAt).toBe(new Date(now).toISOString());
    expect(value.updated?.expiresAt).toBe(new Date(now + 300_000).toISOString());
  });
  test("retains refresh when provider omits its replacement", async () => {
    expect((await renewOAuth(base, async () => ({ accessToken: "new" }), now)).updated?.refreshToken).toBe(base.refreshToken);
  });
  test("terminal failure persists reconnect and does not repeatedly retry", async () => {
    const first = await renewOAuth(base, async () => { throw new OAuthCredentialRefreshError("fixture", true); }, now);
    expect(first.accessToken).toBeNull();
    expect(first.updated?.refreshState).toBe("reconnect_required");
    const second = await renewOAuth(first.updated!, async () => { throw new Error("must not call"); }, now);
    expect(second.updated).toBeUndefined();
  });
  test("transient failure retains a still valid token with bounded retry delay", async () => {
    const first = await renewOAuth({ ...base, expiresAt: new Date(now + 60_000).toISOString() },
      async () => { throw new Error("network"); }, now);
    expect(first.accessToken).toBe(base.accessToken);
    expect(first.updated?.refreshState).toBe("temporarily_unavailable");
    expect(first.updated?.retryAfter).toBe(new Date(now + 30_000).toISOString());
  });
  test("unknown expiry never means permanent validity", async () => {
    expect((await renewOAuth({ ...base, expiresAt: undefined }, undefined, now)).accessToken).toBeNull();
  });
  test("JWT expiry is a scheduling hint; malformed tokens stay opaque", () => {
    const token = "x." + Buffer.from(JSON.stringify({ exp: now / 1000 })).toString("base64url") + ".x";
    expect(accessTokenExpiry(token)).toBe(new Date(now).toISOString());
    expect(accessTokenExpiry("opaque")).toBeUndefined();
  });
  test("status never includes token values", () => {
    const status = JSON.stringify(credentialStatus(base));
    expect(status).not.toContain("fixture-access");
    expect(status).not.toContain("fixture-refresh");
  });
});
