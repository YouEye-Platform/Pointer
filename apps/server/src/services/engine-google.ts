import { parseGoogleRequest, renderGoogleResponse } from "../gateway/protocol/v1/google";
import { parseResponsesResponse, renderResponsesRequest } from "../gateway/protocol/v1/responses";
import { renderMessagesRequest } from "../gateway/protocol/v1/messages";
import { createStreamAdapterContext, parsePublicStreamEvent, renderPublicStreamEvent } from "../gateway/protocol/v1/stream";
import type { IrStreamEvent, JsonObject } from "../gateway/protocol/v1/schemas";
import { SseEventDecoder } from "../gateway/sse-event-decoder";
import { SseLineDecoder } from "../gateway/sse-line-decoder";

export function googleEngineRequest(body: unknown, model: string, stream: boolean): JsonObject {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A JSON object is required");
  const parsed = parseGoogleRequest({ ...body, model, stream });
  if (!parsed.ok) throw new Error("Invalid Gemini request");
  const rendered = renderResponsesRequest(parsed.value);
  if (!rendered.ok) throw new Error("This Gemini request cannot be represented by the engine");
  return rendered.value;
}

export function googleEngineCountRequest(body: unknown, model: string): JsonObject {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A JSON object is required");
  const nested = (body as Record<string, unknown>).generateContentRequest;
  const source = nested ?? body;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid token count request");
  const parsed = parseGoogleRequest({ ...source, model, stream: false });
  if (!parsed.ok) throw new Error("Invalid Gemini token count request");
  const rendered = renderMessagesRequest(parsed.value);
  if (!rendered.ok) throw new Error("This Gemini request cannot be counted by the engine");
  return rendered.value;
}

export async function googleEngineResponse(response: Response, model: string, requestId: string): Promise<Response> {
  const headers = { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
  if (!response.ok) {
    await response.body?.cancel();
    return Response.json({ error: { code: response.status,
    status: response.status === 400 ? "INVALID_ARGUMENT" : response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
    message: "The selected model could not complete this request.",
    } }, { status: response.status, headers: { ...headers, "content-type": "application/json" } });
  }
  if (!headers["content-type"].includes("text/event-stream")) {
    const payload = await response.json() as Record<string, unknown>;
    // OpenCodex labels its ordinary final assistant message with final_answer.
    // Gemini's completed candidate already conveys that role. Preserve content
    // unchanged while removing only that redundant Responses-specific label.
    if (Array.isArray(payload.output)) payload.output = payload.output.map(item => {
      if (item?.type !== "message" || item.phase !== "final_answer") return item;
      const { phase: _phase, ...message } = item;
      return message;
    });
    // Account entitlement metadata does not describe generated content.
    delete payload.access_programs;
    const parsed = parseResponsesResponse(payload);
    if (!parsed.ok) throw new Error("Invalid engine response");
    const rendered = renderGoogleResponse(parsed.value, "best-effort", model);
    if (!rendered.ok) throw new Error(`Gemini response conversion failed: ${rendered.error.findings.map(item => item.detailCode).join(",")}`);
    return Response.json(rendered.value, { headers });
  }
  if (!response.body) throw new Error("Missing engine stream");
  const lines = new SseLineDecoder();
  const events = new SseEventDecoder();
  const encoder = new TextEncoder();
  let context = createStreamAdapterContext(model, requestId);
  const tools = new Map<number, { id: string; name: string; arguments: string; metadata?: JsonObject }>();
  let argumentBytes = 0;
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, data: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  const consume = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const source = events.push(line);
    if (!source) return;
    // OpenCodex ends its Responses SSE with this optional transport sentinel.
    // Completion still requires a preceding protocol terminal event.
    if (source.data === "[DONE]") return;
    // The pinned engine forwards Codex quota/header diagnostics alongside the
    // Responses protocol. They neither emit Gemini content nor mark completion.
    const data = source.data;
    if (data && typeof data === "object" && !Array.isArray(data) && "type" in data
      && (data.type === "codex.rate_limits" || data.type === "codex.response.metadata")) return;
    // Final-answer phase labels would otherwise be treated as native Responses
    // messages instead of portable text blocks by the shared stream parser.
    if (data && typeof data === "object" && "item" in data) {
      const item = data.item as Record<string, unknown> | null;
      if (item?.type === "message" && item.phase === "final_answer") {
        const { phase: _phase, ...message } = item;
        data.item = message;
      }
    }
    const parsed = parsePublicStreamEvent("responses", source, context);
    if ("ok" in parsed) throw new Error(`Invalid engine stream event (${source.event ?? (data && typeof data === "object" && "type" in data ? data.type : "unnamed")}): ${parsed.error.code} ${parsed.error.message}`);
    context = parsed.context;
    for (const value of parsed.events) {
      const event: IrStreamEvent = { ...value, model };
      if (event.type === "tool_call_start") {
        if (tools.size >= 256) throw new Error("Too many simultaneous tool calls");
        tools.set(event.index, { id: event.callId, name: event.name, arguments: "", metadata: event.providerMetadata });
      } else if (event.type === "tool_arguments_delta") {
        argumentBytes += event.delta.length;
        if (argumentBytes > 16 * 1024 * 1024) throw new Error("Tool arguments exceed the response limit");
        const tool = tools.get(event.index);
        if (!tool) throw new Error("Tool arguments arrived without a call");
        tool.arguments += event.delta;
      } else if (event.type === "content_end" && tools.has(event.index)) {
        const tool = tools.get(event.index)!;
        const args: unknown = JSON.parse(tool.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
        const google = tool.metadata?.google as JsonObject | undefined;
        emit(controller, { candidates: [{ index: 0, content: { role: "model", parts: [{
          functionCall: { id: tool.id, name: tool.name, args },
          ...(typeof google?.thoughtSignature === "string" ? { thoughtSignature: google.thoughtSignature } : {}),
        }] } }], responseId: event.responseId, modelVersion: model });
        argumentBytes -= tool.arguments.length;
        tools.delete(event.index);
      } else for (const rendered of renderPublicStreamEvent("google-generate-content", event)) emit(controller, rendered.data);
    }
  };
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { for (const line of lines.push(chunk)) consume(line, controller); },
    flush(controller) {
      for (const line of lines.finish()) consume(line, controller);
      consume("", controller);
      if (!context.ended || tools.size) emit(controller, { error: { code: 502, status: "UNAVAILABLE", message: "The model stream ended before completion." } });
    },
  }));
  return new Response(stream, { headers });
}
