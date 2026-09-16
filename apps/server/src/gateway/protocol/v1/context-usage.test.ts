import { expect, test } from "bun:test";
import { createGatewayProxyStreamSelector } from "./runtime-proxy";
import { usageFromMessages, usageToMessages } from "./normalize";
import { parsePublicError } from "./errors";

test("incremental Responses emits late input/cache totals once and without double counting", () => {
  const selector = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "messages", model: "test", requestId: "ptrreq_usage_test" });
  const emitted: any[] = [];
  const push = (data: any) => {
    for (const line of selector.push({ event: data.type, data }).lines) {
      emitted.push(JSON.parse(line.match(/^data: (.*)$/m)![1]));
    }
  };
  const response = { id: "resp_test", model: "test", status: "in_progress" };
  push({ type: "response.created", response });
  push({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" });
  expect(emitted[0].message.usage.input_tokens).toBe(0);
  push({ type: "response.completed", response: { ...response, status: "completed", output: [], usage: {
    input_tokens: 921367, output_tokens: 621, total_tokens: 921988,
    input_tokens_details: { cached_tokens: 919680 },
  } } });
  const deltas = emitted.filter(event => event.type === "message_delta");
  expect(deltas).toHaveLength(1);
  expect(deltas[0].usage).toMatchObject({ input_tokens: 1687, cache_read_input_tokens: 919680, output_tokens: 621 });
  expect(emitted.filter(event => event.type === "message_start")).toHaveLength(1);
  expect(emitted.filter(event => event.type === "message_stop")).toHaveLength(1);
  expect(selector.usage()?.inputTokens).toBe(921367);
  expect(selector.failed()).toBe(false);
});

test("Messages disjoint cache buckets round trip through inclusive IR", () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 };
  const ir = usageFromMessages(usage)!;
  expect(ir.inputTokens).toBe(800);
  expect(ir.totalTokens).toBe(820);
  expect(usageToMessages(ir)).toEqual(usage);
});

test("partial Messages deltas preserve input/cache totals without adding them twice", () => {
  const s = createGatewayProxyStreamSelector({ sourceFormat: "messages", targetFormat: "responses", model: "test", requestId: "ptrreq_partial_usage" });
  s.push({ data: { type: "message_start", message: { id: "msg_test", model: "test", usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 0 } } } });
  s.push({ data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } } });
  for (const usage of [{ output_tokens: 1 }, { output_tokens: 2, cache_read_input_tokens: 600 }, { output_tokens: 3 }]) {
    s.push({ data: { type: "message_delta", delta: { stop_reason: null }, usage } });
  }
  expect(s.usage()).toMatchObject({ inputTokens: 700, cachedInputTokens: 600, outputTokens: 3 });
});

test("context rejection survives Responses terminal as a safe nonretryable category", () => {
  const s = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "messages", model: "test", requestId: "ptrreq_context_failure" });
  s.push({ data: { type: "response.created", response: { id: "resp_test", model: "test", status: "in_progress" } } });
  const lines = s.push({ data: { type: "response.failed", response: { id: "resp_test", model: "test", status: "failed", output: [], error: { code: "context_length_exceeded", message: "PRIVATE_PROVIDER_MESSAGE" } } } }).lines.join("");
  expect(lines).toContain("pointer_context_length_exceeded");
  expect(lines).toContain("invalid_request_error");
  expect(lines).not.toContain("PRIVATE_PROVIDER_MESSAGE");
  expect(s.upstreamError()?.status).toBe(400);
  expect(s.upstreamError()?.diagnostics?.retryable).toBe(false);
});

test("unknown error text is not classified by substring or exposed", () => {
  const parsed = parsePublicError("responses", { status: 502, body: { error: { code: "arbitrary", message: "context_length_exceeded PRIVATE" } } }, { requestId: "ptrreq_unknown_failure" });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.code).toBe("pointer_upstream_unavailable");
  expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
});

test("empty successful response has its own category", () => {
  const s = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat: "messages", model: "test", requestId: "ptrreq_empty_failure" });
  s.push({ data: { type: "response.created", response: { id: "resp_test", model: "test", status: "in_progress" } } });
  s.push({ data: { type: "response.completed", response: { id: "resp_test", model: "test", status: "completed", output: [] } } });
  expect(s.upstreamError()?.code).toBe("pointer_empty_response");
});
