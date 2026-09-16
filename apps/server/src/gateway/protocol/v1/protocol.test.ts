import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { GatewayApiFormat } from "../../compatibility";
import {
  FORMAT_FIXTURES,
  GATEWAY_FIXTURE_EXPECTATIONS,
  GATEWAY_FORMATS,
} from "../../fixtures/corpus";
import {
  executeGatewayRequestAdapter,
  parsePublicError,
  parsePublicRequest,
  parsePublicResponse,
  renderPublicError,
  renderPublicRequest,
  renderPublicResponse,
  createStreamAdapterContext,
  parsePublicStreamEvent,
  renderPublicStreamEvent,
  stableGatewayId,
} from ".";
import type {
  GatewayAdapterFailure,
  IrContentBlock,
  IrRequest,
  IrStreamEvent,
  JsonObject,
} from ".";

function valueOf<T>(result: { ok: true; value: T } | GatewayAdapterFailure): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function allBlocks(request: IrRequest): IrContentBlock[] {
  return [...request.instructions, ...request.turns.flatMap((turn) => turn.blocks)];
}

function imageUrls(blocks: readonly IrContentBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "image" && block.source.type === "url" ? [block.source.url] : [],
  );
}

function parseSseLine(line: string): { event?: string; data: unknown } | null {
  const event = line.match(/^event: ([^\n]+)/m)?.[1];
  const data = line.match(/^data: (.*)$/m)?.[1];
  if (data === undefined) return null;
  if (data === "[DONE]") return { ...(event ? { event } : {}), data };
  return { ...(event ? { event } : {}), data: JSON.parse(data) };
}

