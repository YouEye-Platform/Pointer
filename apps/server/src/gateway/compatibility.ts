import { randomUUID } from "node:crypto";
import { z } from "zod";

export const GATEWAY_COMPATIBILITY_CONTRACT_VERSION =
  "gateway-compatibility.v1" as const;
export const GATEWAY_FEATURE_VERSION = "1" as const;
export const GATEWAY_REQUEST_ID_HEADER = "x-pointer-request-id" as const;
export const GATEWAY_ENGINE_HEADER = "x-pointer-gateway-engine" as const;
export const GATEWAY_ENGINE_VERSION = "v1" as const;

export function gatewayResponseHeaders(
  requestId: string,
  contentType = "application/json; charset=UTF-8",
): Record<string, string> {
  return {
    "content-type": contentType,
    [GATEWAY_ENGINE_HEADER]: GATEWAY_ENGINE_VERSION,
    [GATEWAY_REQUEST_ID_HEADER]: requestId,
  };
}
export const GATEWAY_COMPATIBILITY_MODE_HEADER =
  "x-pointer-compatibility-mode" as const;
export const GATEWAY_COMPATIBILITY_RESULT_HEADER =
  "x-pointer-compatibility-result" as const;
export const GATEWAY_WARNING_HEADER = "x-pointer-warning-codes" as const;

const MAX_WARNING_HEADER_LENGTH = 512;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const CREDENTIAL_LIKE_VALUE_PATTERN =
  /(?:\b(?:sk-|ptr_|ptrreq_|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9._-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;
const UNSAFE_CLIENT_TEXT_PATTERN =
  /(?:\b(?:Bearer|Basic)\s+\S+|\b(?:sk-|ptr_|ptrreq_|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9._-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|https?:\/\/|(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|api_?key|apikey|access_?token|refresh_?token|client_?secret|password|passwd|token|secret)\s*[=:]|[?&](?:access_token|refresh_token|api_key|apikey|key|token|client_secret|password|secret)=)/i;

const safeMessageSchema = z
  .string()
  .min(1)
  .max(MAX_DIAGNOSTIC_MESSAGE_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: "Message must not contain control characters",
  })
  .refine(
    (value) =>
      !UNSAFE_CLIENT_TEXT_PATTERN.test(value) && !EMAIL_PATTERN.test(value),
    { message: "Message contains unsafe client-visible material" },
  );

export const gatewayApiFormatSchema = z.enum([
  "chat-completions",
  "messages",
  "responses",
  "google-generate-content",
]);
export type GatewayApiFormat = z.infer<typeof gatewayApiFormatSchema>;

export const gatewayWireFormatSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("chat-completions"),
      version: z.literal("v1"),
    })
    .strict(),
  z
    .object({
      format: z.literal("messages"),
      version: z.literal("2023-06-01"),
    })
    .strict(),
  z
    .object({
      format: z.literal("responses"),
      version: z.literal("v1"),
    })
    .strict(),
  z
    .object({
      format: z.literal("google-generate-content"),
      version: z.literal("v1beta"),
    })
    .strict(),
]);
export type GatewayWireFormat = z.infer<typeof gatewayWireFormatSchema>;

export const GATEWAY_WIRE_FORMATS = {
  chatCompletions: {
    format: "chat-completions",
    version: "v1",
  },
  messages: {
    format: "messages",
    version: "2023-06-01",
  },
  responses: {
    format: "responses",
    version: "v1",
  },
  googleGenerateContent: {
    format: "google-generate-content",
    version: "v1beta",
  },
} as const satisfies Record<string, GatewayWireFormat>;

export const gatewayFeatureIdSchema = z.enum([
  "operation",
  "streaming",
  "usage-in-stream",
  "ordered-multimodal-content",
  "text-input",
  "image-input",
  "file-input",
  "text-output",
  "image-output",
  "audio-output",
  "system-instructions",
  "developer-instructions",
  "tool-definitions",
  "tool-choice",
  "tool-calls",
  "tool-results",
  "parallel-tool-calls",
  "structured-output",
  "json-schema",
  "audio-input",
  "reasoning-controls",
  "reasoning-results",
  "stop-controls",
  "finish-reasons",
  "token-usage",
  "prompt-caching",
  "logprobs",
  "seed",
  "service-tier",
  "metadata",
  "provider-extensions",
]);
export type GatewayFeatureId = z.infer<typeof gatewayFeatureIdSchema>;

