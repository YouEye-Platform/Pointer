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
  test("rejects fragmented output without a real terminal", async () => {
    const response = chunkedResponse([
      'data: {"type":"response.output_text.delta","delta":"hel',
      'lo"}\n\n',
    ]);
    await expect(consumeResponsesStream(response, "provider/model")).rejects.toMatchObject({ code: "pointer_stream_interrupted" });
  });

  test("processes a final completed event without a trailing newline", async () => {
    const completed = {
      id: "resp-upstream",
      object: "response",
      status: "completed",
      model: "provider/model",
      output: [{type:"message",id:"msg-upstream",role:"assistant",status:"completed",content:[{type:"output_text",text:"hello",annotations:[]}]}],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const response = chunkedResponse([
      `data: ${JSON.stringify({ type: "response.created", response:{id:completed.id,model:completed.model} })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index:0, item:{...completed.output[0],content:[]} })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index:0, item:completed.output[0] })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,

    ]);

    expect(await consumeResponsesStream(response, "fallback")).toMatchObject(completed);
  });
});
