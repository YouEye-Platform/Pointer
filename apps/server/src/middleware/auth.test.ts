import { describe, test, expect, beforeAll } from "bun:test";

process.env.JWT_SECRET ||= "test-secret-do-not-use-in-prod";
process.env.CORS_ORIGIN ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgresql://pointer:pointer@localhost:5432/pointer";

describe("JWT_SECRET fail-closed", () => {
  test("signJwt/verifyJwt module throws if JWT_SECRET is unset", async () => {
    const prev = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      await import(`./auth?nocache=${Date.now()}`);
      expect.unreachable("expected import to throw when JWT_SECRET is unset");
    } catch (err) {
      expect(String(err)).toContain("JWT_SECRET is required");
    } finally {
      process.env.JWT_SECRET = prev;
    }
  });
});

describe("password hashing", () => {
  test("hashPassword/verifyPassword round-trip", async () => {
    const { hashPassword, verifyPassword } = await import("./auth");
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("JWT sign/verify", () => {
  test("verifyJwt rejects a forged token", async () => {
    const { verifyJwt } = await import("./auth");
    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJhZG1pbiJ9.forged-signature";
    expect(await verifyJwt(forged)).toBeNull();
  });

  test("verifyJwt rejects an expired token", async () => {
    const jose = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const expired = await new (jose as any).SignJWT({ sub: "u1", email: "a@b.com", name: "A", role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secret);
    const { verifyJwt } = await import("./auth");
    expect(await verifyJwt(expired)).toBeNull();
  });
});

describe("glob-based model allowlist (api-key middleware)", () => {
  test("matchesGlob / isModelAllowed", async () => {
    const { matchesGlob, isModelAllowed } = await import("./api-key");
    expect(matchesGlob("claude-*", "claude-opus-4")).toBe(true);
    expect(matchesGlob("claude-*", "gpt-4o")).toBe(false);
    expect(matchesGlob("*", "anything")).toBe(true);
    expect(isModelAllowed(["gpt-*", "claude-*"], "claude-opus-4")).toBe(true);
    expect(isModelAllowed(["gpt-*"], "claude-opus-4")).toBe(false);
  });

  test("hashApiKey is deterministic SHA-256 hex", async () => {
    const { hashApiKey } = await import("./api-key");
    const a = await hashApiKey("ptr_abc123");
    const b = await hashApiKey("ptr_abc123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
