import { describe, expect, test } from "bun:test";
import { consumeResponsesStream } from "./responses-stream-consumer";

function chunkedResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("Responses stream consumer", () => {
  test("assembles fragmented text and tool calls without fabricating usage", async () => {
    const response = chunkedResponse([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hel",
      "lo\"}\n",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"item-1\",\"call_id\":\"call-1\",\"name\":\"lookup\"}}\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"q\\\":1}\"}\n",
      "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":1}\n",
    ]);

    const assembled = await consumeResponsesStream(response, "provider/model", () => "resp-test");

    expect(assembled.id).toBe("resp-test");
    expect(assembled.usage).toBeUndefined();
    expect(assembled.output).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
      {
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
        name: "lookup",
        arguments: "{\"q\":1}",
        status: "completed",
      },
    ]);
  });

  test("processes a final completed event without a trailing newline", async () => {
    const completed = {
      id: "resp-upstream",
      object: "response",
      status: "completed",
      model: "provider/model",
      output: [],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const response = chunkedResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
    ]);

    expect(await consumeResponsesStream(response, "fallback")).toEqual(completed);
  });
});
