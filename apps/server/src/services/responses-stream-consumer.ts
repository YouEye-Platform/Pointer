import { nanoid } from "nanoid";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../gateway/protocol/v1/schemas";

interface BufferedToolCall {
  id: string;
  type: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function outputIndex(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function hasTextContent(output: JsonValue | undefined): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (!isJsonObject(item) || !Array.isArray(item.content)) return false;
    return item.content.some(
      (content) => isJsonObject(content) && typeof content.text === "string" && content.text.length > 0,
    );
  });
}

function hasFunctionCalls(output: JsonValue | undefined): boolean {
  return Array.isArray(output) && output.some(
    (item) => isJsonObject(item) && item.type === "function_call" && typeof item.name === "string",
  );
}

export async function consumeResponsesStream(
  response: Response,
  fallbackModel: string,
  generateResponseId: () => string = () => `resp_${nanoid()}`,
): Promise<JsonObject> {
  if (!response.body) throw new Error("Responses stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: JsonObject | null = null;
  let fullText = "";
  const toolCalls = new Map<number, BufferedToolCall>();
  let currentFunctionCallIndex = -1;

  const consumeLine = (line: string): JsonObject | undefined => {
    if (line.startsWith("event: ") || !line.startsWith("data: ")) return undefined;
    try {
      const parsed: unknown = JSON.parse(line.slice(6));
      if (!isJsonObject(parsed)) return undefined;
      const data = parsed;
      const eventType = stringValue(data.type);
      const delta = stringValue(data.delta);
      if (eventType === "response.output_text.delta" && delta) {
        fullText += delta;
      }
      if (
        eventType === "response.output_item.added" &&
        isJsonObject(data.item) &&
        data.item.type === "function_call"
      ) {
        const index = outputIndex(data.output_index, toolCalls.size);
        toolCalls.set(index, {
          id: stringValue(data.item.id) || `fc_${index}`,
          type: "function_call",
          call_id: stringValue(data.item.call_id) || "",
          name: stringValue(data.item.name) || "",
          arguments: "",
          status: stringValue(data.item.status) || "in_progress",
        });
        currentFunctionCallIndex = index;
      }
      if (eventType === "response.function_call_arguments.delta" && delta) {
        const index = outputIndex(data.output_index, currentFunctionCallIndex);
        const toolCall = toolCalls.get(index);
        if (toolCall) toolCall.arguments += delta;
      }
      if (eventType === "response.function_call_arguments.done") {
        const index = outputIndex(data.output_index, currentFunctionCallIndex);
        const toolCall = toolCalls.get(index);
        if (toolCall) {
          toolCall.arguments = stringValue(data.arguments) || toolCall.arguments;
          toolCall.status = "completed";
        }
      }
      if (eventType === "response.completed" && isJsonObject(data.response)) {
        return data.response;
      }
    } catch {
      // Ignore malformed upstream SSE records without exposing their contents.
    }
    return undefined;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      finalResponse = consumeLine(line) ?? finalResponse;
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    finalResponse = consumeLine(line) ?? finalResponse;
  }

  if (finalResponse) {
    if (!hasTextContent(finalResponse.output) && !hasFunctionCalls(finalResponse.output)) {
      const output = assembledOutput(fullText, toolCalls);
      if (output.length > 0) finalResponse.output = output;
    }
    return finalResponse;
  }

  const output = assembledOutput(fullText, toolCalls);
  return {
    id: generateResponseId(),
    object: "response",
    status: "completed",
    model: fallbackModel,
    output:
      output.length > 0
        ? output
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "" }],
            },
          ],
  };
}

function assembledOutput(
  fullText: string,
  toolCalls: ReadonlyMap<number, BufferedToolCall>,
): JsonObject[] {
  const output: JsonObject[] = [];
  if (fullText) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: fullText }],
    });
  }
  for (const toolCall of toolCalls.values()) {
    output.push({
      type: "function_call",
      id: toolCall.id,
      call_id: toolCall.call_id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      status: toolCall.status,
    });
  }
  return output;
}
