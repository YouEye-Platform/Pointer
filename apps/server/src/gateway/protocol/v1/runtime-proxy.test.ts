import { describe, expect, test } from "bun:test";
import {
  FORMAT_FIXTURES,
  GATEWAY_FIXTURE_EXPECTATIONS,
  GATEWAY_FORMATS,
} from "../../fixtures/corpus";
import {
  createGatewayProxyStreamSelector,
  selectGatewayProxyError,
  selectGatewayProxyRequest,
  selectGatewayProxyResponse,
} from "./runtime-proxy";

function parseSseEvent(line: string): { event?: string; data: unknown } {
  const event = line.match(/^event: ([^\n]+)/m)?.[1];
  const data = line.match(/^data: (.*)$/m)?.[1];
  if (data === undefined) throw new Error("SSE fixture is missing data");
  return {
    ...(event ? { event } : {}),
    data: data === "[DONE]" ? data : JSON.parse(data),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseWithoutUnsignedReasoning(
  format: (typeof GATEWAY_FORMATS)[number],
): unknown {
  const response = structuredClone(FORMAT_FIXTURES[format].response);
  if (format === "chat-completions") {
    const choices = response.choices;
    if (Array.isArray(choices) && isObject(choices[0])) {
      const message = choices[0].message;
      if (isObject(message)) delete message.reasoning_content;
    }
  } else if (format === "responses" && Array.isArray(response.output)) {
    response.output = response.output.filter((item) =>
      !isObject(item) || item.type !== "reasoning"
    );
  }
  return response;
}

describe("gateway V1 proxy request selection", () => {
  test("accepts Claude Code adaptive thinking and preserves it on Messages routes", () => {
    const payload = {
      model: "opus",
      max_tokens: 128,
      messages: [{ role: "user", content: [{ type: "text", text: "OK" }] }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "high" },
    };
    const messagesResult = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: "messages",
      payload,
      providerModelId: "provider-model",
    });
    expect(messagesResult.ok).toBe(true);
    if (messagesResult.ok) {
      expect(messagesResult.request.thinking).toEqual({ type: "adaptive" });
    }

    const responsesResult = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: "responses",
      payload,
      providerModelId: "provider-model",
    });
    expect(responsesResult.ok).toBe(true);
    if (responsesResult.ok) {
      expect(responsesResult.request.reasoning).toEqual({ effort: "high" });
    }
  });

  test("strips unsupported Claude Code beta controls while preserving ordinary content", () => {
    const result = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: "chat-completions",
      providerModelId: "gemini-provider-model",
      payload: {
        model: "gemini",
        max_tokens: 256,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        context_management: { edits: [] },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
          cache_control: { type: "ephemeral" },
        }],
        messages: [{ role: "user", content: [{ type: "text", text: "Read package.json", cache_control: { type: "ephemeral" } }] }],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).toMatchObject({
      model: "gemini-provider-model",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
        { role: "user", content: "Read package.json" },
      ],
    });
    expect(result.request.thinking).toBeUndefined();
    expect(result.request.output_config).toBeUndefined();
    expect(result.request.context_management).toBeUndefined();
    expect(result.request.cache_control).toBeUndefined();
    expect(JSON.stringify(result.request)).not.toContain("cache_control");
  });

  test("preserves Gemini thought signatures through a complete parallel tool loop", () => {
    const metadata = { google: { thought_signature: "signature_fixture" } };
    const firstResponse = selectGatewayProxyResponse({
      sourceFormat: "chat-completions",
      targetFormat: "messages",
      model: "google/gemini",
      payload: {
        id: "chatcmpl_gemini_tools",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          message: {
            role: "model",
            content: null,
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: { name: "weather", arguments: "{\"city\":\"Paris\"}" },
                extra_content: metadata,
              },
              {
                id: "call_time",
                type: "function",
                function: { name: "time", arguments: "{\"zone\":\"UTC\"}" },
              },
              {
                id: "call_failed",
                type: "function",
                function: { name: "restricted", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
      },
    });

    expect(firstResponse.ok).toBe(true);
    if (!firstResponse.ok) return;
    expect(firstResponse.response.stop_reason).toBe("tool_use");
    expect(firstResponse.response.content).toEqual([
      { type: "tool_use", id: "call_weather", name: "weather", input: { city: "Paris" }, extra_content: metadata },
      { type: "tool_use", id: "call_time", name: "time", input: { zone: "UTC" } },
      { type: "tool_use", id: "call_failed", name: "restricted", input: {} },
    ]);

    const nextRequest = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: "chat-completions",
      providerModelId: "gemini-provider-model",
      payload: {
        model: "google/gemini",
        max_tokens: 128,
        tools: [
          { name: "weather", input_schema: { type: "object" } },
          { name: "time", input_schema: { type: "object" } },
          { name: "restricted", input_schema: { type: "object" } },
        ],
        messages: [
          { role: "user", content: "Check both" },
          { role: "assistant", content: firstResponse.response.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_weather", content: "17 C" },
              { type: "tool_result", tool_use_id: "call_time", content: [{ type: "text", text: "12:00" }] },
              { type: "tool_result", tool_use_id: "call_failed", content: "permission denied", is_error: true },
            ],
          },
        ],
      },
    });

    expect(nextRequest.ok).toBe(true);
    if (!nextRequest.ok) return;
    const messages = nextRequest.request.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call_weather", extra_content: metadata },
        { id: "call_time" },
        { id: "call_failed" },
      ],
    });
    expect(messages.slice(2)).toEqual([
      { role: "tool", tool_call_id: "call_weather", name: "weather", content: "17 C" },
      { role: "tool", tool_call_id: "call_time", name: "time", content: "[{\"type\":\"text\",\"text\":\"12:00\"}]" },
      { role: "tool", tool_call_id: "call_failed", name: "restricted", content: "{\"error\":\"permission denied\"}" },
    ]);

    const finalResponse = selectGatewayProxyResponse({
      sourceFormat: "chat-completions",
      targetFormat: "messages",
      model: "google/gemini",
      payload: {
        id: "chatcmpl_gemini_final",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Done" },
          finish_reason: "stop",
        }],
      },
    });
    expect(finalResponse.ok).toBe(true);
    if (finalResponse.ok) expect(finalResponse.response.stop_reason).toBe("end_turn");
  });

  test("preserves OpenRouter Gemini reasoning details through an Anthropic tool loop", () => {
    const reasoningDetails = [{
      type: "reasoning.encrypted",
      data: "opaque_reasoning_fixture",
      format: "google-gemini-v1",
      id: "reasoning_fixture",
      index: 0,
    }];
    const firstResponse = selectGatewayProxyResponse({
      sourceFormat: "chat-completions",
      targetFormat: "messages",
      model: "google/gemini",
      payload: {
        id: "chatcmpl_openrouter_gemini",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning: null,
            reasoning_details: reasoningDetails,
            tool_calls: [{
              index: 0,
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: "{\"key\":\"alpha\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    });

    expect(firstResponse.ok).toBe(true);
    if (!firstResponse.ok) return;
    expect(firstResponse.response).toMatchObject({
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "call_lookup",
        name: "lookup",
        extra_content: { openrouter: { reasoning_details: reasoningDetails } },
      }],
    });

    const nextRequest = selectGatewayProxyRequest({
      sourceFormat: "messages",
      targetFormat: "chat-completions",
      providerModelId: "gemini-provider-model",
      payload: {
        model: "google/gemini",
        max_tokens: 128,
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "Look up alpha" },
          { role: "assistant", content: firstResponse.response.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_lookup", content: "fixture-ok" }] },
        ],
      },
    });

    expect(nextRequest.ok).toBe(true);
    if (!nextRequest.ok) return;
    expect(nextRequest.request.messages).toEqual([
      { role: "user", content: "Look up alpha" },
      {
        role: "assistant",
        content: null,
        reasoning_details: reasoningDetails,
        tool_calls: [{
          id: "call_lookup",
          type: "function",
          function: { name: "lookup", arguments: "{\"key\":\"alpha\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_lookup", name: "lookup", content: "fixture-ok" },
    ]);
  });

  for (const sourceFormat of GATEWAY_FORMATS) {
    for (const targetFormat of GATEWAY_FORMATS) {
      test(`${sourceFormat} -> ${targetFormat} uses the provider raw model`, () => {
        const result = selectGatewayProxyRequest({
          sourceFormat,
          targetFormat,
          payload: FORMAT_FIXTURES[sourceFormat].request,
          providerModelId: GATEWAY_FIXTURE_EXPECTATIONS.providerRawModel,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.primaryEngine).toBe("v1");
        expect(result.request.model).toBe(GATEWAY_FIXTURE_EXPECTATIONS.providerRawModel);
      });
    }
  }

  for (const sourceFormat of GATEWAY_FORMATS) {
    test(`${sourceFormat} rejects invalid input without echoing it`, () => {
      const privateValue = ["do", "not", "expose"].join("-");
      const result = selectGatewayProxyRequest({
        sourceFormat,
        targetFormat: "chat-completions",
        payload: { model: "model", authorization: privateValue },
        providerModelId: "provider-model",
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(JSON.stringify(result)).not.toContain("authorization");
    });
  }
});

describe("gateway V1 proxy response selection", () => {
  test("streams parallel Gemini tool calls as Anthropic tool_use blocks with metadata", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "messages",
      model: "google/gemini",
      requestId: "ptrreq_gemini_parallel_tools",
    });
    const metadata = { google: { thought_signature: "stream_signature_fixture" } };
    const output: string[] = [];

    output.push(...selector.push({
      data: {
        id: "chatcmpl_gemini_stream",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "first", arguments: "{\"x\":1}" },
                extra_content: metadata,
              },
              {
                index: 1,
                id: "call_b",
                type: "function",
                function: { name: "second", arguments: "{\"y\":2}" },
              },
            ],
          },
          finish_reason: null,
        }],
      },
    }).lines);
    output.push(...selector.push({
      data: {
        id: "chatcmpl_gemini_stream",
        model: "gemini-provider-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    }).lines);
    output.push(...selector.push({ data: "[DONE]" }).lines);

    const events = output.map(parseSseEvent);
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]?.data).toMatchObject({
      content_block: {
        type: "tool_use",
        id: "call_a",
        name: "first",
        extra_content: metadata,
      },
    });
    expect(events[2]?.data).toMatchObject({ delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } });
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
    expect(selector.failed()).toBe(false);
    expect(selector.ended()).toBe(true);
  });

  test("streams OpenRouter Gemini reasoning details on the Anthropic tool block", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "messages",
      model: "google/gemini",
      requestId: "ptrreq_openrouter_gemini_tools",
    });
    const output: string[] = [];

    output.push(...selector.push({
      data: {
        id: "chatcmpl_openrouter_gemini_stream",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            reasoning_details: [{
              type: "reasoning.encrypted",
              data: "opaque_",
              format: "google-gemini-v1",
              id: "reasoning_stream_fixture",
              index: 0,
            }],
          },
          finish_reason: null,
        }],
      },
    }).lines);
    output.push(...selector.push({
      data: {
        id: "chatcmpl_openrouter_gemini_stream",
        model: "gemini-provider-model",
        choices: [{
          index: 0,
          delta: {
            reasoning_details: [{ index: 0, data: "reasoning_fixture" }],
            tool_calls: [{
              index: 0,
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: "{\"key\":\"beta\"}" },
            }],
          },
          finish_reason: null,
        }],
      },
    }).lines);
    output.push(...selector.push({
      data: {
        id: "chatcmpl_openrouter_gemini_stream",
        model: "gemini-provider-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    }).lines);
    output.push(...selector.push({ data: "[DONE]" }).lines);

    const events = output.map(parseSseEvent);
    const toolStart = events.find((event) =>
      isObject(event.data)
      && event.data.type === "content_block_start"
      && isObject(event.data.content_block)
      && event.data.content_block.type === "tool_use"
    );
    expect(toolStart?.data).toMatchObject({
      content_block: {
        type: "tool_use",
        extra_content: {
          openrouter: {
            reasoning_details: [{
              type: "reasoning.encrypted",
              data: "opaque_reasoning_fixture",
              format: "google-gemini-v1",
              id: "reasoning_stream_fixture",
              index: 0,
            }],
          },
        },
      },
    });
    expect(events.some((event) =>
      isObject(event.data)
      && isObject(event.data.delta)
      && event.data.delta.type === "input_json_delta"
    )).toBe(true);
    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
    expect(events.at(-1)?.event).toBe("message_stop");
  });

  test("forwards long Responses tool arguments to Messages as each delta arrives", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      requestId: "ptrreq_long_tool_arguments",
    });
    const firstFragment = `{"html":"${"a".repeat(24_000)}`;
    const secondFragment = `${"b".repeat(24_000)}"}`;

    selector.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_long_arguments",
          type: "function_call",
          status: "in_progress",
          call_id: "call_long_arguments",
          name: "save_report",
          arguments: "",
        },
      },
    });
    const firstOutput = selector.push({
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_long_arguments",
        output_index: 0,
        call_id: "call_long_arguments",
        delta: firstFragment,
      },
    }).lines.join("");
    const secondOutput = selector.push({
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_long_arguments",
        output_index: 0,
        call_id: "call_long_arguments",
        delta: secondFragment,
      },
    }).lines.join("");

    expect(parseSseEvent(firstOutput).data).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: firstFragment },
    });
    expect(parseSseEvent(secondOutput).data).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: secondFragment },
    });

    const terminal = selector.push({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "resp_long_arguments",
          object: "response",
          status: "completed",
          model: "provider/model",
          output: [],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      },
    }).lines.join("");
    expect(terminal).toContain("message_stop");
    expect(selector.failed()).toBe(false);
  });

  for (const targetFormat of GATEWAY_FORMATS) {
    test(`ignores data-bearing Responses heartbeats for ${targetFormat}`, () => {
      const selector = createGatewayProxyStreamSelector({
        sourceFormat: "responses",
        targetFormat,
        model: "canonical/model",
        requestId: `ptrreq_responses_heartbeat_${targetFormat.replaceAll("-", "_")}`,
      });

      expect(selector.push({ event: "keepalive", data: { type: "keepalive" } }).lines).toEqual([]);
      expect(selector.push({ event: "ping", data: { type: "ping" } }).lines).toEqual([]);
      selector.push({
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_heartbeat", model: "provider/model", status: "in_progress" },
        },
      });
      const output = selector.push({
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_heartbeat",
            model: "provider/model",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          },
        },
      }).lines.join("");

      expect(selector.failed()).toBe(false);
      expect(selector.ended()).toBe(true);
      expect(output).not.toContain("pointer_stream_translation_error");
    });
  }

  for (const targetFormat of GATEWAY_FORMATS) {
    test(`normalizes Responses stream errors for ${targetFormat} without exposing provider data`, () => {
      const selector = createGatewayProxyStreamSelector({
        sourceFormat: "responses",
        targetFormat,
        model: "canonical/model",
        requestId: `ptrreq_responses_error_${targetFormat.replaceAll("-", "_")}`,
      });
      selector.push({
        event: "response.created",
        data: {
          type: "response.created",
          response: {
            id: "resp_provider_error",
            model: "provider/model",
            status: "in_progress",
          },
        },
      });
      selector.push({
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "reasoning_provider_error",
            type: "reasoning",
            status: "in_progress",
            summary: [],
          },
        },
      });
      const privateMessage = ["provider", "private", "failure"].join("-");
      const output = selector.push({
        event: "error",
        data: {
          type: "error",
          code: "provider_private_code",
          message: privateMessage,
          param: null,
        },
      }).lines.join("");

      expect(selector.failed()).toBe(false);
      expect(selector.upstreamFailed()).toBe(true);
      expect(selector.ended()).toBe(true);
      expect(selector.finish().lines).toEqual([]);
      expect(output).not.toContain(privateMessage);
      expect(output).not.toContain("provider_private_code");
      expect(output).not.toContain("diagnosticVersion");
      if (targetFormat === "messages") {
        expect(output).toContain('"type":"api_error"');
        expect(output).toContain('"code":"pointer_upstream_unavailable"');
      } else if (targetFormat === "responses") {
        expect(output).toContain("pointer_upstream_unavailable");
        expect(output).toContain("event: error");
        expect(output).toContain('"type":"error"');
      } else if (targetFormat === "google-generate-content") {
        expect(output).toContain("pointer_upstream_unavailable");
        expect(output).toContain('"status":"INTERNAL"');
      } else {
        expect(output).toContain("pointer_upstream_unavailable");
        expect(output).toContain('"type":"server_error"');
      }
    });
  }

  for (const targetFormat of GATEWAY_FORMATS) {
    test(`rejects an empty successful Responses stream for ${targetFormat}`, () => {
      const selector = createGatewayProxyStreamSelector({
        sourceFormat: "responses",
        targetFormat,
        model: "canonical/model",
        requestId: `ptrreq_empty_${targetFormat.replaceAll("-", "_")}`,
      });
      selector.push({
        event: "response.created",
        data: {
          type: "response.created",
          response: { id: "resp_empty", model: "provider/model", status: "in_progress" },
        },
      });
      const output = selector.push({
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_empty",
            model: "provider/model",
            status: "completed",
            output: [],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        },
      }).lines.join("");

      expect(selector.failed()).toBe(false);
      expect(selector.upstreamFailed()).toBe(true);
      expect(selector.ended()).toBe(true);
      expect(output).toContain("pointer_empty_response");
      expect(output).not.toContain("pointer_stream_translation_error");
    });
  }

  test("normalizes response.failed as an upstream failure", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      requestId: "ptrreq_failed_terminal",
    });
    selector.push({
      event: "response.created",
      data: {
        type: "response.created",
        response: { id: "resp_failed", model: "provider/model", status: "in_progress" },
      },
    });
    const output = selector.push({
      event: "response.failed",
      data: {
        type: "response.failed",
        response: {
          id: "resp_failed",
          model: "provider/model",
          status: "failed",
          output: [],
          error: { code: "private_provider_code", message: "private provider detail" },
        },
      },
    }).lines.join("");

    expect(selector.upstreamFailed()).toBe(true);
    expect(output).toContain("pointer_upstream_unavailable");
    expect(output).not.toContain("private_provider_code");
    expect(output).not.toContain("private provider detail");
  });

  test("does not treat an empty message item as model output", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      requestId: "ptrreq_empty_message_item",
    });
    selector.push({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_empty", type: "message", role: "assistant", status: "in_progress", content: [] },
      },
    });
    const output = selector.push({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: { id: "resp_empty_message", model: "provider/model", status: "completed", output: [] },
      },
    }).lines.join("");

    expect(selector.upstreamFailed()).toBe(true);
    expect(output).toContain("pointer_empty_response");
  });

  test("accepts conventional nullable OpenAI-compatible response fields", () => {
    const result = selectGatewayProxyResponse({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      payload: {
        id: "chatcmpl_nullable_fields",
        object: "chat.completion",
        created: 1,
        model: "provider/model",
        choices: [{
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: {
            role: "assistant",
            content: "OK",
            name: null,
            reasoning_content: null,
            tool_calls: null,
          },
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 1,
          total_tokens: 5,
          prompt_tokens_details: null,
          completion_tokens_details: null,
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.primaryEngine).toBe("v1");
    expect(result.response.object).toBe("chat.completion");
  });

  test("accepts current Codex Responses cache-write usage details", () => {
    const result = selectGatewayProxyResponse({
      sourceFormat: "responses",
      targetFormat: "chat-completions",
      model: "canonical/model",
      payload: {
        id: "resp_codex_cache_write",
        object: "response",
        model: "provider/model",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        }],
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          total_tokens: 5,
          input_tokens_details: {
            cached_tokens: 0,
            cache_write_tokens: 4,
          },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        background: false,
        completed_at: 1,
        instructions: "Be concise.",
        metadata: {},
        prompt_cache_key: "cache-fixture",
        reasoning: { effort: "medium" },
        safety_identifier: "fixture-user",
        text: { format: { type: "text" } },
        tool_usage: {},
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.object).toBe("chat.completion");
  });

  test("accepts current Grok Responses item and usage extensions", () => {
    const payload = {
      id: "resp_grok_extensions",
      object: "response",
      model: "provider/model",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "reasoning-fixture",
          status: "completed",
          summary: [],
        },
        {
          type: "message",
          id: "message-fixture",
          status: "completed",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "OK",
            annotations: [],
            logprobs: [],
          }],
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 6,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 1 },
        context_details: { input_tokens: 4, output_tokens: 2 },
        cost_in_usd_ticks: 0,
        num_server_side_tools_used: 0,
      },
    };
    const result = selectGatewayProxyResponse({
      sourceFormat: "responses",
      targetFormat: "responses",
      model: "canonical/model",
      payload,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response).toMatchObject({
      object: "response",
      status: "completed",
      model: "canonical/model",
      usage: {
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 6,
      },
    });

    const messagesResult = selectGatewayProxyResponse({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      payload,
    });
    expect(messagesResult.ok).toBe(true);
    if (!messagesResult.ok) return;
    expect(messagesResult.response).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
  });

  test("accepts OpenRouter-compatible nested response extensions", () => {
    const result = selectGatewayProxyResponse({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      payload: {
        id: "chatcmpl_openrouter_extensions",
        object: "chat.completion",
        model: "provider/model",
        provider: "OpenRouter",
        service_tier: "default",
        system_fingerprint: null,
        choices: [{
          index: 0,
          finish_reason: "stop",
          native_finish_reason: "stop",
          message: {
            role: "assistant",
            content: "OK",
            reasoning: "brief reasoning",
            refusal: null,
          },
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 1,
          total_tokens: 5,
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.object).toBe("chat.completion");
    expect(result.response.choices).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ reasoning_content: "brief reasoning" }),
      }),
    ]);
  });

  for (const sourceFormat of GATEWAY_FORMATS) {
    for (const targetFormat of GATEWAY_FORMATS) {
      test(`${sourceFormat} -> ${targetFormat} translates JSON`, () => {
        const result = selectGatewayProxyResponse({
          sourceFormat,
          targetFormat,
          payload: responseWithoutUnsignedReasoning(sourceFormat),
          model: GATEWAY_FIXTURE_EXPECTATIONS.canonicalModel,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.primaryEngine).toBe("v1");
      });

      test(`${sourceFormat} -> ${targetFormat} normalizes errors`, () => {
        const result = selectGatewayProxyError({
          sourceFormat,
          targetFormat,
          status: 429,
          headers: { "retry-after": "1", "x-provider-private": "hidden" },
          requestId: "ptrreq_fixture_error_01",
        });
        expect(result.primaryEngine).toBe("v1");
        expect(result.status).toBe(429);
        expect(result.headers["retry-after"]).toBe("1");
        expect(JSON.stringify(result)).not.toContain("x-provider-private");
      });

      test(`${sourceFormat} -> ${targetFormat} translates complete streams`, () => {
        const selector = createGatewayProxyStreamSelector({
          sourceFormat,
          targetFormat,
          model: GATEWAY_FIXTURE_EXPECTATIONS.canonicalModel,
          requestId: "ptrreq_v1_stream_test",
        });
        const lines = FORMAT_FIXTURES[sourceFormat].stream.flatMap((line) =>
          selector.push(parseSseEvent(line)).lines
        );
        lines.push(...selector.finish().lines);
        expect(selector.primaryEngine).toBe("v1");
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join("\n")).not.toContain("Provider stream translation failed.");
      });
    }
  }

  test("invalid provider payloads return a redacted stable error", () => {
    const privateValue = ["do", "not", "expose"].join("-");
    const result = selectGatewayProxyResponse({
      sourceFormat: "responses",
      targetFormat: "chat-completions",
      payload: { provider_private_field: privateValue },
      model: "model",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain("provider_private_field");
  });

  test("accepts finish, separate usage, and DONE without a false stream failure", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      requestId: "ptrreq_split_usage_stream",
    });
    const lines = [
      ...selector.push({
        data: {
          id: "chatcmpl_split_usage",
          model: "provider/model",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
        },
      }).lines,
      ...selector.push({
        data: {
          id: "chatcmpl_split_usage",
          model: "provider/model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      }).lines,
      ...selector.push({
        data: {
          id: "chatcmpl_split_usage",
          model: "provider/model",
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        },
      }).lines,
      ...selector.push({ data: "[DONE]" }).lines,
      ...selector.finish().lines,
    ];
    const output = lines.join("\n");
    expect(output).toContain("\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1,\"total_tokens\":5}");
    expect(output).toContain("\"finish_reason\":\"stop\"");
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain("upstream_error");
    expect(selector.failed()).toBe(false);
    expect(selector.usage()).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
    });
  });

  test("accepts OpenRouter repeated finish with final usage", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      requestId: "ptrreq_openrouter_repeated_finish",
    });
    const lines = [
      ...selector.push({
        data: {
          id: "chatcmpl_openrouter",
          model: "provider/model",
          choices: [{
            index: 0,
            delta: { content: "", reasoning: "brief reasoning", role: "assistant" },
            finish_reason: null,
          }],
        },
      }).lines,
      ...selector.push({
        data: {
          id: "chatcmpl_openrouter",
          model: "provider/model",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
        },
      }).lines,
      ...selector.push({
        data: {
          id: "chatcmpl_openrouter",
          model: "provider/model",
          choices: [{
            index: 0,
            delta: { content: "", reasoning: "", role: "assistant" },
            finish_reason: "stop",
          }],
        },
      }).lines,
      ...selector.push({
        data: {
          id: "chatcmpl_openrouter",
          model: "provider/model",
          choices: [{
            index: 0,
            delta: { content: "", role: "assistant" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        },
      }).lines,
      ...selector.push({ data: "[DONE]" }).lines,
      ...selector.finish().lines,
    ];
    const output = lines.join("\n");
    expect(output).toContain("\"reasoning_content\":\"brief reasoning\"");
    expect(output).toContain("\"content\":\"OK\"");
    expect(output).toContain("\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7}");
    expect(output).toContain("\"finish_reason\":\"stop\"");
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain("upstream_error");
    expect(selector.failed()).toBe(false);
  });

  test("clean EOF finalizes an observed Chat finish without reporting failure", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      requestId: "ptrreq_clean_eof_stream",
    });
    selector.push({
      data: {
        id: "chatcmpl_clean_eof",
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      },
    });
    selector.push({
      data: {
        id: "chatcmpl_clean_eof",
        model: "provider/model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    });
    const output = selector.finish().lines.join("\n");
    expect(output).toContain("\"finish_reason\":\"stop\"");
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain("upstream_error");
    expect(selector.failed()).toBe(false);
  });

  test("reports selector failure state for an unterminated stream", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "chat-completions",
      targetFormat: "chat-completions",
      model: "canonical/model",
      requestId: "ptrreq_unterminated_stream",
    });
    selector.push({
      data: {
        id: "chatcmpl_unterminated",
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      },
    });
    expect(selector.finish().lines.join("\n")).toContain("pointer_stream_interrupted");
    expect(selector.failed()).toBe(true);
    expect(selector.upstreamFailed()).toBe(false);
    expect(selector.ended()).toBe(false);
    expect(selector.failure()).toEqual({
      kind: "interrupted",
      sourceEventType: null,
      outputObserved: true,
    });
  });

  test("drops schema-optional empty string tool arguments before Messages execution", () => {
    const selector = createGatewayProxyStreamSelector({
      sourceFormat: "responses",
      targetFormat: "messages",
      model: "canonical/model",
      requestId: "ptrreq_optional_empty_tool_argument",
      toolSchemas: {
        Read: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            pages: { type: "string" },
          },
          required: ["file_path"],
        },
      },
    });
    const lines = [
      ...selector.push({
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_read",
            type: "function_call",
            status: "in_progress",
            call_id: "call_read",
            name: "Read",
            arguments: "",
          },
        },
      }).lines,
      ...selector.push({
        event: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          call_id: "call_read",
          delta: '{"file_path":"/workspace/README.md","pages":""}',
        },
      }).lines,
      ...selector.push({
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: 0 },
      }).lines,
      ...selector.push({
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_read",
            object: "response",
            status: "completed",
            model: "provider/model",
            output: [],
          },
        },
      }).lines,
    ];
    const output = lines.join("\n");
    expect(output).toContain('partial_json":"{\\"file_path\\":\\"/workspace/README.md\\"}"');
    expect(output).not.toContain('pages');
    expect(selector.failure()).toBeNull();
  });
});
