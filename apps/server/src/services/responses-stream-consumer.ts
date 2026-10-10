import { nanoid } from "nanoid";
import { createGatewayProxyStreamSelector } from "../gateway/protocol/v1/runtime-proxy";
import type { JsonObject } from "../gateway/protocol/v1/schemas";
import type { PublicStreamEvent } from "../gateway/protocol/v1/stream";
import { SseLineDecoder } from "../gateway/sse-line-decoder";
import { SseEventDecoder } from "../gateway/sse-event-decoder";

export class ResponsesStreamError extends Error {
  constructor(readonly code: string) {
    super(code === "pointer_stream_interrupted"
      ? "Provider stream ended before completion."
      : "Provider stream could not complete successfully.");
    this.name = "ResponsesStreamError";
  }
}

/** Buffered clients share the same citation, identity and terminal checks as streaming clients. */
export async function consumeResponsesStream(
  response: Response,
  fallbackModel: string,
  requestId = `ptrreq_buffered_${nanoid()}`,
): Promise<JsonObject> {
  if (!response.body) throw new ResponsesStreamError("pointer_stream_interrupted");
  const selector = createGatewayProxyStreamSelector({
    sourceFormat: "responses", targetFormat: "responses", model: fallbackModel, requestId,
  });
  const reader = response.body.getReader();
  const lines = new SseLineDecoder();
  const frames = new SseEventDecoder();
  let terminal: JsonObject | undefined;
  let errorCode: string | undefined;
  const select = (event: PublicStreamEvent | undefined) => {
    if (!event) return;
    for (const line of selector.push(event).lines) {
      const data = line.split("\n").find(value => value.startsWith("data: "));
      if (!data) continue;
      const value = JSON.parse(data.slice(6));
      if (["response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(value.type)) terminal = value.response;
      if (value.type === "error") errorCode = value.code;
    }
  };
  try {
    while (!selector.ended() && !selector.failed()) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of lines.push(value)) {
        select(frames.push(line));
        if (selector.ended() || selector.failed()) break;
      }
    }
    if (!selector.ended() && !selector.failed()) {
      for (const line of lines.finish()) select(frames.push(line));
      select(frames.finish());
    }
    selector.finish();
    if (selector.failed() || selector.upstreamFailed() || !terminal) {
      throw new ResponsesStreamError(errorCode ?? (selector.failure()?.kind === "translation"
        ? "pointer_stream_translation_error" : "pointer_stream_interrupted"));
    }
    return terminal;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