export const gatewayFeatureSchema = z
  .object({
    id: gatewayFeatureIdSchema,
    version: z.literal(GATEWAY_FEATURE_VERSION),
  })
  .strict();
export type GatewayFeature = z.infer<typeof gatewayFeatureSchema>;

export const compatibilityStateSchema = z.enum([
  "native",
  "emulated",
  "lossy",
  "unsupported",
  "unknown",
]);
export type CompatibilityState = z.infer<typeof compatibilityStateSchema>;

export const compatibilityPolicySchema = z.enum(["strict", "best-effort"]);
export type CompatibilityPolicy = z.infer<typeof compatibilityPolicySchema>;

export const compatibilityFindingCodeSchema = z.enum([
  "pointer_feature_native",
  "pointer_feature_emulated",
  "pointer_feature_lossy",
  "pointer_feature_unsupported",
  "pointer_feature_unknown",
]);
export type CompatibilityFindingCode = z.infer<
  typeof compatibilityFindingCodeSchema
>;

export const compatibilityFindingMessageSchema = z.enum([
  "The requested feature is supported natively.",
  "Pointer emulates the requested feature without semantic loss.",
  "Pointer may degrade the requested feature.",
  "The selected deployment does not support the requested feature.",
  "Support for the requested feature is unknown.",
]);
export type CompatibilityFindingMessage = z.infer<
  typeof compatibilityFindingMessageSchema
>;

export const compatibilityFindingPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);

const FINDING_CODE_BY_STATE: Record<
  CompatibilityState,
  CompatibilityFindingCode
> = {
  native: "pointer_feature_native",
  emulated: "pointer_feature_emulated",
  lossy: "pointer_feature_lossy",
  unsupported: "pointer_feature_unsupported",
  unknown: "pointer_feature_unknown",
};

const FINDING_MESSAGE_BY_STATE: Record<
  CompatibilityState,
  CompatibilityFindingMessage
> = {
  native: "The requested feature is supported natively.",
  emulated: "Pointer emulates the requested feature without semantic loss.",
  lossy: "Pointer may degrade the requested feature.",
  unsupported: "The selected deployment does not support the requested feature.",
  unknown: "Support for the requested feature is unknown.",
};

export const featureCompatibilitySchema = z
  .object({
    feature: gatewayFeatureSchema,
    path: compatibilityFindingPathSchema,
    state: compatibilityStateSchema,
    code: compatibilityFindingCodeSchema,
    message: compatibilityFindingMessageSchema,
    bestEffortAllowed: z.boolean().default(false),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.code !== FINDING_CODE_BY_STATE[finding.state]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Finding code ${finding.code} does not match state ${finding.state}`,
        path: ["code"],
      });
    }
    if (finding.message !== FINDING_MESSAGE_BY_STATE[finding.state]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Finding message does not match state ${finding.state}`,
        path: ["message"],
      });
    }
  });
export type FeatureCompatibility = z.infer<typeof featureCompatibilitySchema>;

export function createFeatureCompatibilityFinding(
  feature: GatewayFeature,
  path: string,
  state: CompatibilityState,
  bestEffortAllowed = false,
): FeatureCompatibility {
  return featureCompatibilitySchema.parse({
    feature,
    path,
    state,
    code: FINDING_CODE_BY_STATE[state],
    message: FINDING_MESSAGE_BY_STATE[state],
    bestEffortAllowed,
  });
}

export const featureCompatibilityListSchema = z
  .array(featureCompatibilitySchema)
  .min(1)
  .max(32)
  .superRefine((assessments, context) => {
    const seen = new Set<string>();
    for (const [index, assessment] of assessments.entries()) {
      const key = assessment.path;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate compatibility finding path ${key}`,
          path: [index, "path"],
        });
      }
      seen.add(key);
    }
    if (!assessments.some((assessment) => assessment.feature.id === "operation")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Compatibility findings must include the requested operation",
      });
    }
  });

export const requestedGatewayFeatureSchema = z
  .object({
    feature: gatewayFeatureSchema,
    path: compatibilityFindingPathSchema,
  })
  .strict();
export type RequestedGatewayFeature = z.infer<
  typeof requestedGatewayFeatureSchema
>;

export const requestedGatewayFeatureListSchema = z
  .array(requestedGatewayFeatureSchema)
  .min(1)
  .max(32)
  .superRefine((requestedFeatures, context) => {
    const seen = new Set<string>();
    for (const [index, requested] of requestedFeatures.entries()) {
      if (seen.has(requested.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate requested feature path ${requested.path}`,
          path: [index, "path"],
        });
      }
      seen.add(requested.path);
    }
    if (!requestedFeatures.some((requested) => requested.feature.id === "operation")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Requested features must include the requested operation",
      });
    }
  });

