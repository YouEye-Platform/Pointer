import { describe, expect, test } from "bun:test";
import type { GatewayAdapterFailure, IrStreamEvent } from "./schemas";
import {
  createStreamAdapterContext,
  parsePublicStreamEvent,
  renderPublicStreamTrace,
  type ParsedStreamEvent,
  type PublicStreamEvent,
} from "./stream";

function parsed(result: ParsedStreamEvent | GatewayAdapterFailure): ParsedStreamEvent {
  if ("ok" in result) throw new Error(result.error.message);
  return result;
}

function eventNames(events: readonly PublicStreamEvent[]): Array<string | undefined> {
  return events.map((event) => event.event);
}

describe("Gateway V1 IR stream lifecycle review", () => {
  test("fallback response IDs are stable per request and not shared by model", () => {
    const first = createStreamAdapterContext("provider/model", "request-a");
    const repeated = createStreamAdapterContext("provider/model", "request-a");
    const second = createStreamAdapterContext("provider/model", "request-b");
    expect(first.responseId).toBe(repeated.responseId);
    expect(first.responseId).not.toBe(second.responseId);
    expect(first.requestId).toBe("request-a");
  });

  test("Chat holds the terminal until DONE so a separate usage chunk remains valid", () => {
    let context = createStreamAdapterContext("provider/model", "chat-request");
    const delta = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      },
    }, context));
    expect(delta.events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "text_delta",
    ]);
    context = delta.context;

    const finish = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
      },
    }, context));
    expect(finish.events.map((event) => event.type)).toEqual(["content_end"]);
    expect(finish.context.openBlocks).toEqual({});
    expect(finish.context.finishObserved).toBe(true);
    expect(finish.context.finishReason).toBe("content_filter");
    expect(finish.context.ended).toBe(false);
    context = finish.context;

    const usage = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    }, context));
    expect(usage.events).toEqual([
      expect.objectContaining({
        type: "usage",
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      }),
    ]);
    expect(usage.context.ended).toBe(false);

    const done = parsed(parsePublicStreamEvent(
      "chat-completions",
      { data: "[DONE]" },
      usage.context,
    ));
    expect(done.events).toEqual([
      expect.objectContaining({
        type: "response_end",
        finishReason: "content_filter",
      }),
    ]);
    expect(done.context.ended).toBe(true);

    const rendered = renderPublicStreamTrace("chat-completions", [
      ...delta.events,
      ...finish.events,
      ...usage.events,
      ...done.events,
    ]);
    expect(rendered.at(-3)?.data).toMatchObject({
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
    expect(rendered.at(-2)?.data).toMatchObject({
      choices: [{ finish_reason: "content_filter" }],
    });
    expect(rendered.at(-1)?.data).toBe("[DONE]");
  });

  test("Chat rejects meaningful content after a finish reason", () => {
    const finish = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    }, createStreamAdapterContext("provider/model", "chat-after-finish")));
    const result = parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "late" }, finish_reason: null }],
      },
    }, finish.context);
    expect("ok" in result).toBe(true);
  });

  test("Chat accepts OpenRouter repeated finish usage and reasoning aliases", () => {
    let context = createStreamAdapterContext("provider/model", "chat-openrouter");
    const reasoning = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{
          index: 0,
          delta: { reasoning: "brief reasoning", content: "" },
          finish_reason: null,
        }],
      },
    }, context));
    expect(reasoning.events).toEqual([
      expect.objectContaining({ type: "response_start" }),
      expect.objectContaining({ type: "content_start", block: { type: "reasoning", text: "" } }),
      expect.objectContaining({ type: "reasoning_delta", delta: "brief reasoning" }),
    ]);
    context = reasoning.context;

    const answer = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      },
    }, context));
    context = answer.context;

    const finish = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "", reasoning: "" }, finish_reason: "stop" }],
      },
    }, context));
    context = finish.context;

    const repeatedFinishWithUsage = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      },
    }, context));
    expect(repeatedFinishWithUsage.events).toEqual([
      expect.objectContaining({
        type: "usage",
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      }),
    ]);
    expect(repeatedFinishWithUsage.context.finishReason).toBe("stop");
    expect(repeatedFinishWithUsage.context.ended).toBe(false);

    const done = parsed(parsePublicStreamEvent("chat-completions", {
      data: "[DONE]",
    }, repeatedFinishWithUsage.context));
    expect(done.events).toEqual([
      expect.objectContaining({ type: "response_end", finishReason: "stop" }),
    ]);
  });

  test("Chat rejects a conflicting repeated finish reason", () => {
    const finish = parsed(parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    }, createStreamAdapterContext("provider/model", "chat-conflicting-finish")));
    const result = parsePublicStreamEvent("chat-completions", {
      data: {
        model: "provider/model",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      },
    }, finish.context);
    expect("ok" in result).toBe(true);
  });

  test("Messages synthesizes missing starts and merges input and output usage snapshots", () => {
    let context = createStreamAdapterContext("provider/model", "messages-request");
    const allEvents: IrStreamEvent[] = [];
    const start = parsed(parsePublicStreamEvent("messages", {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_review",
          model: "provider/model",
          usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 3 },
        },
      },
    }, context));
    allEvents.push(...start.events);
    context = start.context;

    const delta = parsed(parsePublicStreamEvent("messages", {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
    }, context));
    expect(delta.events.map((event) => event.type)).toEqual(["content_start", "text_delta"]);
    allEvents.push(...delta.events);
    context = delta.context;

    const usage = parsed(parsePublicStreamEvent("messages", {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 18, reasoning_tokens: 6 },
      },
    }, context));
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({
      type: "usage",
      usage: {
        inputTokens: 45,
        outputTokens: 18,
        totalTokens: 63,
        cachedInputTokens: 3,
        reasoningTokens: 6,
      },
    });
    allEvents.push(...usage.events);
    context = usage.context;

    const stop = parsed(parsePublicStreamEvent("messages", {
      event: "message_stop",
      data: { type: "message_stop" },
    }, context));
    expect(stop.events.map((event) => event.type)).toEqual(["content_end", "response_end"]);
    expect(stop.events.at(-1)).toMatchObject({ type: "response_end", finishReason: "stop" });
    allEvents.push(...stop.events);

    const rendered = renderPublicStreamTrace("messages", allEvents);
    expect(eventNames(rendered)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(rendered[0]?.data).toMatchObject({
      message: { usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 3 } },
    });
    expect(rendered.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 18, reasoning_tokens: 6 },
    });
  });

  test("Responses synthesizes lifecycle and retains cancelled and content-filter terminals", () => {
    let context = createStreamAdapterContext("provider/model", "responses-request");
    const allEvents: IrStreamEvent[] = [];
    const delta = parsed(parsePublicStreamEvent("responses", {
      event: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning_review",
        output_index: 0,
        delta: "considering",
      },
    }, context));
    expect(delta.events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "reasoning_delta",
    ]);
    allEvents.push(...delta.events);
    context = delta.context;

    const terminal = parsed(parsePublicStreamEvent("responses", {
      event: "response.cancelled",
      data: {
        type: "response.cancelled",
        response: {
          id: "resp_review",
          model: "provider/model",
          status: "cancelled",
          usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
        },
      },
    }, context));
    expect(terminal.events.map((event) => event.type)).toEqual([
      "content_end",
      "usage",
      "response_end",
    ]);
    expect(terminal.events.at(-1)).toMatchObject({
      type: "response_end",
      finishReason: "cancelled",
    });
    allEvents.push(...terminal.events);

    const rendered = renderPublicStreamTrace("responses", allEvents);
    expect(eventNames(rendered)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.cancelled",
    ]);
    expect(rendered.at(-1)?.data).toMatchObject({
      response: {
        status: "cancelled",
        usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
        output: [{ id: "reasoning_review", type: "reasoning" }],
      },
    });

    const filtered = parsed(parsePublicStreamEvent("responses", {
      event: "response.incomplete",
      data: {
        type: "response.incomplete",
        response: {
          id: "resp_filtered",
          model: "provider/model",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
    }, createStreamAdapterContext("provider/model", "filtered-request")));
    expect(filtered.events.at(-1)).toMatchObject({
      type: "response_end",
      finishReason: "content_filter",
    });
    expect(renderPublicStreamTrace("responses", filtered.events).at(-1)).toMatchObject({
      event: "response.incomplete",
      data: { response: { incomplete_details: { reason: "content_filter" } } },
    });

    const failed = parsed(parsePublicStreamEvent("responses", {
      event: "response.failed",
      data: {
        type: "response.failed",
        response: { id: "resp_failed", model: "provider/model", status: "failed" },
      },
    }, createStreamAdapterContext("provider/model", "failed-request")));
    expect(failed.events.at(-1)).toMatchObject({
      type: "response_end",
      finishReason: "error",
    });
    expect(renderPublicStreamTrace("responses", failed.events).at(-1)).toMatchObject({
      event: "response.failed",
      data: { response: { status: "failed" } },
    });
  });

  test("unknown Messages and Responses events return stable adapter failures", () => {
    for (const format of ["messages", "responses"] as const) {
      const result = parsePublicStreamEvent(format, {
        event: "provider.secret_event",
        data: { type: "provider.secret_event", token: "must-not-echo" },
      }, createStreamAdapterContext("provider/model", `${format}-unknown`));
      expect("ok" in result).toBe(true);
      if ("ok" in result) {
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain("must-not-echo");
      }
    }
  });

  test("Chat trace emits usage before terminal and a single done marker", () => {
    let context = createStreamAdapterContext("provider/model", "chat-trace-request");
    const events: IrStreamEvent[] = [];
    for (const data of [
      {
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ]) {
      const result = parsed(parsePublicStreamEvent("chat-completions", { data }, context));
      events.push(...result.events);
      context = result.context;
    }
    const done = parsed(parsePublicStreamEvent("chat-completions", { data: "[DONE]" }, context));
    events.push(...done.events);
    const trace = renderPublicStreamTrace("chat-completions", events);
    const usageIndex = trace.findIndex((event) => {
      return typeof event.data === "object"
        && event.data !== null
        && "usage" in event.data;
    });
    const terminalIndex = trace.findIndex((event) => {
      return typeof event.data === "object"
        && event.data !== null
        && "choices" in event.data
        && Array.isArray(event.data.choices)
        && event.data.choices[0]?.finish_reason === "stop";
    });
    expect(usageIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeLessThan(terminalIndex);
    expect(trace.filter((event) => event.data === "[DONE]")).toHaveLength(1);
    expect(trace.at(-1)?.data).toBe("[DONE]");
  });
});
