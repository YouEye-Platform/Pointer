import { describe, expect, test } from "bun:test";
import handler from "./xai-grok";
import {
  OAuthCredentialRefreshError,
  type ProviderManifest,
  type RequestContext,
} from "../../src/providers/types";

const manifest: ProviderManifest = {
  id: "xai-grok",
  name: "Grok Subscription",
  type: "openai-compatible",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  auth: {
    type: "oauth-device-flow",
    issuer: "https://auth.x.ai",
    clientId: "public-client",
    scopes: "openid offline_access grok-cli:access",
  },
  endpoints: {
    models: "/models",
    chatCompletions: "/chat/completions",
    responses: "/responses",
    messages: "/messages",
  },
  handlerConfig: {
    clientVersion: "0.2.112",
    clientIdentifier: "pointer",
    clientMode: "headless",
  },
};

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function context(accessToken: string): RequestContext {
  return {
    requestId: "ptrreq_test",
    apiKeyId: "key",
    userId: "pointer-user",
    instanceId: "instance",
    providerId: "xai-grok",
    modelId: "grok-model",
    providerModelId: "grok-model",
    providerApiKey: accessToken,
    startTime: Date.now(),
  };
}

describe("xAI Grok subscription handler", () => {
  test("forces Responses SSE upstream while preserving the translated request", async () => {
    const accessToken = jwt({ sub: "xai-user-123" });
    const transformed = await handler.transformRequest!(
      {
        model: "pointer-alias",
        input: "hello",
        stream: false,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: "auto",
      },
      {
        ...context(accessToken),
        providerModelId: "grok-4.5",
        providerNativeEndpoint: "/responses",
        providerUserId: "xai-user-from-credential",
      },
      manifest
    );

    expect(transformed.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(transformed.headers).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-userid": "xai-user-from-credential",
    });
    expect(transformed.body).toMatchObject({
      model: "grok-4.5",
      input: "hello",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
  });

  test("preserves requested includes and adds encrypted reasoning once", async () => {
    const transformed = await handler.transformRequest!(
      {
        model: "grok-model",
        input: "hello",
        include: ["custom.output", "reasoning.encrypted_content"],
      },
      context("opaque-token"),
      manifest
    );

    expect(transformed.body.include).toEqual([
      "custom.output",
      "reasoning.encrypted_content",
    ]);
  });

  test("rejects unsafe per-model endpoints", async () => {
    await expect(
      handler.transformRequest!(
        { model: "grok-model", input: "hello" },
        {
          ...context("opaque-token"),
          providerNativeEndpoint: "//unexpected.example/responses",
        },
        manifest
      )
    ).rejects.toThrow("Invalid xAI Grok provider endpoint");
  });

  test("builds the session proxy authentication and identity headers", () => {
    const accessToken = jwt({ sub: "xai-user-123" });
    expect(handler.buildHeaders!(context(accessToken), manifest)).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-userid": "xai-user-123",
      "x-grok-client-version": "0.2.112",
      "x-grok-client-identifier": "pointer",
      "x-grok-client-mode": "headless",
    });
  });

  test("starts a device flow with form encoding and validates returned URLs", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/device",
        verification_uri_complete: "https://accounts.x.ai/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    }) as typeof fetch;

    try {
      await expect(handler.startDeviceAuthorization!(manifest)).resolves.toEqual({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://accounts.x.ai/device",
        verificationUriComplete: "https://accounts.x.ai/device?code=ABCD-EFGH",
        expiresIn: 600,
        interval: 5,
      });
      expect(request).not.toBeNull();
      expect(request!.url).toBe("https://auth.x.ai/oauth2/device/code");
      const body = await request!.text();
      expect(body).toContain("client_id=public-client");
      expect(body).toContain("referrer=pointer");
      expect(request!.headers.get("x-grok-client-surface")).toBe("ui");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("classifies pending, slow-down, and successful token polls", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: jwt({ sub: "xai-device-user" }),
        expires_in: 3600,
        token_type: "Bearer",
      }),
    ];
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;

    try {
      await expect(
        handler.pollDeviceAuthorization!(manifest, "device-code")
      ).resolves.toEqual({ status: "pending" });
      await expect(
        handler.pollDeviceAuthorization!(manifest, "device-code")
      ).resolves.toEqual({ status: "pending", interval: 10 });
      const success = await handler.pollDeviceAuthorization!(
        manifest,
        "device-code"
      );
      expect(success.status).toBe("success");
      if (success.status === "success") {
        expect(success.credential).toMatchObject({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          tokenType: "Bearer",
          userId: "xai-device-user",
        });
        expect(Date.parse(success.credential.expiresAt!)).toBeGreaterThan(Date.now());
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("discovers account-scoped models with native protocols", async () => {
    const originalFetch = globalThis.fetch;
    const accessToken = "opaque-access-token";
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        data: [
          {
            id: "grok-responses",
            name: "Grok Responses",
            apiBackend: "responses",
            contextWindow: 131072,
            supportsTools: true,
          },
          {
            model: "grok-messages",
            api_backend: "messages",
            context_window: 65536,
          },
          {
            id: "grok-chat",
            apiBackend: "chat_completions",
          },
        ],
      });
    }) as typeof fetch;

    try {
      const models = await handler.fetchModels!(manifest, accessToken, {
        accessToken,
        userId: "xai-user-123",
      });
      expect(models).toEqual([
        expect.objectContaining({
          id: "grok-responses",
          nativeFormat: "responses",
          nativeEndpoint: "/responses",
          contextWindow: 131072,
        }),
        expect.objectContaining({
          id: "grok-messages",
          nativeFormat: "messages",
          nativeEndpoint: "/messages",
        }),
        expect.objectContaining({
          id: "grok-chat",
          nativeFormat: "chat-completions",
          nativeEndpoint: "/chat/completions",
        }),
      ]);
      expect(models[0]).not.toHaveProperty("supportsVision");
      expect(request!.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
      expect(request!.headers.get("x-userid")).toBe("xai-user-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes with the public client and accepts token rotation", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | null = null;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "rotated-refresh-token",
        id_token: jwt({ sub: "xai-refresh-user" }),
        expires_in: 3600,
      });
    }) as typeof fetch;

    try {
      await expect(
        handler.refreshOAuthCredential!(manifest, {
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
        })
      ).resolves.toEqual(
        expect.objectContaining({
          accessToken: "new-access-token",
          refreshToken: "rotated-refresh-token",
          userId: "xai-refresh-user",
        })
      );
      expect(request!.url).toBe("https://auth.x.ai/oauth2/token");
      const body = await request!.text();
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=old-refresh-token");
      expect(body).toContain("client_id=public-client");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("classifies rejected refresh credentials as terminal", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        { error: "invalid_grant", error_description: "rejected" },
        { status: 400 }
      )) as typeof fetch;

    try {
      const error = await handler
        .refreshOAuthCredential!(manifest, {
          accessToken: "old-access-token",
          refreshToken: "rejected-refresh-token",
        })
        .catch((reason) => reason);
      expect(error).toBeInstanceOf(OAuthCredentialRefreshError);
      expect(error.terminal).toBe(true);
      expect(String(error)).not.toContain("rejected-refresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns only safe account metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      userId: "xai-user-abcdef",
      email: "not-returned@example.test",
      subscriptionTier: "GrokPro",
      principalType: "User",
      accessToken: "must-not-leak",
    })) as typeof fetch;

    try {
      const account = await handler.getAccountInfo!("token", manifest);
      expect(account).toEqual({
        connected: true,
        subscriptionTier: "GrokPro",
        principalType: "User",
        userIdSuffix: "abcdef",
        blocked: false,
      });
      expect(JSON.stringify(account)).not.toContain("not-returned");
      expect(JSON.stringify(account)).not.toContain("must-not-leak");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects oversized provider JSON before parsing it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      })) as typeof fetch;

    try {
      await expect(
        handler.startDeviceAuthorization!(manifest)
      ).rejects.toThrow("size limit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