export const compatibilityErrorCodeSchema = z.enum([
  "pointer_invalid_request",
  "pointer_feature_lossy",
  "pointer_feature_unsupported",
  "pointer_feature_unknown",
  "pointer_no_compatible_target",
  "pointer_upstream_auth",
  "pointer_upstream_rate_limit",
  "pointer_upstream_timeout",
  "pointer_upstream_unavailable",
  "pointer_context_length_exceeded",
  "pointer_empty_response",
  "pointer_connect_timeout",
  "pointer_first_token_timeout",
  "pointer_idle_timeout",
  "pointer_total_timeout",
  "pointer_client_cancelled",
  "pointer_malformed_stream",
  "pointer_upstream_disconnected",
  "pointer_stream_interrupted",
  "pointer_internal_error",
]);
export type CompatibilityErrorCode = z.infer<
  typeof compatibilityErrorCodeSchema
>;

export const compatibilityWarningCodeSchema = z.enum([
  "pointer_feature_lossy",
  "pointer_feature_unknown",
]);
export type CompatibilityWarningCode = z.infer<
  typeof compatibilityWarningCodeSchema
>;

export const compatibilityWarningSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("pointer_feature_lossy"),
      feature: gatewayFeatureSchema,
      path: compatibilityFindingPathSchema,
      state: z.literal("lossy"),
      message: z.literal(FINDING_MESSAGE_BY_STATE.lossy),
    })
    .strict(),
  z
    .object({
      code: z.literal("pointer_feature_unknown"),
      feature: gatewayFeatureSchema,
      path: compatibilityFindingPathSchema,
      state: z.literal("unknown"),
      message: z.literal(FINDING_MESSAGE_BY_STATE.unknown),
    })
    .strict(),
]);
export type CompatibilityWarning = z.infer<
  typeof compatibilityWarningSchema
>;

export const compatibilityWarningEnvelopeSchema = z
  .object({
    contractVersion: z.literal(GATEWAY_COMPATIBILITY_CONTRACT_VERSION),
    warnings: z.array(compatibilityWarningSchema).max(32),
  })
  .strict();
export type CompatibilityWarningEnvelope = z.infer<
  typeof compatibilityWarningEnvelopeSchema
>;

export const compatibilityEvaluationSchema = z
  .object({
    contractVersion: z.literal(GATEWAY_COMPATIBILITY_CONTRACT_VERSION),
    sourceFormat: gatewayWireFormatSchema,
    targetFormat: gatewayWireFormatSchema,
    result: compatibilityStateSchema,
    accepted: z.boolean(),
    policy: compatibilityPolicySchema,
    requestedFeatures: requestedGatewayFeatureListSchema,
    findings: featureCompatibilityListSchema,
    warnings: z.array(compatibilityWarningSchema).max(32),
  })
  .strict()
  .superRefine((evaluation, context) => {
    const requestedByPath = new Map(
      evaluation.requestedFeatures.map((requested) => [
        requested.path,
        requested.feature,
      ]),
    );
    const findingsByPath = new Map(
      evaluation.findings.map((finding) => [finding.path, finding.feature]),
    );
    for (const [path, requestedFeature] of requestedByPath) {
      const assessedFeature = findingsByPath.get(path);
      if (
        assessedFeature?.id !== requestedFeature.id ||
        assessedFeature.version !== requestedFeature.version
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Requested feature ${path} is missing a matching assessment`,
          path: ["findings"],
        });
      }
    }
    for (const path of findingsByPath.keys()) {
      if (!requestedByPath.has(path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Compatibility finding ${path} was not requested`,
          path: ["findings"],
        });
      }
    }
    const aggregate = aggregateCompatibilityState(
      evaluation.findings.map((finding) => finding.state),
    );
    if (evaluation.result !== aggregate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Aggregate result does not match compatibility findings",
        path: ["result"],
      });
    }
    const accepted = evaluation.findings.every(
      (finding) =>
        blockingErrorCodeForCompatibility(
          finding.state,
          evaluation.policy,
          finding.bestEffortAllowed,
        ) === null,
    );
    if (evaluation.accepted !== accepted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepted flag does not match compatibility policy",
        path: ["accepted"],
      });
    }
    const expectedWarnings =
      evaluation.policy === "best-effort"
        ? evaluation.findings.flatMap((finding) => {
            if (!finding.bestEffortAllowed) return [];
            const warning = warningForCompatibility(finding);
            return warning === null ? [] : [warning];
          })
        : [];
    if (
      JSON.stringify([...evaluation.warnings].sort(compareWarnings)) !==
      JSON.stringify(expectedWarnings.sort(compareWarnings))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Warnings do not match permitted lossy or unknown findings",
        path: ["warnings"],
      });
    }
  });
