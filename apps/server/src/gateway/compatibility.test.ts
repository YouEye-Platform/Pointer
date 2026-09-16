import { describe, expect, test } from "bun:test";
import {
  CLIENT_CORRELATION_ID_HEADER,
  GATEWAY_COMPATIBILITY_CONTRACT_VERSION,
  GATEWAY_ENGINE_HEADER,
  GATEWAY_ENGINE_VERSION,
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_WARNING_HEADER,
  GATEWAY_WIRE_FORMATS,
  aggregateCompatibilityState,
  blockingErrorCodeForCompatibility,
  compatibilityEvaluationSchema,
  compatibilityErrorCodeSchema,
  createCompatibilityWarningEnvelope,
  compatibilityFindingMessageSchema,
  createSafeUpstreamDiagnostic,
  errorCodeForTimeoutPhase,
  errorCodeForUpstreamStatus,
  evaluateCompatibility,
  extractAllowlistedUpstreamMetadata,
  featureCompatibilityListSchema,
  gatewayFeatureIdSchema,
  gatewayResponseHeaders,
  gatewayWireFormatSchema,
  parseCompatibilityWarningsHeader,
  requestIdSchema,
  resolveRequestId,
  safeUpstreamDiagnosticSchema,
  serializeCompatibilityWarnings,
  type CompatibilityState,
  type FeatureCompatibility,
} from "./compatibility";

const textFeature = { id: "text-input", version: "1" } as const;
const toolsFeature = { id: "tool-definitions", version: "1" } as const;
const operationFeature = { id: "operation", version: "1" } as const;
const testFormats = {
  sourceFormat: GATEWAY_WIRE_FORMATS.responses,
  targetFormat: GATEWAY_WIRE_FORMATS.messages,
} as const;

interface PublishedCompatibilitySchema {
  $defs: {
    featureId: { enum: string[] };
    errorCode: { enum: string[] };
    findingMessage: { enum: string[] };
    safeMessage: { allOf: unknown[] };
    compatibilityResult: {
      properties: {
        findings: { minItems: number; maxItems: number; contains: unknown };
        requestedFeatures: { minItems: number; maxItems: number; contains: unknown };
      };
      allOf: unknown[];
    };
    safeDiagnostic: {
      required: string[];
      properties: Record<string, unknown>;
      allOf: unknown[];
    };
  };
}

const findingCode = {
  native: "pointer_feature_native",
  emulated: "pointer_feature_emulated",
  lossy: "pointer_feature_lossy",
  unsupported: "pointer_feature_unsupported",
  unknown: "pointer_feature_unknown",
} as const;
const findingMessage = {
  native: "The requested feature is supported natively.",
  emulated: "Pointer emulates the requested feature without semantic loss.",
  lossy: "Pointer may degrade the requested feature.",
  unsupported: "The selected deployment does not support the requested feature.",
  unknown: "Support for the requested feature is unknown.",
} as const;

function assessment(
  state: CompatibilityState,
  feature: FeatureCompatibility["feature"] = textFeature,
  bestEffortAllowed = false,
): FeatureCompatibility {
  return {
    feature,
    path: `request.${feature.id}`,
    state,
    code: findingCode[state],
    message: findingMessage[state],
    bestEffortAllowed,
  };
}

function requestedFeatures(
  ...features: FeatureCompatibility["feature"][]
) {
  return features.map((feature) => ({
    feature,
    path: `request.${feature.id}`,
  }));
}

