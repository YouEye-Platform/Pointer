export const GATEWAY_FORMATS = [
  "chat-completions",
  "messages",
  "responses",
  "google-generate-content",
] as const;

export type GatewayFormat = (typeof GATEWAY_FORMATS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ErrorFixture {
  status: number;
  headers: JsonObject;
  body: JsonObject;
}

export interface FormatFixture {
  request: JsonObject;
  response: JsonObject;
  error: ErrorFixture;
  stream: string[];
}

export interface GatewayFixtureExpectations {
  canonicalModel: string;
  providerRawModel: string;
  text: string;
  orderedImageUrls: [string, string];
  toolCall: {
    id: string;
    name: string;
    arguments: JsonObject;
  };
  toolResult: {
    callId: string;
    output: JsonObject;
  };
  reasoning: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number;
  };
  finishReason: "tool_calls";
  error: {
    status: number;
    code: string;
    message: string;
  };
}

export type GatewayFixtureLoss =
  | "request.ordered_images"
  | "request.image_block_shape"
  | "request.anthropic_version"
  | "request.context_management"
  | "request.max_output_tokens"
  | "request.non_streaming_preference"
  | "request.parallel_tool_calls"
  | "request.tool_choice_controls"
  | "request.tool_result_shape"
  | "request.tool_schema_strict"
  | "request.top_p"
  | "response.created_timestamp"
  | "response.generated_id"
  | "response.parallel_tool_calls"
  | "response.reasoning"
  | "response.usage.reasoning_tokens"
  | "stream.reasoning_channel"
  | "stream.created_timestamp"
  | "stream.generated_id"
  | "stream.sparse_output_index"
  | "stream.server_timing"
  | "stream.tool_call_completion"
  | "stream.tool_input_shape"
  | "stream.usage.input_tokens"
  | "stream.usage.reasoning_tokens"
  | "error.provider_code"
  | "error.retry_after_header";

export interface GatewayFixture {
  id: string;
  incomingFormat: GatewayFormat;
  providerFormat: GatewayFormat;
  providerTransport: "json" | "sse";
  incomingRequest: JsonObject;
  providerRequest: JsonObject;
  providerResponse: JsonObject;
  clientResponse: JsonObject;
  providerError: ErrorFixture;
  clientError: ErrorFixture;
  providerStream: string[];
  clientStream: string[];
  expectations: GatewayFixtureExpectations;
  losses: GatewayFixtureLoss[];
}

export const CANONICAL_MODEL = "fixture/canonical-model";
export const PROVIDER_RAW_MODEL = "provider-native/fixture-model";
const SYSTEM_TEXT = "Follow the synthetic fixture instructions.";
const USER_TEXT = "Describe the two sample images, then call lookup_fixture.";
const FINAL_TEXT = "The red sample precedes the blue sample.";
const REASONING_TEXT = "Compared the two synthetic image labels in order.";
const RED_IMAGE = "https://fixtures.invalid/image-red.png";
const BLUE_IMAGE = "https://fixtures.invalid/image-blue.png";
const TOOL_NAME = "lookup_fixture";
const PRIOR_TOOL_CALL_ID = "call_fixture_previous";
const TOOL_CALL_ID = "call_fixture_001";
const TOOL_ARGUMENTS = { query: "synthetic" };
const TOOL_RESULT = { status: "ok", value: "synthetic-result" };
const ERROR_CODE = "fixture_rate_limited";
const ERROR_MESSAGE = "Synthetic upstream rate limit.";
const CREATED_AT = 1_700_000_000;

const CHAT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "Returns a deterministic synthetic value.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const MESSAGES_TOOL = {
  name: TOOL_NAME,
  description: "Returns a deterministic synthetic value.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

const RESPONSES_TOOL = {
  type: "function",
  name: TOOL_NAME,
  description: "Returns a deterministic synthetic value.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  strict: true,
};

