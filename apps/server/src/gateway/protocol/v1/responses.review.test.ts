import { describe, expect, test } from "bun:test";
import {
  parseResponsesRequest,
  parseResponsesResponse,
  renderResponsesRequest,
  renderResponsesResponse,
} from "./responses";
import { parseChatResponse, renderChatResponse } from "./chat";
import {
  GATEWAY_IR_NAME,
  GATEWAY_IR_VERSION,
  type GatewayAdapterResult,
  type IrContentBlock,
  type IrUsage,
  irRequestSchema,
  irResponseSchema,
} from "./schemas";

function valueOf<T>(result: GatewayAdapterResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function responseWith(output: IrContentBlock[], usage?: IrUsage) {
  return irResponseSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "response",
    sourceFormat: "messages",
    compatibilityPolicy: "best-effort",
    compatibility: [],
    extensions: [],
    id: "resp_review_01",
    model: "provider/model",
    status: "completed",
    output,
    finishReason: output.some((block) => block.type === "tool_call") ? "tool_calls" : "stop",
    ...(usage ? { usage } : {}),
  });
}

function requestWithReasoning(block: Extract<IrContentBlock, { type: "reasoning" }>) {
  return irRequestSchema.parse({
    protocol: GATEWAY_IR_NAME,
    version: GATEWAY_IR_VERSION,
    kind: "request",
    sourceFormat: "messages",
    compatibilityPolicy: "best-effort",
    compatibility: [],
    extensions: [],
    model: "provider/model",
    stream: false,
    instructions: [],
    turns: [{ role: "assistant", blocks: [block] }],
    tools: [],
    sampling: {},
  });
}