export type CompatibilityEvaluation = z.infer<
  typeof compatibilityEvaluationSchema
>;

export function blockingErrorCodeForCompatibility(
  state: CompatibilityState,
  policy: CompatibilityPolicy,
  bestEffortAllowed = false,
): CompatibilityErrorCode | null {
  if (state === "unsupported") return "pointer_feature_unsupported";
  if (state === "lossy" && (policy === "strict" || !bestEffortAllowed)) {
    return "pointer_feature_lossy";
  }
  if (state === "unknown" && (policy === "strict" || !bestEffortAllowed)) {
    return "pointer_feature_unknown";
  }
  return null;
}

function warningForCompatibility(
  assessment: FeatureCompatibility,
): CompatibilityWarning | null {
  switch (assessment.state) {
    case "lossy":
      return {
        code: "pointer_feature_lossy",
        feature: assessment.feature,
        path: assessment.path,
        state: "lossy",
        message: assessment.message,
      };
    case "unknown":
      return {
        code: "pointer_feature_unknown",
        feature: assessment.feature,
        path: assessment.path,
        state: "unknown",
        message: assessment.message,
      };
    case "native":
    case "emulated":
    case "unsupported":
      return null;
  }
}

export function evaluateCompatibility(
  assessments: readonly FeatureCompatibility[],
  policy: CompatibilityPolicy,
  formats: {
    sourceFormat: GatewayWireFormat;
    targetFormat: GatewayWireFormat;
  },
  requestedFeatures: readonly RequestedGatewayFeature[],
): CompatibilityEvaluation {
  const parsedPolicy = compatibilityPolicySchema.parse(policy);
  const parsedAssessments = featureCompatibilityListSchema.parse(assessments);
  const parsedRequestedFeatures = requestedGatewayFeatureListSchema.parse(
    requestedFeatures,
  );
  const blocking = parsedAssessments.filter(
    (assessment) =>
      blockingErrorCodeForCompatibility(
        assessment.state,
        parsedPolicy,
        assessment.bestEffortAllowed,
      ) !== null,
  );
  const warnings = parsedAssessments.flatMap((assessment) => {
    if (parsedPolicy !== "best-effort" || !assessment.bestEffortAllowed) {
      return [];
    }
    const warning = warningForCompatibility(assessment);
    return warning === null ? [] : [warning];
  });
  const result = aggregateCompatibilityState(
    parsedAssessments.map((assessment) => assessment.state),
  );

  return compatibilityEvaluationSchema.parse({
    contractVersion: GATEWAY_COMPATIBILITY_CONTRACT_VERSION,
    sourceFormat: gatewayWireFormatSchema.parse(formats.sourceFormat),
    targetFormat: gatewayWireFormatSchema.parse(formats.targetFormat),
    result,
    accepted: blocking.length === 0,
    policy: parsedPolicy,
    requestedFeatures: parsedRequestedFeatures,
    findings: parsedAssessments,
    warnings,
  });
}

const COMPATIBILITY_STATE_RANK: Record<CompatibilityState, number> = {
  native: 0,
  emulated: 1,
  unknown: 2,
  lossy: 3,
  unsupported: 4,
};

export function aggregateCompatibilityState(
  states: readonly CompatibilityState[],
): CompatibilityState {
  const parsedStates = z.array(compatibilityStateSchema).min(1).parse(states);
  return parsedStates.reduce<CompatibilityState>(
    (aggregate, state) =>
      COMPATIBILITY_STATE_RANK[state] > COMPATIBILITY_STATE_RANK[aggregate]
        ? state
        : aggregate,
    "native",
  );
}