describe("versioned compatibility contract", () => {
  test("accepts only the declared wire format versions", () => {
    expect(gatewayWireFormatSchema.parse(GATEWAY_WIRE_FORMATS.chatCompletions))
      .toEqual(GATEWAY_WIRE_FORMATS.chatCompletions);
    expect(gatewayWireFormatSchema.parse(GATEWAY_WIRE_FORMATS.messages)).toEqual(
      GATEWAY_WIRE_FORMATS.messages,
    );
    expect(gatewayWireFormatSchema.parse(GATEWAY_WIRE_FORMATS.responses)).toEqual(
      GATEWAY_WIRE_FORMATS.responses,
    );

    expect(
      gatewayWireFormatSchema.safeParse({
        format: "messages",
        version: "2024-01-01",
      }).success,
    ).toBe(false);
    expect(
      gatewayWireFormatSchema.safeParse({
        format: "responses",
        version: "v0",
      }).success,
    ).toBe(false);
    expect(
      gatewayWireFormatSchema.safeParse({
        ...GATEWAY_WIRE_FORMATS.responses,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate versioned feature assessments", () => {
    expect(
      featureCompatibilityListSchema.safeParse([
        assessment("native"),
        assessment("emulated"),
      ]).success,
    ).toBe(false);
  });

  test("keeps stable gateway error codes", () => {
    const expectedCodes = [
      "pointer_invalid_request",
      "pointer_feature_lossy",
      "pointer_feature_unsupported",
      "pointer_feature_unknown",
      "pointer_no_compatible_target",
      "pointer_upstream_auth",
      "pointer_upstream_rate_limit",
      "pointer_upstream_timeout",
      "pointer_upstream_unavailable",
      "pointer_connect_timeout",
      "pointer_first_token_timeout",
      "pointer_idle_timeout",
      "pointer_total_timeout",
      "pointer_client_cancelled",
      "pointer_malformed_stream",
      "pointer_upstream_disconnected",
      "pointer_stream_interrupted",
      "pointer_internal_error",
    ] as const;

    for (const code of expectedCodes) {
      expect(compatibilityErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(compatibilityErrorCodeSchema.safeParse("provider_failed").success).toBe(
      false,
    );
  });

  test("defines the full preflight feature vocabulary", () => {
    const requiredFeatures = [
      "operation",
      "streaming",
      "usage-in-stream",
      "ordered-multimodal-content",
      "text-input",
      "image-input",
      "audio-input",
      "file-input",
      "system-instructions",
      "developer-instructions",
      "tool-definitions",
      "tool-choice",
      "tool-calls",
      "tool-results",
      "parallel-tool-calls",
      "structured-output",
      "json-schema",
      "reasoning-controls",
      "reasoning-results",
      "stop-controls",
      "finish-reasons",
      "logprobs",
      "token-usage",
      "prompt-caching",
      "provider-extensions",
    ] as const;
    for (const feature of requiredFeatures) {
      expect(gatewayFeatureIdSchema.parse(feature)).toBe(feature);
    }
  });

  test("keeps the published JSON schema aligned with executable enums", async () => {
    const schemaUrl = new URL(
      "../../../../packages/contracts/specs/gateway-compatibility.v1.schema.json",
      import.meta.url,
    );
    const published = JSON.parse(
      await Bun.file(schemaUrl).text(),
    ) as PublishedCompatibilitySchema;

    expect(published.$defs.featureId.enum).toEqual(gatewayFeatureIdSchema.options);
    expect(published.$defs.errorCode.enum).toEqual(
      compatibilityErrorCodeSchema.options,
    );
    expect(published.$defs.findingMessage.enum).toEqual(
      compatibilityFindingMessageSchema.options,
    );
    expect(published.$defs.compatibilityResult.properties.findings.minItems).toBe(1);
    expect(published.$defs.compatibilityResult.properties.findings.maxItems).toBe(32);
    expect(
      JSON.stringify(published.$defs.compatibilityResult.properties.findings.contains),
    ).toContain('"operation"');
    expect(
      published.$defs.compatibilityResult.properties.requestedFeatures.minItems,
    ).toBe(1);
    expect(
      published.$defs.compatibilityResult.properties.requestedFeatures.maxItems,
    ).toBe(32);
    expect(
      JSON.stringify(
        published.$defs.compatibilityResult.properties.requestedFeatures.contains,
      ),
    ).toContain('"operation"');
    expect(published.$defs.compatibilityResult.allOf).toHaveLength(9);
    expect(published.$defs.safeMessage.allOf).toHaveLength(8);
    expect(published.$defs.safeDiagnostic.required).toContain("errorClass");
    expect(published.$defs.safeDiagnostic.required).toContain("metadataSource");
    expect(published.$defs.safeDiagnostic.required).not.toContain("category");
    expect(published.$defs.safeDiagnostic.properties.category).toBeUndefined();
    expect(published.$defs.safeDiagnostic.allOf).toHaveLength(6);
  });
});

describe("strict and best-effort policy", () => {
  test("strict permits native and emulated but blocks lossy, unknown, and unsupported", () => {
    const result = evaluateCompatibility(
      [
        assessment("native", operationFeature),
        assessment("emulated", toolsFeature),
        assessment("lossy", { id: "image-input", version: "1" }),
        assessment("unknown", { id: "reasoning-controls", version: "1" }),
        assessment("unsupported", { id: "audio-input", version: "1" }),
      ],
      "strict",
      testFormats,
      requestedFeatures(
        operationFeature,
        toolsFeature,
        { id: "image-input", version: "1" },
        { id: "reasoning-controls", version: "1" },
        { id: "audio-input", version: "1" },
      ),
    );

    expect(result.accepted).toBe(false);
    expect(result.result).toBe("unsupported");
    expect(result.findings.map((item) => item.state)).toEqual([
      "native",
      "emulated",
      "lossy",
      "unknown",
      "unsupported",
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.contractVersion).toBe("gateway-compatibility.v1");
    expect(result.sourceFormat).toEqual(GATEWAY_WIRE_FORMATS.responses);
    expect(result.targetFormat).toEqual(GATEWAY_WIRE_FORMATS.messages);
  });

  test("best-effort permits known degradation but never unsupported features", () => {
    const result = evaluateCompatibility(
      [
        assessment("native", operationFeature),
        assessment("lossy", textFeature, true),
        assessment("unknown", toolsFeature, true),
        assessment("unsupported", { id: "audio-output", version: "1" }),
      ],
      "best-effort",
      testFormats,
      requestedFeatures(
        operationFeature,
        textFeature,
        toolsFeature,
        { id: "audio-output", version: "1" },
      ),
    );

    expect(result.accepted).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "pointer_feature_lossy",
      "pointer_feature_unknown",
    ]);
  });

  test("best-effort blocks degradation without an explicit adapter permit", () => {
    const result = evaluateCompatibility(
      [
        assessment("native", operationFeature),
        assessment("lossy"),
        assessment("unknown", toolsFeature),
      ],
      "best-effort",
      testFormats,
      requestedFeatures(operationFeature, textFeature, toolsFeature),
    );
    expect(result.accepted).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  test("fails closed when the operation assessment is absent", () => {
    expect(() =>
      evaluateCompatibility(
        [],
        "strict",
        testFormats,
        requestedFeatures(operationFeature),
      ),
    ).toThrow();
    expect(() =>
      evaluateCompatibility(
        [assessment("native")],
        "strict",
        testFormats,
        requestedFeatures(operationFeature),
      ),
    ).toThrow("requested operation");
    expect(() => aggregateCompatibilityState([])).toThrow();
    expect(() =>
      evaluateCompatibility(
        [assessment("native", operationFeature)],
        "strict",
        testFormats,
        requestedFeatures(
          operationFeature,
          { id: "image-input", version: "1" },
        ),
      ),
    ).toThrow("missing a matching assessment");
  });

  test("rejects duplicate findings and fabricated warnings", () => {
    const result = evaluateCompatibility(
      [
        assessment("native", operationFeature),
        assessment("lossy", textFeature, true),
      ],
      "best-effort",
      testFormats,
      requestedFeatures(operationFeature, textFeature),
    );
    expect(
      compatibilityEvaluationSchema.safeParse({
        ...result,
        findings: [...result.findings, result.findings[1]],
      }).success,
    ).toBe(false);
    expect(
      compatibilityEvaluationSchema.safeParse({
        ...result,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  test("maps blocking states to stable codes", () => {
    expect(blockingErrorCodeForCompatibility("native", "strict")).toBeNull();
    expect(blockingErrorCodeForCompatibility("emulated", "strict")).toBeNull();
    expect(blockingErrorCodeForCompatibility("lossy", "strict")).toBe(
      "pointer_feature_lossy",
    );
    expect(blockingErrorCodeForCompatibility("lossy", "best-effort")).toBe(
      "pointer_feature_lossy",
    );
    expect(
      blockingErrorCodeForCompatibility("lossy", "best-effort", true),
    ).toBeNull();
    expect(blockingErrorCodeForCompatibility("unknown", "strict")).toBe(
      "pointer_feature_unknown",
    );
    expect(blockingErrorCodeForCompatibility("unknown", "best-effort")).toBe(
      "pointer_feature_unknown",
    );
    expect(
      blockingErrorCodeForCompatibility("unknown", "best-effort", true),
    ).toBeNull();
    expect(blockingErrorCodeForCompatibility("unsupported", "best-effort")).toBe(
      "pointer_feature_unsupported",
    );
  });
});

describe("warning envelope and header", () => {
  const warnings = evaluateCompatibility(
    [
      assessment("native", operationFeature),
      assessment("lossy", textFeature, true),
      assessment("unknown", toolsFeature, true),
    ],
    "best-effort",
    testFormats,
    requestedFeatures(operationFeature, textFeature, toolsFeature),
  ).warnings;

  test("uses a versioned envelope and deterministic ordering", () => {
    const envelope = createCompatibilityWarningEnvelope(warnings);
    expect(envelope.contractVersion).toBe(
      GATEWAY_COMPATIBILITY_CONTRACT_VERSION,
    );
    expect(envelope.warnings.map((warning) => warning.code)).toEqual([
      "pointer_feature_lossy",
      "pointer_feature_unknown",
    ]);
    expect(GATEWAY_WARNING_HEADER).toBe("x-pointer-warning-codes");
  });

  test("serializes a deduplicated stable-code header", () => {
    const serialized = serializeCompatibilityWarnings(warnings);
    expect(serialized).toBe(
      "pointer_feature_lossy,pointer_feature_unknown",
    );
    expect(parseCompatibilityWarningsHeader(serialized)).toEqual([
      "pointer_feature_lossy",
      "pointer_feature_unknown",
    ]);
    expect(serializeCompatibilityWarnings([...warnings, warnings[0]!])).toBe(
      serialized,
    );
    expect(parseCompatibilityWarningsHeader(null)).toEqual([]);
  });

  test("rejects malformed, unknown, and oversized headers", () => {
    expect(() =>
      parseCompatibilityWarningsHeader(
        "pointer_feature_lossy, pointer_feature_unknown",
      ),
    ).toThrow();
    expect(() => parseCompatibilityWarningsHeader("provider_failed")).toThrow();
    expect(() => parseCompatibilityWarningsHeader("x".repeat(513))).toThrow(
      RangeError,
    );
  });
});

describe("request ID validation and propagation", () => {
  test("builds stable V1 headers for JSON and streaming responses", () => {
    expect(gatewayResponseHeaders("ptrreq_header1234")).toEqual({
      "content-type": "application/json; charset=UTF-8",
      [GATEWAY_ENGINE_HEADER]: GATEWAY_ENGINE_VERSION,
      [GATEWAY_REQUEST_ID_HEADER]: "ptrreq_header1234",
    });
    expect(gatewayResponseHeaders("ptrreq_header1234", "text/event-stream")).toEqual({
      "content-type": "text/event-stream",
      [GATEWAY_ENGINE_HEADER]: "v1",
      [GATEWAY_REQUEST_ID_HEADER]: "ptrreq_header1234",
    });
  });

  test("always generates Pointer's ID and records client correlation separately", () => {
    const result = resolveRequestId(
      "client-1:attempt.2",
      () => "ptrreq_12345678",
    );
    expect(result).toEqual({
      ok: true,
      metadata: {
        requestId: "ptrreq_12345678",
        clientCorrelationId: "client-1:attempt.2",
        propagation: {
          responseHeader: GATEWAY_REQUEST_ID_HEADER,
          clientCorrelationHeader: CLIENT_CORRELATION_ID_HEADER,
          upstreamPolicy: "adapter-allowlist",
          upstreamHeader: null,
          sendUpstream: false,
          sendResponse: true,
          includeInLogs: true,
          includeInTelemetry: true,
        },
      },
    });
  });

  test("uses the same Pointer ID for responses, logs, and telemetry", () => {
    expect(resolveRequestId(undefined, () => "ptrreq_generated1")).toEqual({
      ok: true,
      metadata: {
        requestId: "ptrreq_generated1",
        clientCorrelationId: null,
        propagation: {
          responseHeader: "x-pointer-request-id",
          clientCorrelationHeader: "x-request-id",
          upstreamPolicy: "adapter-allowlist",
          upstreamHeader: null,
          sendUpstream: false,
          sendResponse: true,
          includeInLogs: true,
          includeInTelemetry: true,
        },
      },
    });

    let generatorCalled = false;
    const invalid = resolveRequestId("bad\r\nx-injected: yes", () => {
      generatorCalled = true;
      return "ptrreq_invalidcorrelation";
    });
    expect(invalid.ok).toBe(false);
    expect(generatorCalled).toBe(true);
    if (!invalid.ok) {
      expect(invalid.metadata.requestId).toBe("ptrreq_invalidcorrelation");
      expect(invalid.metadata.clientCorrelationId).toBeNull();
    }
  });

  test("rejects invalid client correlation metadata", () => {
    for (const value of [
      "",
      123,
      "contains space",
      "a".repeat(129),
      "sk-fixture-sensitive-value",
      "ptr_fixture-sensitive-value",
      "token:fixture-sensitive-value",
      "eyJabcdefghij.abcdefghij.abcdefghij",
    ]) {
      const result = resolveRequestId(value, () => "ptrreq_12345678");
      expect(result.ok).toBe(false);
    }
    expect(requestIdSchema.parse(`ptrreq_${"a".repeat(120)}`)).toHaveLength(127);
  });

  test("fails closed if the configured generator returns an invalid ID", () => {
    expect(() => resolveRequestId(undefined, () => "bad generated id")).toThrow(
      "Pointer request ID generator returned an invalid value",
    );
  });
});

describe("safe upstream diagnostics", () => {
  test("rejects unsafe text in findings and public diagnostics", () => {
    for (const message of [
      "Bearer should-not-pass",
      "Cookie: session=should-not-pass",
      "https://private-provider.invalid/error",
      "owner@example.com",
      "apikey=fixture-sensitive-value",
      "token: fixture-sensitive-value",
      "github_pat_fixture-sensitive-value",
      "eyJabcdefghij.abcdefghij.abcdefghij",
    ]) {
      expect(
        featureCompatibilityListSchema.safeParse([
          {
            ...assessment("unknown", operationFeature),
            message,
          },
        ]).success,
      ).toBe(false);
    }
    expect(
      featureCompatibilityListSchema.safeParse([
        {
          ...assessment("native", operationFeature),
          message: "Customer account 482901 requested a confidential plan.",
        },
      ]).success,
    ).toBe(false);
  });

  test("builds a bounded schema that cannot carry headers, bodies, or URLs", () => {
    const diagnostic = createSafeUpstreamDiagnostic({
      requestId: "ptrreq_12345678",
      errorClass: "http",
      upstreamStatus: 429,
      allowlistedMetadata: extractAllowlistedUpstreamMetadata({
        "x-error-code": "rate_limit_exceeded",
        "x-request-id": "upstream-req-1",
        "retry-after": "2",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-at": "2026-07-17T12:00:00Z",
      }),
      retryable: true,
    });

    expect(diagnostic).toEqual({
      diagnosticVersion: "1",
      requestId: "ptrreq_12345678",
      errorClass: "http",
      metadataSource: "adapter-allowlist",
      upstreamStatus: 429,
      upstreamCode: "rate_limit_exceeded",
      upstreamRequestId: "upstream-req-1",
      retryAfterMs: 2_000,
      rateLimitRemaining: 0,
      rateLimitResetAt: "2026-07-17T12:00:00Z",
      message: "Upstream HTTP request failed",
      retryable: true,
    });
    expect(
      safeUpstreamDiagnosticSchema.safeParse({
        ...diagnostic,
        upstreamHeaders: { authorization: "secret" },
      }).success,
    ).toBe(false);
  });

  test("does not stringify unknown input and drops unsafe status and code", () => {
    const diagnostic = createSafeUpstreamDiagnostic({
      requestId: "ptrreq_abcdefgh",
      errorClass: "network",
      upstreamStatus: "500",
      retryable: false,
    });

    expect(diagnostic.upstreamStatus).toBeNull();
    expect(diagnostic.upstreamCode).toBeNull();
    expect(diagnostic.upstreamRequestId).toBeNull();
    expect(diagnostic.retryAfterMs).toBeNull();
    expect(diagnostic.rateLimitRemaining).toBeNull();
    expect(diagnostic.rateLimitResetAt).toBeNull();
    expect(diagnostic.metadataSource).toBe("none");
    expect(diagnostic.message).toBe("Upstream network request failed");
  });

  test("requires branded allowlist provenance and drops credential-shaped headers", () => {
    expect(() =>
      createSafeUpstreamDiagnostic({
        requestId: "ptrreq_abcdefgh",
        errorClass: "http",
        upstreamStatus: 429,
        allowlistedMetadata: {
          upstreamCode: "rate_limit_exceeded",
          upstreamRequestId: "upstream-req-1",
          retryAfterMs: 2_000,
          rateLimitRemaining: 0,
          rateLimitResetAt: null,
        } as never,
        retryable: true,
      }),
    ).toThrow("allowlist extractor");

    const trusted = extractAllowlistedUpstreamMetadata({
      "x-error-code": "rate_limit_exceeded",
    });
    expect(() =>
      createSafeUpstreamDiagnostic({
        requestId: "ptrreq_abcdefgh",
        errorClass: "http",
        upstreamStatus: 429,
        allowlistedMetadata: {
          ...trusted,
          upstreamCode: "fabricated_provider_code",
        } as never,
        retryable: true,
      }),
    ).toThrow("allowlist extractor");

    const diagnostic = createSafeUpstreamDiagnostic({
      requestId: "ptrreq_abcdefgh",
      errorClass: "http",
      upstreamStatus: 429,
      allowlistedMetadata: extractAllowlistedUpstreamMetadata({
        "x-error-code": "apikey=fixture-sensitive-value",
        "x-request-id": "ptr_fixture-sensitive-value",
        "retry-after": "999999999",
      }),
      retryable: true,
    });
    expect(diagnostic.metadataSource).toBe("adapter-allowlist");
    expect(diagnostic.upstreamCode).toBeNull();
    expect(diagnostic.upstreamRequestId).toBeNull();
    expect(diagnostic.retryAfterMs).toBeNull();
  });

  test("rejects manually constructed diagnostics containing credentials", () => {
    expect(
      safeUpstreamDiagnosticSchema.safeParse({
        diagnosticVersion: "1",
        requestId: "ptrreq_87654321",
        errorClass: "http",
        metadataSource: "none",
        upstreamStatus: 401,
        upstreamCode: "unauthorized",
        upstreamRequestId: null,
        retryAfterMs: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
        message: "Bearer should-not-pass",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      safeUpstreamDiagnosticSchema.safeParse({
        diagnosticVersion: "1",
        requestId: "ptrreq_87654321",
        errorClass: "http",
        metadataSource: "none",
        upstreamStatus: 500,
        upstreamCode: "opaque_provider_code",
        upstreamRequestId: null,
        retryAfterMs: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
        message: "Upstream HTTP request failed",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      safeUpstreamDiagnosticSchema.safeParse({
        diagnosticVersion: "1",
        requestId: "ptrreq_87654321",
        errorClass: "http",
        metadataSource: "none",
        upstreamStatus: 500,
        upstreamCode: null,
        upstreamRequestId: null,
        retryAfterMs: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
        message: "Upstream network request failed",
        retryable: false,
      }).success,
    ).toBe(false);
  });

  test("maps upstream statuses without exposing upstream payloads", () => {
    expect(errorCodeForUpstreamStatus(408)).toBe("pointer_upstream_timeout");
    expect(errorCodeForUpstreamStatus(504)).toBe("pointer_upstream_timeout");
    expect(errorCodeForUpstreamStatus(429)).toBe(
      "pointer_upstream_rate_limit",
    );
    expect(errorCodeForUpstreamStatus(401)).toBe("pointer_upstream_auth");
    expect(errorCodeForUpstreamStatus(500)).toBe("pointer_upstream_unavailable");
    expect(errorCodeForUpstreamStatus(null)).toBe("pointer_upstream_unavailable");
    expect(errorCodeForTimeoutPhase("connect")).toBe("pointer_connect_timeout");
    expect(errorCodeForTimeoutPhase("first-token")).toBe(
      "pointer_first_token_timeout",
    );
    expect(errorCodeForTimeoutPhase("idle")).toBe("pointer_idle_timeout");
    expect(errorCodeForTimeoutPhase("total")).toBe("pointer_total_timeout");
  });
});