function sse(data: JsonValue, event?: string): string {
  const prefix = event ? `event: ${event}\n` : "";
  return `${prefix}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

const CHAT_COMPLETIONS: FormatFixture = {
  request: {
    model: CANONICAL_MODEL,
    messages: [
      { role: "system", content: SYSTEM_TEXT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_TEXT },
          { type: "image_url", image_url: { url: RED_IMAGE } },
          { type: "image_url", image_url: { url: BLUE_IMAGE } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: PRIOR_TOOL_CALL_ID,
            type: "function",
            function: { name: TOOL_NAME, arguments: JSON.stringify({ query: "previous" }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: PRIOR_TOOL_CALL_ID,
        content: JSON.stringify(TOOL_RESULT),
      },
    ],
    tools: [CHAT_TOOL],
    tool_choice: "auto",
    max_tokens: 128,
    top_p: 0.9,
    parallel_tool_calls: false,
    stream: false,
  },
  response: {
    id: "chatcmpl_fixture_001",
    object: "chat.completion",
    created: CREATED_AT,
    model: PROVIDER_RAW_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: FINAL_TEXT,
          reasoning_content: REASONING_TEXT,
          tool_calls: [
            {
              id: TOOL_CALL_ID,
              type: "function",
              function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGUMENTS) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 18,
      total_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 6 },
    },
  },
  error: {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" },
    body: {
      error: {
        type: "rate_limit_error",
        code: ERROR_CODE,
        message: ERROR_MESSAGE,
        param: null,
      },
    },
  },
  stream: [
    sse({
      id: "chatcmpl_fixture_001",
      object: "chat.completion.chunk",
      created: CREATED_AT,
      model: PROVIDER_RAW_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: REASONING_TEXT }, finish_reason: null }],
    }),
    sse({
      id: "chatcmpl_fixture_001",
      object: "chat.completion.chunk",
      created: CREATED_AT,
      model: PROVIDER_RAW_MODEL,
      choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }],
    }),
    sse({
      id: "chatcmpl_fixture_001",
      object: "chat.completion.chunk",
      created: CREATED_AT,
      model: PROVIDER_RAW_MODEL,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: "function",
                function: { name: TOOL_NAME, arguments: JSON.stringify(TOOL_ARGUMENTS) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sse({
      id: "chatcmpl_fixture_001",
      object: "chat.completion.chunk",
      created: CREATED_AT,
      model: PROVIDER_RAW_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 18,
        total_tokens: 60,
        completion_tokens_details: { reasoning_tokens: 6 },
      },
      time_info: {
        queue_time: 0.012,
        prompt_time: 0.034,
        completion_time: 0.056,
      },
    }),
    sse("[DONE]"),
  ],
};

const MESSAGES: FormatFixture = {
  request: {
    model: CANONICAL_MODEL,
    "anthropic-version": "2023-06-01",
    context_management: { edits: [{ type: "clear_tool_uses_fixture" }] },
    system: SYSTEM_TEXT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: USER_TEXT },
          { type: "image", source: { type: "url", url: RED_IMAGE } },
          { type: "image", source: { type: "url", url: BLUE_IMAGE } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: PRIOR_TOOL_CALL_ID, name: TOOL_NAME, input: { query: "previous" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: PRIOR_TOOL_CALL_ID,
            content: [{ type: "text", text: JSON.stringify(TOOL_RESULT) }],
          },
        ],
      },
    ],
    tools: [MESSAGES_TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    max_tokens: 128,
    top_p: 0.9,
    stream: false,
  },
  response: {
    id: "msg_fixture_001",
    type: "message",
    role: "assistant",
    model: PROVIDER_RAW_MODEL,
    content: [
      { type: "thinking", thinking: REASONING_TEXT, signature: "fixture-signature" },
      { type: "text", text: FINAL_TEXT },
      { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_NAME, input: TOOL_ARGUMENTS },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 42,
      output_tokens: 18,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 6,
    },
  },
  error: {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" },
    body: {
      type: "error",
      error: { type: ERROR_CODE, message: ERROR_MESSAGE },
    },
  },
  stream: [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_fixture_001",
          type: "message",
          role: "assistant",
          model: PROVIDER_RAW_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      },
      "message_start"
    ),
    sse(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      "content_block_start"
    ),
    sse(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: REASONING_TEXT } },
      "content_block_delta"
    ),
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
    sse(
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      "content_block_start"
    ),
    sse(
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: FINAL_TEXT } },
      "content_block_delta"
    ),
    sse({ type: "content_block_stop", index: 1 }, "content_block_stop"),
    sse(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_NAME, input: {} },
      },
      "content_block_start"
    ),
    sse(
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL_ARGUMENTS) },
      },
      "content_block_delta"
    ),
    sse({ type: "content_block_stop", index: 2 }, "content_block_stop"),
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 18, reasoning_tokens: 6 },
      },
      "message_delta"
    ),
    sse({ type: "message_stop" }, "message_stop"),
  ],
};

const RESPONSES: FormatFixture = {
  request: {
    model: CANONICAL_MODEL,
    instructions: SYSTEM_TEXT,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: USER_TEXT },
          { type: "input_image", image_url: RED_IMAGE },
          { type: "input_image", image_url: BLUE_IMAGE },
        ],
      },
      {
        type: "function_call",
        call_id: PRIOR_TOOL_CALL_ID,
        name: TOOL_NAME,
        arguments: JSON.stringify({ query: "previous" }),
      },
      {
        type: "function_call_output",
        call_id: PRIOR_TOOL_CALL_ID,
        output: JSON.stringify(TOOL_RESULT),
      },
    ],
    tools: [RESPONSES_TOOL],
    tool_choice: "auto",
    max_output_tokens: 128,
    top_p: 0.9,
    parallel_tool_calls: false,
    stream: false,
  },
  response: {
    id: "resp_fixture_001",
    object: "response",
    created_at: CREATED_AT,
    status: "completed",
    model: PROVIDER_RAW_MODEL,
    output: [
      {
        id: "rs_fixture_001",
        type: "reasoning",
        summary: [{ type: "summary_text", text: REASONING_TEXT }],
      },
      {
        id: "msg_fixture_001",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: FINAL_TEXT, annotations: [] }],
      },
      {
        id: "fc_fixture_001",
        type: "function_call",
        status: "completed",
        call_id: TOOL_CALL_ID,
        name: TOOL_NAME,
        arguments: JSON.stringify(TOOL_ARGUMENTS),
      },
    ],
    parallel_tool_calls: false,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 42,
      output_tokens: 18,
      total_tokens: 60,
      output_tokens_details: { reasoning_tokens: 6 },
    },
  },
  error: {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" },
    body: {
      error: {
        type: "rate_limit_error",
        code: ERROR_CODE,
        message: ERROR_MESSAGE,
        param: null,
      },
    },
  },
  stream: [
    sse(
      {
        type: "response.created",
        response: {
          id: "resp_fixture_001",
          object: "response",
          created_at: CREATED_AT,
          status: "in_progress",
          model: PROVIDER_RAW_MODEL,
          output: [],
        },
      },
      "response.created"
    ),
    sse(
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_fixture_001",
        output_index: 0,
        summary_index: 0,
        delta: REASONING_TEXT,
      },
      "response.reasoning_summary_text.delta"
    ),
    sse(
      {
        type: "response.output_text.delta",
        item_id: "msg_fixture_001",
        output_index: 1,
        content_index: 0,
        delta: FINAL_TEXT,
      },
      "response.output_text.delta"
    ),
    sse(
      {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          id: "fc_fixture_001",
          type: "function_call",
          status: "in_progress",
          call_id: TOOL_CALL_ID,
          name: TOOL_NAME,
          arguments: "",
        },
      },
      "response.output_item.added"
    ),
    sse(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_fixture_001",
        output_index: 2,
        call_id: TOOL_CALL_ID,
        delta: JSON.stringify(TOOL_ARGUMENTS),
      },
      "response.function_call_arguments.delta"
    ),
    sse(
      {
        type: "response.completed",
        response: {
          id: "resp_fixture_001",
          object: "response",
          created_at: CREATED_AT,
          status: "completed",
          model: PROVIDER_RAW_MODEL,
          output: [],
          usage: {
            input_tokens: 42,
            output_tokens: 18,
            total_tokens: 60,
            output_tokens_details: { reasoning_tokens: 6 },
          },
        },
      },
      "response.completed"
    ),
  ],
};

const GOOGLE_GENERATE_CONTENT: FormatFixture = {
  request: {
    model: CANONICAL_MODEL,
    systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: USER_TEXT },
          { fileData: { mimeType: "image/png", fileUri: RED_IMAGE } },
          { fileData: { mimeType: "image/png", fileUri: BLUE_IMAGE } },
        ],
      },
      {
        role: "model",
        parts: [{
          functionCall: {
            id: PRIOR_TOOL_CALL_ID,
            name: TOOL_NAME,
            args: { query: "previous" },
          },
          thoughtSignature: "fixture-prior-signature",
        }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: PRIOR_TOOL_CALL_ID,
            name: TOOL_NAME,
            response: TOOL_RESULT,
          },
        }],
      },
    ],
    tools: [{
      functionDeclarations: [{
        name: TOOL_NAME,
        description: "Returns a deterministic synthetic value.",
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
    }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { maxOutputTokens: 128, topP: 0.9 },
    stream: false,
  },
  response: {
    model: PROVIDER_RAW_MODEL,
    responseId: "google_fixture_001",
    modelVersion: PROVIDER_RAW_MODEL,
    candidates: [{
      index: 0,
      content: {
        role: "model",
        parts: [
          { text: REASONING_TEXT, thought: true, thoughtSignature: "fixture-signature" },
          { text: FINAL_TEXT },
          {
            functionCall: { id: TOOL_CALL_ID, name: TOOL_NAME, args: TOOL_ARGUMENTS },
            thoughtSignature: "fixture-tool-signature",
          },
        ],
      },
      finishReason: "STOP",
    }],
    usageMetadata: {
      promptTokenCount: 42,
      candidatesTokenCount: 18,
      totalTokenCount: 60,
      thoughtsTokenCount: 6,
    },
  },
  error: {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" },
    body: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: ERROR_MESSAGE,
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: ERROR_CODE,
        }],
      },
    },
  },
  stream: [
    sse({
      responseId: "google_fixture_001",
      modelVersion: PROVIDER_RAW_MODEL,
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{
            text: REASONING_TEXT,
            thought: true,
            thoughtSignature: "fixture-signature",
          }],
        },
      }],
    }),
    sse({
      responseId: "google_fixture_001",
      modelVersion: PROVIDER_RAW_MODEL,
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: FINAL_TEXT }] },
      }],
    }),
    sse({
      responseId: "google_fixture_001",
      modelVersion: PROVIDER_RAW_MODEL,
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{
            functionCall: { id: TOOL_CALL_ID, name: TOOL_NAME, args: TOOL_ARGUMENTS },
            thoughtSignature: "fixture-tool-signature",
          }],
        },
      }],
    }),
    sse({
      responseId: "google_fixture_001",
      modelVersion: PROVIDER_RAW_MODEL,
      candidates: [{ index: 0, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 42,
        candidatesTokenCount: 18,
        totalTokenCount: 60,
        thoughtsTokenCount: 6,
      },
    }),
  ],
};

export const FORMAT_FIXTURES: Record<GatewayFormat, FormatFixture> = {
  "chat-completions": CHAT_COMPLETIONS,
  messages: MESSAGES,
  responses: RESPONSES,
  "google-generate-content": GOOGLE_GENERATE_CONTENT,
};

export const GATEWAY_FIXTURE_EXPECTATIONS: GatewayFixtureExpectations = {
  canonicalModel: CANONICAL_MODEL,
  providerRawModel: PROVIDER_RAW_MODEL,
  text: FINAL_TEXT,
  orderedImageUrls: [RED_IMAGE, BLUE_IMAGE],
  toolCall: {
    id: TOOL_CALL_ID,
    name: TOOL_NAME,
    arguments: TOOL_ARGUMENTS,
  },
  toolResult: {
    callId: PRIOR_TOOL_CALL_ID,
    output: TOOL_RESULT,
  },
  reasoning: REASONING_TEXT,
  usage: {
    inputTokens: 42,
    outputTokens: 18,
    totalTokens: 60,
    reasoningTokens: 6,
  },
  finishReason: "tool_calls",
  error: {
    status: 429,
    code: ERROR_CODE,
    message: ERROR_MESSAGE,
  },
};