function compareWarnings(
  left: CompatibilityWarning,
  right: CompatibilityWarning,
): number {
  return (
    left.code.localeCompare(right.code) ||
    left.feature.id.localeCompare(right.feature.id) ||
    left.path.localeCompare(right.path) ||
    left.message.localeCompare(right.message)
  );
}

export function createCompatibilityWarningEnvelope(
  warnings: readonly CompatibilityWarning[],
): CompatibilityWarningEnvelope {
  return compatibilityWarningEnvelopeSchema.parse({
    contractVersion: GATEWAY_COMPATIBILITY_CONTRACT_VERSION,
    warnings: [...warnings].sort(compareWarnings),
  });
}

export function serializeCompatibilityWarnings(
  warnings: readonly CompatibilityWarning[],
): string {
  const parsedWarnings = z.array(compatibilityWarningSchema).max(32).parse(warnings);
  const headerValue = [...new Set(parsedWarnings.map((warning) => warning.code))]
    .sort()
    .join(",");
  if (headerValue.length > MAX_WARNING_HEADER_LENGTH) {
    throw new RangeError("Compatibility warning header exceeds 512 bytes");
  }
  return headerValue;
}

export function parseCompatibilityWarningsHeader(
  headerValue: string | null | undefined,
): CompatibilityWarningCode[] {
  if (headerValue === null || headerValue === undefined) return [];
  if (headerValue.length > MAX_WARNING_HEADER_LENGTH) {
    throw new RangeError("Compatibility warning header exceeds 512 bytes");
  }
  if (headerValue.length === 0) return [];

  const codes = headerValue.split(",");
  if (codes.some((code) => code.trim() !== code || code.length === 0)) {
    throw new Error("Compatibility warning header is malformed");
  }
  return [
    ...new Set(z.array(compatibilityWarningCodeSchema).parse(codes)),
  ].sort();
}

export const requestIdSchema = z
  .string()
  .min(15)
  .max(127)
  .regex(/^ptrreq_[A-Za-z0-9_-]{8,120}$/, {
    message: "Pointer request ID has an invalid shape",
  });
export type RequestId = z.infer<typeof requestIdSchema>;

export const clientCorrelationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
    message: "Client correlation ID contains unsupported characters",
  })
  .refine(
    (value) =>
      !CREDENTIAL_LIKE_VALUE_PATTERN.test(value) &&
      !UNSAFE_CLIENT_TEXT_PATTERN.test(value),
    {
      message: "Client correlation ID resembles credential material",
    },
  );
export type ClientCorrelationId = z.infer<typeof clientCorrelationIdSchema>;

export const CLIENT_CORRELATION_ID_HEADER = "x-request-id" as const;

export const requestIdMetadataSchema = z
  .object({
    requestId: requestIdSchema,
    clientCorrelationId: clientCorrelationIdSchema.nullable(),
    propagation: z
      .object({
        responseHeader: z.literal(GATEWAY_REQUEST_ID_HEADER),
        clientCorrelationHeader: z.literal(CLIENT_CORRELATION_ID_HEADER),
        upstreamPolicy: z.literal("adapter-allowlist"),
        upstreamHeader: z.null(),
        sendUpstream: z.literal(false),
        sendResponse: z.literal(true),
        includeInLogs: z.literal(true),
        includeInTelemetry: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type RequestIdMetadata = z.infer<typeof requestIdMetadataSchema>;

export const requestIdResolutionSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      metadata: requestIdMetadataSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal("pointer_invalid_request"),
      message: safeMessageSchema,
      metadata: requestIdMetadataSchema,
    })
    .strict(),
]);
export type RequestIdResolution = z.infer<typeof requestIdResolutionSchema>;

function createRequestIdMetadata(
  requestId: RequestId,
  clientCorrelationId: ClientCorrelationId | null,
): RequestIdMetadata {
  return requestIdMetadataSchema.parse({
    requestId,
    clientCorrelationId,
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
  });
}

function generatePointerRequestId(): string {
  return `ptrreq_${randomUUID().replaceAll("-", "")}`;
}