describe("Responses adapter review regressions", () => {
  test("preserves encrypted prior reasoning through a same-format request round trip", () => {
    const parsed = valueOf(parseResponsesRequest({
      model: "canonical/model",
      input: [{
        type: "reasoning",
        id: "rs_prior",
        summary: [{ type: "summary_text", text: "prior reasoning" }],
        encrypted_content: "encrypted-state",
      }],
    }, "strict"));
    expect(parsed.turns[0]?.blocks[0]).toMatchObject({
      type: "reasoning",
      id: "rs_prior",
      text: "prior reasoning",
      encryptedContent: "encrypted-state",
    });

    const rendered = valueOf(renderResponsesRequest(
      parsed,
      "strict",
      "provider/raw-model",
    ));
    expect(rendered.input).toEqual([{
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "prior reasoning" }],
      encrypted_content: "encrypted-state",
    }]);
  });

  test("correlates adjacent missing call IDs and rejects an orphan output", () => {
    const parsed = valueOf(parseResponsesRequest({
      model: "canonical/model",
      input: [
        { type: "function_call", name: "lookup", arguments: "{\"query\":\"value\"}" },
        { type: "function_call_output", output: "result" },
      ],
    }, "strict"));
    const call = parsed.turns[0]?.blocks[0];
    const result = parsed.turns[1]?.blocks[0];
    expect(call?.type).toBe("tool_call");
    expect(result?.type).toBe("tool_result");
    if (call?.type !== "tool_call" || result?.type !== "tool_result") return;
    expect(result.callId).toBe(call.id);

    const rendered = valueOf(renderResponsesRequest(parsed, "strict", "provider/raw-model"));
    expect(rendered.input).toMatchObject([
      { type: "function_call", call_id: call.id },
      { type: "function_call_output", call_id: call.id },
    ]);

    for (const mode of ["strict", "best-effort"] as const) {
      const orphan = parseResponsesRequest({
        model: "canonical/model",
        input: [{ type: "function_call_output", output: "result" }],
      }, mode);
      expect(orphan.ok).toBe(false);
      if (!orphan.ok) {
        expect(orphan.error.findings[0]).toMatchObject({
          detailCode: "pointer_tool_call_invalid",
          assessment: {
            path: "input.0.call_id",
            state: "unsupported",
            bestEffortAllowed: false,
          },
        });
      }
    }
  });

  test("maps Responses content-filter incomplete details in both directions", () => {
    const parsed = valueOf(parseResponsesResponse({
      id: "resp_filtered",
      model: "provider/raw-model",
      status: "incomplete",
      output: [],
      incomplete_details: { reason: "content_filter" },
    }, "strict"));
    expect(parsed).toMatchObject({
      status: "incomplete",
      finishReason: "content_filter",
      rawFinishReason: "content_filter",
    });
    expect(valueOf(renderChatResponse(parsed, "best-effort")).choices).toMatchObject([
      { finish_reason: "content_filter" },
    ]);

    const rendered = valueOf(renderResponsesResponse({
      ...parsed,
      sourceFormat: "messages",
      extensions: [],
    }, "strict"));
    expect(rendered.incomplete_details).toEqual({ reason: "content_filter" });

    const chatFiltered = valueOf(parseChatResponse({
      id: "chat_filtered",
      model: "provider/raw-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "blocked" },
        finish_reason: "content_filter",
      }],
    }, "strict"));
    const chatAsResponses = valueOf(renderResponsesResponse(chatFiltered, "best-effort"));
    expect(chatAsResponses.status).toBe("incomplete");
    expect(chatAsResponses.incomplete_details).toEqual({ reason: "content_filter" });
  });

  test("malformed function parameters produce an unsupported compatibility finding", () => {
    for (const mode of ["strict", "best-effort"] as const) {
      const result = parseResponsesRequest({
        model: "provider/model",
        input: "hello",
        tools: [{ type: "function", name: "lookup", parameters: [] }],
      }, mode);

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const issue = result.error.findings.find((entry) =>
        entry.detailCode === "pointer_responses_function_parameters_invalid"
      );
      expect(issue?.assessment).toMatchObject({
        path: "tools.0.parameters",
        state: "unsupported",
        bestEffortAllowed: false,
      });
    }
  });

  test("invalid reasoning effort and summary are explicit and cannot be best-effort downgraded", () => {
    for (const mode of ["strict", "best-effort"] as const) {
      const result = parseResponsesRequest({
        model: "provider/model",
        input: "hello",
        reasoning: { effort: "maximum", summary: 7 },
      }, mode);

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.findings.map((entry) => entry.detailCode)).toEqual([
        "pointer_responses_reasoning_effort_invalid",
        "pointer_responses_reasoning_summary_invalid",
      ]);
      expect(result.error.findings.every((entry) =>
        entry.assessment.state === "unsupported" && !entry.assessment.bestEffortAllowed
      )).toBe(true);
    }
  });

  test("adjacent content sharing a Responses message ID renders as one ordered message", () => {
    const rendered = valueOf(renderResponsesResponse(responseWith([
      { type: "text", id: "msg_shared", text: "first" },
      { type: "refusal", id: "msg_shared", text: "second" },
      {
        type: "tool_call",
        id: "call_review",
        itemId: "fc_review",
        name: "lookup",
        arguments: { query: "third" },
      },
      { type: "text", id: "msg_shared", text: "fourth" },
    ])));

    expect(rendered.output).toEqual([
      {
        id: "msg_shared",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "first", annotations: [] },
          { type: "refusal", refusal: "second" },
        ],
      },
      {
        id: "fc_review",
        type: "function_call",
        status: "completed",
        call_id: "call_review",
        name: "lookup",
        arguments: "{\"query\":\"third\"}",
      },
      {
        id: "msg_shared",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "fourth", annotations: [] }],
      },
    ]);
  });

  test("request rendering reports signature loss while preserving encrypted reasoning", () => {
    const request = requestWithReasoning({
      type: "reasoning",
      id: "rs_request",
      text: "analysis",
      signature: "signed",
      encryptedContent: "encrypted",
    });
    const strict = renderResponsesRequest(request, "strict");

    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.error.findings).toHaveLength(1);
      expect(strict.error.findings[0]).toMatchObject({
        detailCode: "pointer_responses_reasoning_signature_dropped",
        assessment: { path: "turns.0.blocks.0.signature", state: "lossy" },
      });
    }

    const bestEffort = renderResponsesRequest(request, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (bestEffort.ok) {
      expect(bestEffort.findings[0]).toMatchObject({
        detailCode: "pointer_responses_reasoning_signature_dropped",
        assessment: { state: "lossy", bestEffortAllowed: true },
      });
    }

    const encryptedOnly = valueOf(renderResponsesRequest(requestWithReasoning({
      type: "reasoning",
      id: "rs_encrypted_request",
      text: "analysis",
      encryptedContent: "encrypted",
    })));
    expect(encryptedOnly.input).toEqual([{
      type: "reasoning",
      id: "rs_encrypted_request",
      summary: [{ type: "summary_text", text: "analysis" }],
      encrypted_content: "encrypted",
    }]);
  });

  test("response rendering reports signature and cache-creation usage loss", () => {
    const response = responseWith([{
      type: "reasoning",
      id: "rs_response",
      text: "analysis",
      signature: "signed",
      encryptedContent: "encrypted",
    }], {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheCreationInputTokens: 3,
    });
    const strict = renderResponsesResponse(response, "strict");

    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.error.findings.map((entry) => entry.detailCode)).toEqual([
        "pointer_responses_reasoning_signature_dropped",
        "pointer_responses_cache_creation_usage_dropped",
      ]);
      expect(strict.error.findings.every((entry) =>
        entry.assessment.state === "lossy" && entry.assessment.bestEffortAllowed
      )).toBe(true);
    }

    const bestEffort = renderResponsesResponse(response, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (bestEffort.ok) {
      expect(bestEffort.findings.map((entry) => entry.detailCode)).toEqual([
        "pointer_responses_reasoning_signature_dropped",
        "pointer_responses_cache_creation_usage_dropped",
      ]);
    }

    const encryptedOnly = valueOf(renderResponsesResponse(responseWith([{
      type: "reasoning",
      id: "rs_encrypted_response",
      text: "analysis",
      encryptedContent: "encrypted",
    }])));
    expect(encryptedOnly.output).toEqual([{
      id: "rs_encrypted_response",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "analysis" }],
      encrypted_content: "encrypted",
    }]);
  });
});