describe("Gateway V1 IR request adapters", () => {
  for (const sourceFormat of GATEWAY_FORMATS) {
    test(`${sourceFormat} parses to a versioned, ordered IR`, () => {
      const request = valueOf(parsePublicRequest(sourceFormat, FORMAT_FIXTURES[sourceFormat].request));
      expect(request.protocol).toBe("pointer.gateway.ir");
      expect(request.version).toBe(1);
      expect(request.sourceFormat).toBe(sourceFormat);
      expect(request.model).toBe(GATEWAY_FIXTURE_EXPECTATIONS.canonicalModel);
      expect(imageUrls(allBlocks(request))).toEqual(GATEWAY_FIXTURE_EXPECTATIONS.orderedImageUrls);
      const priorCall = allBlocks(request).find((block) => block.type === "tool_call");
      const result = allBlocks(request).find((block) => block.type === "tool_result");
      expect(priorCall?.type === "tool_call" ? priorCall.id : null).toBe("call_fixture_previous");
      expect(result?.type === "tool_result" ? result.callId : null).toBe("call_fixture_previous");
      expect(request.sampling.maxOutputTokens).toBe(128);
      expect(request.parallelToolCalls).toBe(
        sourceFormat === "google-generate-content" ? undefined : false,
      );
    });

    for (const targetFormat of GATEWAY_FORMATS) {
      test(`${sourceFormat} -> IR -> ${targetFormat} uses the provider raw model`, () => {
        const request = valueOf(parsePublicRequest(sourceFormat, FORMAT_FIXTURES[sourceFormat].request));
        const rendered = valueOf(renderPublicRequest(
          targetFormat,
          request,
          "best-effort",
          GATEWAY_FIXTURE_EXPECTATIONS.providerRawModel,
        ));
        expect(rendered.model).toBe(GATEWAY_FIXTURE_EXPECTATIONS.providerRawModel);
        const reparsed = valueOf(parsePublicRequest(targetFormat, rendered));
        expect(imageUrls(allBlocks(reparsed))).toEqual(GATEWAY_FIXTURE_EXPECTATIONS.orderedImageUrls);
        const callIds = allBlocks(reparsed).flatMap((block) =>
          block.type === "tool_call" ? [block.id] : block.type === "tool_result" ? [block.callId] : [],
        );
        expect(callIds).toContain("call_fixture_previous");
      });
    }
  }

  test("strict rejects a cross-format source extension while best-effort reports it", () => {
    const request = valueOf(parsePublicRequest("messages", FORMAT_FIXTURES.messages.request));
    const strict = renderPublicRequest("chat-completions", request, "strict");
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe("pointer_feature_lossy");
    const bestEffort = renderPublicRequest("chat-completions", request, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (bestEffort.ok) {
      expect(bestEffort.findings.some((finding) => finding.detailCode === "pointer_cross_format_extension_dropped")).toBe(true);
    }
  });

  test("allowlisted extensions round-trip only in their source namespace", () => {
    const input = {
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      metadata: { trace: "fixture" },
    };
    const request = valueOf(parsePublicRequest("chat-completions", input));
    expect(request.extensions).toEqual([
      { namespace: "chat-completions", key: "metadata", value: { trace: "fixture" } },
    ]);
    expect(valueOf(renderPublicRequest("chat-completions", request)).metadata).toEqual({ trace: "fixture" });
    const cross = valueOf(renderPublicRequest("responses", request, "best-effort"));
    expect(cross.metadata).toBeUndefined();
  });

  test("denied and non-JSON extensions fail with stable errors", () => {
    const denied = parsePublicRequest("chat-completions", {
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      authorization: "must-not-pass",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("pointer_feature_unsupported");
      expect(denied.error.issues[0].path).toBe("authorization");
    }

    const nonJson = parsePublicRequest("chat-completions", {
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      metadata: { invalid: Number.POSITIVE_INFINITY },
    });
    expect(nonJson.ok).toBe(false);
    if (!nonJson.ok) expect(nonJson.error.code).toBe("pointer_invalid_request");
  });

  test("invalid public requests return format-stable validation details", () => {
    for (const format of GATEWAY_FORMATS) {
      const result = parsePublicRequest(format, { model: "missing-input" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("pointer_invalid_request");
        expect(result.error.format).toBe(format);
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
  });

  test("missing tool IDs are deterministic and content-sensitive", () => {
    const input = {
      model: "model",
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{\"x\":1}" } }],
      }],
    };
    const first = valueOf(parsePublicRequest("chat-completions", input));
    const second = valueOf(parsePublicRequest("chat-completions", structuredClone(input)));
    const firstId = allBlocks(first).find((block) => block.type === "tool_call");
    const secondId = allBlocks(second).find((block) => block.type === "tool_call");
    expect(firstId?.type === "tool_call" ? firstId.id : null).toBe(secondId?.type === "tool_call" ? secondId.id : null);
    expect(stableGatewayId("call", "a")).not.toBe(stableGatewayId("call", "b"));
  });
});

describe("Gateway V1 IR response adapters", () => {
  for (const sourceFormat of GATEWAY_FORMATS) {
    test(`${sourceFormat} response preserves reasoning, tools, finish, and usage`, () => {
      const response = valueOf(parsePublicResponse(sourceFormat, FORMAT_FIXTURES[sourceFormat].response));
      expect(response.output.some((block) => block.type === "reasoning")).toBe(true);
      const tool = response.output.find((block) => block.type === "tool_call");
      expect(tool?.type === "tool_call" ? tool.id : null).toBe(GATEWAY_FIXTURE_EXPECTATIONS.toolCall.id);
      expect(response.finishReason).toBe(GATEWAY_FIXTURE_EXPECTATIONS.finishReason);
      expect(response.usage).toMatchObject(GATEWAY_FIXTURE_EXPECTATIONS.usage);
    });

    for (const targetFormat of GATEWAY_FORMATS) {
      test(`${sourceFormat} response -> IR -> ${targetFormat} preserves semantic channels`, () => {
        const response = valueOf(parsePublicResponse(sourceFormat, FORMAT_FIXTURES[sourceFormat].response));
        const renderedResult = renderPublicResponse(targetFormat, response, "best-effort");
        const hasUnsignedReasoning = response.output.some((block) =>
          block.type === "reasoning" && !block.signature && !block.encryptedContent
        );
        if (targetFormat === "messages" && hasUnsignedReasoning) {
          expect(renderedResult.ok).toBe(false);
          if (!renderedResult.ok) {
            expect(renderedResult.error.code).toBe("pointer_feature_unsupported");
            expect(renderedResult.error.findings.map((finding) => finding.detailCode)).toContain(
              "pointer_messages_reasoning_signature_missing",
            );
          }
          return;
        }
        const rendered = valueOf(renderedResult);
        const reparsed = valueOf(parsePublicResponse(targetFormat, rendered));
        expect(reparsed.output.some((block) => block.type === "reasoning")).toBe(true);
        expect(reparsed.output.some((block) => block.type === "tool_call" && block.id === GATEWAY_FIXTURE_EXPECTATIONS.toolCall.id)).toBe(true);
        expect(reparsed.finishReason).toBe("tool_calls");
        expect(reparsed.usage?.reasoningTokens).toBe(6);
      });
    }
  }

  test("absent usage remains absent", () => {
    const response = valueOf(parsePublicResponse("chat-completions", {
      id: "chatcmpl_without_usage",
      model: "model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
    expect(response.usage).toBeUndefined();
    expect(valueOf(renderPublicResponse("responses", response)).usage).toBeUndefined();
  });

  test("response extensions round-trip in their source namespace and are explicit cross-format", () => {
    const response = valueOf(parsePublicResponse("responses", FORMAT_FIXTURES.responses.response));
    expect(response.extensions.map((extension) => extension.key)).toEqual([
      "error",
      "incomplete_details",
      "parallel_tool_calls",
    ]);
    const sameFormat = valueOf(renderPublicResponse("responses", response));
    expect(sameFormat.parallel_tool_calls).toBe(false);
    const strict = renderPublicResponse("messages", response, "strict");
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe("pointer_feature_lossy");
  });
});

describe("Gateway V1 IR errors", () => {
  for (const sourceFormat of GATEWAY_FORMATS) {
    test(`${sourceFormat} error normalizes and renders all public envelopes`, () => {
      const fixture = FORMAT_FIXTURES[sourceFormat].error;
      const error = valueOf(parsePublicError(sourceFormat, {
        status: fixture.status,
        headers: fixture.headers as Record<string, string>,
        body: fixture.body,
      }, { requestId: "ptrreq_fixture_error_01" }));
      expect(error.code).toBe("pointer_upstream_rate_limit");
      expect(error.message).toBe("Upstream HTTP request failed");
      expect(error.retryAfterMs).toBe(1000);
      for (const targetFormat of GATEWAY_FORMATS) {
        const rendered = renderPublicError(targetFormat, error);
        expect(rendered.status).toBe(429);
        expect(rendered.headers["retry-after"]).toBe("1");
        expect(rendered.body.error).toBeDefined();
      }
    });
  }
});

describe("Gateway V1 IR stream events", () => {
  for (const format of GATEWAY_FORMATS) {
    test(`${format} trace preserves reasoning, text, tool identity, usage, and finish`, () => {
      let context = createStreamAdapterContext(
        GATEWAY_FIXTURE_EXPECTATIONS.providerRawModel,
        `fixture-${format}`,
      );
      const events: IrStreamEvent[] = [];
      for (const line of FORMAT_FIXTURES[format].stream) {
        const parsedLine = parseSseLine(line);
        if (!parsedLine) continue;
        const parsed = parsePublicStreamEvent(format, parsedLine, context);
        if ("ok" in parsed) throw new Error(parsed.error.message);
        events.push(...parsed.events);
        context = parsed.context;
      }
      expect(events.some((event) => event.type === "reasoning_delta" && event.delta === GATEWAY_FIXTURE_EXPECTATIONS.reasoning)).toBe(true);
      expect(events.some((event) => event.type === "text_delta" && event.delta === GATEWAY_FIXTURE_EXPECTATIONS.text)).toBe(true);
      expect(events.some((event) => event.type === "tool_call_start" && event.callId === GATEWAY_FIXTURE_EXPECTATIONS.toolCall.id)).toBe(true);
      expect(events.some((event) => event.type === "tool_arguments_delta" && event.callId === GATEWAY_FIXTURE_EXPECTATIONS.toolCall.id)).toBe(true);
      expect(events.some((event) => event.type === "usage" && event.usage.reasoningTokens === 6)).toBe(true);
      expect(events.some((event) => event.type === "response_end" && event.finishReason === "tool_calls")).toBe(true);
      expect(events.filter((event) => event.type === "response_end")).toHaveLength(1);
      expect(events.findIndex((event) => event.type === "usage")).toBeLessThan(events.findIndex((event) => event.type === "response_end"));

      for (const target of GATEWAY_FORMATS) {
        expect(events.flatMap((event) => renderPublicStreamEvent(target, event)).length).toBeGreaterThan(0);
      }
    });
  }
});


describe("Gateway protocol core typing", () => {
  test("contains no untyped payload annotations outside the audited V1 boundary", async () => {
    const directory = import.meta.dir;
    const protocolFiles = (await readdir(directory))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "legacy.ts")
      .map((file) => join(directory, file));
    const files = [
      ...protocolFiles,
      join(directory, "../../provider-operation.ts"),
      join(directory, "../../../providers/types.ts"),
      join(directory, "../../../providers/registry.ts"),
      join(directory, "../../../services/anthropic-request.ts"),
      join(directory, "../../../services/responses-stream-consumer.ts"),
      join(directory, "../../../routes/proxy.ts"),
      join(directory, "../../../../providers.d/_handlers/codex.ts"),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/:\s*any\b|\bas\s+any\b|\bany\[\]|<any>/m.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