export function resolveRequestId(
  clientCorrelationHeaderValue: unknown,
  generateRequestId: () => string = generatePointerRequestId,
): RequestIdResolution {
  const generated = requestIdSchema.safeParse(generateRequestId());
  if (!generated.success) {
    throw new Error("Pointer request ID generator returned an invalid value");
  }
  const correlation =
    clientCorrelationHeaderValue === null ||
    clientCorrelationHeaderValue === undefined
      ? null
      : clientCorrelationIdSchema.safeParse(clientCorrelationHeaderValue);
  if (correlation !== null && !correlation.success) {
    return {
      ok: false,
      code: "pointer_invalid_request",
      message: "The x-request-id correlation header is invalid.",
      metadata: createRequestIdMetadata(generated.data, null),
    };
  }
  return {
    ok: true,
    metadata: createRequestIdMetadata(
      generated.data,
      correlation === null ? null : correlation.data,
    ),
  };
}

export const upstreamErrorClassSchema = z.enum([
  "http",
  "network",
  "timeout",
  "protocol",
  "translation",
]);
export type UpstreamErrorClass = z.infer<
  typeof upstreamErrorClassSchema
>;

const UPSTREAM_ERROR_MESSAGES: Record<UpstreamErrorClass, string> = {
  http: "Upstream HTTP request failed",
  network: "Upstream network request failed",
  timeout: "Upstream request timed out",
  protocol: "Upstream protocol error",
  translation: "Upstream response translation failed",
};

const upstreamMetadataSourceSchema = z.enum(["none", "adapter-allowlist"]);

const upstreamCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine(
    (value) =>
      !CREDENTIAL_LIKE_VALUE_PATTERN.test(value) &&
      !UNSAFE_CLIENT_TEXT_PATTERN.test(value),
    { message: "Upstream code resembles credential material" },
  );

const upstreamRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine(
    (value) =>
      !CREDENTIAL_LIKE_VALUE_PATTERN.test(value) &&
      !UNSAFE_CLIENT_TEXT_PATTERN.test(value),
    { message: "Upstream request ID resembles credential material" },
  );

const retryAfterMsSchema = z.number().int().min(0).max(86_400_000);
const rateLimitRemainingSchema = z.number().int().min(0).max(1_000_000_000);
const rateLimitResetAtSchema = z.string().datetime({ offset: true });

export const safeUpstreamDiagnosticSchema = z
  .object({
    diagnosticVersion: z.literal("1"),
    requestId: requestIdSchema,
    errorClass: upstreamErrorClassSchema,
    metadataSource: upstreamMetadataSourceSchema,
    upstreamStatus: z.number().int().min(100).max(599).nullable(),
    upstreamCode: upstreamCodeSchema.nullable(),
    upstreamRequestId: upstreamRequestIdSchema.nullable(),
    retryAfterMs: retryAfterMsSchema.nullable(),
    rateLimitRemaining: rateLimitRemainingSchema.nullable(),
    rateLimitResetAt: rateLimitResetAtSchema.nullable(),
    message: safeMessageSchema,
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    if (diagnostic.message !== UPSTREAM_ERROR_MESSAGES[diagnostic.errorClass]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Diagnostic message does not match the normalized error class",
        path: ["message"],
      });
    }
    if (diagnostic.metadataSource === "none") {
      for (const field of [
        "upstreamCode",
        "upstreamRequestId",
        "retryAfterMs",
        "rateLimitRemaining",
        "rateLimitResetAt",
      ] as const) {
        if (diagnostic[field] !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Upstream metadata requires an adapter allowlist",
            path: [field],
          });
        }
      }
    }
  });
export type SafeUpstreamDiagnostic = z.infer<
  typeof safeUpstreamDiagnosticSchema
>;

const ALLOWLISTED_UPSTREAM_METADATA = Symbol(
  "pointer.adapter-allowlisted-upstream-metadata",
);
const TRUSTED_ALLOWLISTED_UPSTREAM_METADATA = new WeakSet<object>();

export interface AdapterAllowlistedUpstreamMetadata {
  readonly upstreamCode: string | null;
  readonly upstreamRequestId: string | null;
  readonly retryAfterMs: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetAt: string | null;
  readonly [ALLOWLISTED_UPSTREAM_METADATA]: true;
}

function readHeaderValue(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function parseIntegerHeader(
  value: string | null,
  schema: z.ZodType<number>,
  multiplier = 1,
): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = schema.safeParse(Number(value) * multiplier);
  return parsed.success ? parsed.data : null;
}

