import { describe, expect, test } from "bun:test";
import handler from "./codex";
import type {
  ProviderManifest,
  RequestContext,
} from "../../src/providers/types";

const context: RequestContext = {
  apiKeyId: "key",
  userId: "user",
  instanceId: "instance",
  providerId: "openai-codex",
  modelId: "canonical-model",
  providerModelId: "provider-model",
  providerApiKey: "opaque-token",
  startTime: 0,
};

const manifest: ProviderManifest = {
  id: "openai-codex",
  name: "OpenAI (Codex)",
  type: "openai-compatible",
  baseUrl: "https://fixtures.invalid/backend-api/codex/",
  auth: {
    type: "oauth-device-flow",
    issuer: "https://auth.example.test",
    clientId: "pointer-codex-test",
  },
  endpoints: { responses: "/legacy/responses" },
  gateway: {
    operations: {
      generate: { format: "responses", endpoint: "/gateway/responses" },
    },
  },
};

function tokenWithAccountClaim(field: "chatgpt_account_id" | "account_id", value: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { [field]: value },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Codex provider operation endpoint", () => {
  test("supports the generic account-scoped device authorization contract", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({
          device_auth_id: "device-fixture",
          user_code: "CODEX-TEST",
          expires_in: 600,
          interval: 4,
        });
      }
      if (request.url.endsWith("/api/accounts/deviceauth/token")) {
        return Response.json({
          authorization_code: "authorization-fixture",
          code_verifier: "verifier-fixture",
        });
      }
      return Response.json({
        access_token: "access-fixture",
        refresh_token: "refresh-fixture",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid offline_access",
      });
    }) as typeof fetch;

    try {
      expect(handler.startDeviceAuthorization).toBeDefined();
      expect(handler.pollDeviceAuthorization).toBeDefined();
      const started = await handler.startDeviceAuthorization!(manifest);
      expect(started).toEqual(expect.objectContaining({
        userCode: "CODEX-TEST",
        verificationUri: "https://auth.example.test/codex/device",
        expiresIn: 600,
        interval: 4,
      }));
      const result = await handler.pollDeviceAuthorization!(manifest, started.deviceCode);
      expect(result).toEqual({
        status: "success",
        credential: expect.objectContaining({
          accessToken: "access-fixture",
          refreshToken: "refresh-fixture",
          tokenType: "Bearer",
          scope: "openid offline_access",
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.example.test/api/accounts/deviceauth/usercode",
      "https://auth.example.test/api/accounts/deviceauth/token",
      "https://auth.example.test/oauth/token",
    ]);
    expect(await requests[0].json()).toEqual({ client_id: "pointer-codex-test" });
    expect(new URLSearchParams(await requests[2].text()).get("code_verifier"))
      .toBe("verifier-fixture");
  });

  test("keeps unapproved Codex device authorization pending", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
    try {
      await expect(handler.pollDeviceAuthorization!(
        manifest,
        JSON.stringify({ deviceAuthId: "device-fixture", userCode: "CODEX-TEST" }),
      )).resolves.toEqual({ status: "pending" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the declared path while preserving custom authentication", async () => {
    expect(handler.transformRequest).toBeDefined();
    const transformed = await handler.transformRequest!(
      { model: "canonical-model", input: "hello", stream: true },
      context,
      manifest,
    );

    expect(transformed.url).toBe(
      "https://fixtures.invalid/backend-api/codex/gateway/responses",
    );
    expect(transformed.headers.Authorization).toBe("Bearer opaque-token");
    expect(transformed.headers["OAI-Product-Sku"]).toBe("codex");
    expect(transformed.headers.Accept).toBe("text/event-stream");
  });

  test("forces the upstream Codex request to stream for non-streaming clients", async () => {
    expect(handler.transformRequest).toBeDefined();
    const transformed = await handler.transformRequest!(
      { model: "canonical-model", input: "hello", stream: false },
      context,
      manifest,
    );

    expect(transformed.body.stream).toBe(true);
    expect(transformed.headers.Accept).toBe("text/event-stream");
  });

  test("converts typed Chat tool traffic with deterministic fallback IDs", async () => {
    const request = {
      model: "canonical-model",
      messages: [
        { role: "system", content: [{ type: "text", text: "Be exact." }] },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{\"id\":1}" } }],
        },
        { role: "tool", tool_call_id: "call_kept", content: { ok: true } },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" }, strict: true } }],
      stream: false,
    };

    const first = await handler.transformRequest!(request, context, manifest);
    const second = await handler.transformRequest!(request, context, manifest);
    expect(first.body).toEqual(second.body);
    expect(first.body.instructions).toBe("Be exact.");
    expect(first.body.input).toEqual([
      {
        type: "function_call",
        call_id: expect.stringMatching(/^call_/),
        name: "lookup",
        arguments: "{\"id\":1}",
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call_output", call_id: "call_kept", output: "{\"ok\":true}" },
    ]);
    expect(first.body.tools).toEqual([
      { type: "function", name: "lookup", parameters: { type: "object" }, strict: true },
    ]);
    expect(first.body.stream).toBe(true);
  });

  test("uses the required client version for connection tests and model discovery", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    const apiKey = tokenWithAccountClaim("chatgpt_account_id", "workspace-current");
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        models: [{ slug: "gpt-fixture", display_name: "GPT Fixture" }],
      });
    }) as typeof fetch;

    try {
      expect(handler.testConnection).toBeDefined();
      expect(handler.fetchModels).toBeDefined();
      await expect(handler.testConnection!(manifest, apiKey)).resolves.toEqual({
        success: true,
        status: 200,
      });
      await expect(handler.fetchModels!(manifest, apiKey)).resolves.toEqual([
        expect.objectContaining({ id: "gpt-fixture", name: "GPT Fixture" }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new URL(request.url).searchParams.get("client_version")).toBe("0.0.0");
      expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(request.headers.get("oai-product-sku")).toBe("codex");
      expect(request.headers.get("chatgpt-account-id")).toBe("workspace-current");
    }
  });

  test("does not report an empty account catalog as a healthy connection", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ models: [] })) as typeof fetch;

    try {
      expect(handler.testConnection).toBeDefined();
      await expect(handler.testConnection!(manifest, "opaque-token")).resolves.toEqual({
        success: false,
        status: 200,
        error: "Provider returned no available models",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts current and legacy account ID claims", async () => {
    expect(handler.transformRequest).toBeDefined();
    for (const field of ["chatgpt_account_id", "account_id"] as const) {
      const transformed = await handler.transformRequest!(
        { model: "canonical-model", input: "hello", stream: true },
        { ...context, providerApiKey: tokenWithAccountClaim(field, `workspace-${field}`) },
        manifest,
      );
      expect(transformed.headers["ChatGPT-Account-Id"]).toBe(`workspace-${field}`);
    }
  });
});
