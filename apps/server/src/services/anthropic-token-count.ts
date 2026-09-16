import { parsePublicRequest } from "../gateway/protocol/v1";
import type {
  IrContentBlock,
  IrRequest,
  JsonObject,
  JsonValue,
} from "../gateway/protocol/v1/schemas";

const encoder = new TextEncoder();

function textTokens(text: string): number {
  let tokens = 0;
  for (const segment of text.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? []) {
    const bytes = encoder.encode(segment).byteLength;
    const asciiWord = /^[A-Za-z0-9_]+$/.test(segment);
    tokens += Math.max(1, Math.ceil(bytes / (asciiWord ? 4 : 3)));
  }
  return tokens;
}

function jsonTokens(value: JsonValue): number {
  return textTokens(JSON.stringify(value));
}

function imageTokens(block: Extract<IrContentBlock, { type: "image" }>): number {
  if (block.source.type === "url") return 85 + textTokens(block.source.url);
  if (block.source.type === "file") return 85 + textTokens(block.source.fileId);

  const padding = block.source.data.endsWith("==") ? 2 : block.source.data.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor(block.source.data.length * 3 / 4) - padding);
  // A provider-neutral estimate cannot infer image dimensions from every supported
  // media type. This intentionally grows conservatively with the decoded payload.
  return 85 + Math.ceil(decodedBytes / 750);
}

function blockTokens(block: IrContentBlock): number {
  if (block.type === "text") return 1 + textTokens(block.text);
  if (block.type === "image") return imageTokens(block);
  if (block.type === "audio") return 16 + Math.ceil(block.data.length / 1000);
  if (block.type === "file") {
    return 8
      + (block.filename ? textTokens(block.filename) : 0)
      + (block.data ? Math.ceil(block.data.length / 12) : 0);
  }
  if (block.type === "reasoning") return 2 + textTokens(block.text);
  if (block.type === "refusal") return 2 + textTokens(block.text);
  if (block.type === "tool_call") {
    return 8 + textTokens(block.name) + jsonTokens(block.arguments);
  }
  if (block.type === "tool_result") {
    return 6 + jsonTokens(block.output) + (block.isError ? 1 : 0);
  }
  return 4 + jsonTokens(block.extension.value);
}

/**
 * Produces a deterministic, provider-neutral input-token estimate.
 *
 * Pointer cannot use one exact tokenizer for every routed model. The estimator
 * counts the semantic prompt, tool schemas, tool calls/results, and bounded
 * multimodal overhead while excluding transport-only controls and opaque
 * provider signatures. It is deliberately conservative for code and JSON.
 */
export function estimateAnthropicInputTokens(request: IrRequest): number {
  let total = 4;
  total += request.instructions.reduce((sum, block) => sum + blockTokens(block), 0);

  for (const turn of request.turns) {
    total += 4 + textTokens(turn.role) + (turn.name ? textTokens(turn.name) : 0);
    total += turn.blocks.reduce((sum, block) => sum + blockTokens(block), 0);
  }

  for (const tool of request.tools) {
    total += 12 + textTokens(tool.name);
    if (tool.type === "function") {
      total += tool.description ? textTokens(tool.description) : 0;
      total += jsonTokens(tool.parameters);
    } else {
      total += jsonTokens(tool.configuration);
    }
  }

  for (const extension of request.extensions) {
    if (extension.key === "context_management" || extension.key === "mcp_servers") {
      total += 4 + jsonTokens(extension.value);
    }
  }

  return Math.max(1, Math.ceil(total));
}

export type AnthropicTokenCountResult =
  | { ok: true; response: { input_tokens: number } }
  | { ok: false };

export function countAnthropicRequestTokens(body: JsonObject): AnthropicTokenCountResult {
  const parsed = parsePublicRequest("messages", {
    ...body,
    max_tokens: 0,
    stream: false,
  });
  if (!parsed.ok) return { ok: false };
  return {
    ok: true,
    response: { input_tokens: estimateAnthropicInputTokens(parsed.value) },
  };
}