export function extractAllowlistedUpstreamMetadata(
  headers: unknown,
): AdapterAllowlistedUpstreamMetadata {
  const code = upstreamCodeSchema.safeParse(
    readHeaderValue(headers, "x-error-code"),
  );
  const requestId = upstreamRequestIdSchema.safeParse(
    readHeaderValue(headers, "x-request-id"),
  );
  const rateLimitResetAt = rateLimitResetAtSchema.safeParse(
    readHeaderValue(headers, "x-ratelimit-reset-at"),
  );
  const metadata = {
    upstreamCode: code.success ? code.data : null,
    upstreamRequestId: requestId.success ? requestId.data : null,
    retryAfterMs: parseIntegerHeader(
      readHeaderValue(headers, "retry-after"),
      retryAfterMsSchema,
      1_000,
    ),
    rateLimitRemaining: parseIntegerHeader(
      readHeaderValue(headers, "x-ratelimit-remaining"),
      rateLimitRemainingSchema,
    ),
    rateLimitResetAt: rateLimitResetAt.success
      ? rateLimitResetAt.data
      : null,
  } as AdapterAllowlistedUpstreamMetadata;
  Object.defineProperty(metadata, ALLOWLISTED_UPSTREAM_METADATA, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.freeze(metadata);
  TRUSTED_ALLOWLISTED_UPSTREAM_METADATA.add(metadata);
  return metadata;
}

export interface SafeUpstreamDiagnosticInput {
  requestId: unknown;
  errorClass: unknown;
  upstreamStatus?: unknown;
  allowlistedMetadata?: AdapterAllowlistedUpstreamMetadata;
  retryable: unknown;
}

export function createSafeUpstreamDiagnostic(
  input: SafeUpstreamDiagnosticInput,
): SafeUpstreamDiagnostic {
  const requestId = requestIdSchema.parse(input.requestId);
  const errorClass = upstreamErrorClassSchema.parse(input.errorClass);
  const allowlistedMetadata = input.allowlistedMetadata;
  if (
    allowlistedMetadata !== undefined &&
    !TRUSTED_ALLOWLISTED_UPSTREAM_METADATA.has(allowlistedMetadata)
  ) {
    throw new Error("Upstream metadata must come from the allowlist extractor");
  }
  const metadataSource = allowlistedMetadata
    ? "adapter-allowlist"
    : "none";
  const status = z.number().int().min(100).max(599).safeParse(
    input.upstreamStatus,
  );
  const retryable = z.boolean().parse(input.retryable);

  return safeUpstreamDiagnosticSchema.parse({
    diagnosticVersion: "1",
    requestId,
    errorClass,
    metadataSource,
    upstreamStatus: status.success ? status.data : null,
    upstreamCode: allowlistedMetadata?.upstreamCode ?? null,
    upstreamRequestId: allowlistedMetadata?.upstreamRequestId ?? null,
    retryAfterMs: allowlistedMetadata?.retryAfterMs ?? null,
    rateLimitRemaining: allowlistedMetadata?.rateLimitRemaining ?? null,
    rateLimitResetAt: allowlistedMetadata?.rateLimitResetAt ?? null,
    message: UPSTREAM_ERROR_MESSAGES[errorClass],
    retryable,
  });
}

export function errorCodeForUpstreamStatus(
  upstreamStatus: number | null,
): CompatibilityErrorCode {
  if (upstreamStatus === 408 || upstreamStatus === 504) {
    return "pointer_upstream_timeout";
  }
  if (upstreamStatus === 429) return "pointer_upstream_rate_limit";
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return "pointer_upstream_auth";
  }
  return "pointer_upstream_unavailable";
}

export const timeoutPhaseSchema = z.enum([
  "connect",
  "first-token",
  "idle",
  "total",
]);
export type TimeoutPhase = z.infer<typeof timeoutPhaseSchema>;

const TIMEOUT_ERROR_CODES: Record<TimeoutPhase, CompatibilityErrorCode> = {
  connect: "pointer_connect_timeout",
  "first-token": "pointer_first_token_timeout",
  idle: "pointer_idle_timeout",
  total: "pointer_total_timeout",
};

export function errorCodeForTimeoutPhase(
  phase: TimeoutPhase,
): CompatibilityErrorCode {
  return TIMEOUT_ERROR_CODES[timeoutPhaseSchema.parse(phase)];
}
