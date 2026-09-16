import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "postgresql:///pointer_unit_test";
process.env.JWT_SECRET ||= "test-secret-do-not-use-in-prod";
process.env.ENCRYPTION_SECRET ||= "test-encryption-secret-do-not-use-in-prod";
process.env.CORS_ORIGIN ||= "http://webui.example.test";

describe("standalone application composition", () => {
  test("publishes browser-readable deployment capabilities with request identity", async () => {
    const { createStandaloneApp } = await import("./app");
    const response = await createStandaloneApp().request(
      "http://pointer.test/.well-known/pointer",
      {
        headers: {
          origin: process.env.CORS_ORIGIN!,
          "x-request-id": "standalone-capability-test",
        },
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      process.env.CORS_ORIGIN!
    );
    expect(response.headers.get("x-pointer-request-id")).toBe(
      "standalone-capability-test"
    );
    expect(await response.json()).toMatchObject({
      contractVersion: "1",
      deploymentMode: "standalone",
      localAuthAvailable: true,
      surface: "combined",
    });
  });

  test("preserves the gateway request identity on inference responses", async () => {
    const { createStandaloneApp } = await import("./app");
    const response = await createStandaloneApp().request(
      "http://pointer.test/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture" }),
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-pointer-request-id")).toMatch(
      /^ptrreq_[A-Za-z0-9_-]{8,120}$/,
    );
    expect(response.headers.get("x-pointer-gateway-engine")).toBe("v1");
  });

  test("uses Google authentication and request-error envelopes on v1beta", async () => {
    const { createStandaloneApp } = await import("./app");
    const missing = await createStandaloneApp().request(
      "http://pointer.test/v1beta/models",
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("x-pointer-request-id")).toMatch(
      /^ptrreq_[A-Za-z0-9_-]{8,120}$/,
    );
    expect(await missing.json()).toMatchObject({
      error: {
        code: 401,
        status: "UNAUTHENTICATED",
        details: [{ reason: "invalid_api_key" }],
      },
    });

    const conflicting = await createStandaloneApp().request(
      "http://pointer.test/v1beta/models",
      {
        headers: {
          authorization: "Bearer ptr_fixture_one",
          "x-goog-api-key": "ptr_fixture_two",
        },
      },
    );
    expect(conflicting.status).toBe(400);
    expect(await conflicting.json()).toMatchObject({
      error: { status: "INVALID_ARGUMENT", details: [{ reason: "invalid_argument" }] },
    });

    const invalidRequestId = await createStandaloneApp().request(
      "http://pointer.test/v1beta/models",
      { headers: { "x-request-id": "invalid request id" } },
    );
    expect(invalidRequestId.status).toBe(400);
    expect(await invalidRequestId.json()).toMatchObject({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        details: [{ reason: "pointer_invalid_request" }],
      },
    });
  });
});
