import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../gateway/protocol/v1/schemas";
import { createGatewayProxyStreamSelector } from "../gateway/protocol/v1/runtime-proxy";
import { refineProxyRequest } from "../providers/types";
import {
  googleCrossFormatUnsupportedReason,
  googlePayloadForResolvedRoute,
  googleProxyRoutes,
  parseGoogleRouteTarget,
  parseProviderSseLine,
} from "./proxy";
import proxyRoutes from "./proxy";

describe("provider request runtime refinement", () => {
  test("registers the Anthropic token-counting endpoint", () => {
    expect(proxyRoutes.routes.some((route) =>
      route.method === "POST" && route.path === "/messages/count_tokens"
    )).toBe(true);
  });

  test("registers every Gemini CLI Google model operation", () => {
    expect(googleProxyRoutes.routes.some((route) =>
      route.method === "GET" && route.path === "/models"
    )).toBe(true);
    expect(googleProxyRoutes.routes.some((route) =>
      route.method === "GET" && route.path === "/models/*"
    )).toBe(true);
    expect(googleProxyRoutes.routes.some((route) =>
      route.method === "POST" && route.path === "/models/*"
    )).toBe(true);
  });

  test("decodes Google model paths once and rejects malformed or traversal paths", () => {
    expect(parseGoogleRouteTarget(
      "/v1beta/models/Pointer%20Display%20Model:streamGenerateContent",
    )).toEqual({ model: "Pointer Display Model", action: "streamGenerateContent" });
    expect(parseGoogleRouteTarget("/v1beta/models/model%252Fencoded:generateContent")).toEqual({
      model: "model%2Fencoded",
      action: "generateContent",
    });
    expect(parseGoogleRouteTarget("/v1beta/models/%ZZ:generateContent")).toBeNull();
    expect(parseGoogleRouteTarget("/v1beta/models/../secret:generateContent")).toBeNull();
    expect(parseGoogleRouteTarget("/v1beta/models/model:unknownAction")).toBeNull();
  });

  test("fails closed for Google-only or newly introduced fields on cross-format routes", () => {
    const portable = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 128 },
    } satisfies JsonObject;
    expect(googleCrossFormatUnsupportedReason(portable, "chat-completions")).toBeNull();
    expect(googleCrossFormatUnsupportedReason(
      { ...portable, futureGoogleControl: { enabled: true } },
      "responses",
    )).toContain("futureGoogleControl");
    expect(googleCrossFormatUnsupportedReason(
      {
        ...portable,
        generationConfig: {
          ...portable.generationConfig,
          futureSamplingControl: true,
        },
      },
      "messages",
    )).toContain("futureSamplingControl");
    expect(googleCrossFormatUnsupportedReason(
      { ...portable, safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH" }] },
      "chat-completions",
    )).toContain("native Google");
    expect(googleCrossFormatUnsupportedReason(
      { ...portable, futureGoogleControl: { enabled: true } },
      "google-generate-content",
    )).toBeNull();
  });

  test("removes only a no-op disabled-thinking control on a non-reasoning cross-format route", () => {
    const payload = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
      },
    } satisfies JsonObject;
    expect(googlePayloadForResolvedRoute(
      payload,
      "chat-completions",
      false,
      false,
    )).toEqual({
      contents: payload.contents,
      generationConfig: { temperature: 0.2 },
    });
    expect(googlePayloadForResolvedRoute(
      payload,
      "chat-completions",
      true,
      false,
    )).toEqual(payload);
    expect(googlePayloadForResolvedRoute(
      payload,
      "google-generate-content",
      false,
      false,
    )).toEqual(payload);
  });

  test("accepts the concrete fields consumed by provider handlers", () => {
    expect(refineProxyRequest({
      model: "provider/raw-model",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      temperature: 0.2,
      max_tokens: 128,
    })).toMatchObject({
      model: "provider/raw-model",
      stream: false,
      max_tokens: 128,
    });
  });

  test("rejects malformed fields before provider execution", () => {
    const malformed: JsonObject[] = [
      { model: "provider/raw-model", stream: "false" },
      { model: "provider/raw-model", messages: {} },
      { model: "provider/raw-model", tools: {} },
      { model: "provider/raw-model", temperature: "0.2" },
      { model: "provider/raw-model", max_tokens: -1 },
      { model: "provider/raw-model", max_tokens: 1.5 },
    ];
    for (const value of malformed) {
      expect(() => refineProxyRequest(value)).toThrow();
    }
  });
});

describe("provider SSE framing", () => {
  test("ignores comment heartbeats without corrupting translated tool events", () => {
    const state: { event?: string } = {};
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      requestId: "ptrreq_heartbeat_tool_stream",
    });
    const output: string[] = [];
    const lines = [
      ": keepalive",
      "",
      "event: keepalive",
      'data: {"type":"keepalive"}',
      "event: response.created",
      ": keepalive",
      'data: {"type":"response.created","response":{"id":"resp_heartbeat","model":"provider/model","status":"in_progress"}}',
      "event: response.output_item.added",
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_heartbeat","type":"function_call","status":"in_progress","call_id":"call_heartbeat","name":"save_report","arguments":""}}',
      ": keepalive",
      "event: response.function_call_arguments.delta",
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"call_id":"call_heartbeat","delta":"{\\"html\\":\\"ok\\"}"}',
      ": keepalive",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_heartbeat","model":"provider/model","status":"completed","output":[]}}',
      ": keepalive",
    ];

    for (const line of lines) {
      const event = parseProviderSseLine(line, state);
      if (event) output.push(...selector.push(event).lines);
    }

    const rendered = output.join("");
    expect(rendered).toContain('"partial_json":"{\\"html\\":\\"ok\\"}"');
    expect(rendered).toContain("message_stop");
    expect(rendered).not.toContain("keepalive");
    expect(selector.failed()).toBe(false);
    expect(selector.ended()).toBe(true);
  });
});
