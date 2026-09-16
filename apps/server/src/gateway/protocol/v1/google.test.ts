import { describe, expect, test } from "bun:test";
import {
  parseGoogleRequest,
  parseGoogleResponse,
  renderGoogleRequest,
  renderGoogleResponse,
  stripGoogleInternalFields,
} from "./google";
import { renderChatRequest } from "./chat";
import { renderResponsesRequest } from "./responses";

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("Google GenerateContent adapter", () => {
  test("round-trips the bounded native request while rewriting only routing fields", () => {
    const body = {
      model: "Pointer Display Model",
      stream: true,
      systemInstruction: { parts: [{ text: "Use tools safely." }] },
      contents: [
        { role: "user", parts: [{ text: "Look up alpha" }] },
        {
          role: "model",
          parts: [{
            functionCall: { id: "call_alpha", name: "lookup", args: { key: "alpha" } },
            thoughtSignature: "opaque-signature",
          }],
        },
        {
          role: "user",
          parts: [{
            functionResponse: {
              id: "call_alpha",
              name: "lookup",
              response: { value: 7 },
            },
          }],
        },
      ],
      tools: [{
        functionDeclarations: [{
          name: "lookup",
          description: "Find a value",
          parametersJsonSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        }],
      }],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
      },
      safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" }],
      cachedContent: "cachedContents/native-only",
      labels: { suite: "fixture" },
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        topK: 32,
        candidateCount: 1,
        maxOutputTokens: 512,
        stopSequences: ["STOP"],
        responseLogprobs: true,
        logprobs: 4,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 123,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
        thinkingConfig: { includeThoughts: true, thinkingBudget: 256 },
      },
    };

    const parsed = valueOf(parseGoogleRequest(body));
    const rendered = valueOf(renderGoogleRequest(parsed, "best-effort", "provider/raw-model"));
    expect(stripGoogleInternalFields(rendered)).toEqual(stripGoogleInternalFields(body));
    expect(rendered.model).toBe("provider/raw-model");
    expect(rendered.stream).toBe(true);
  });

  test("maps structured output and sampling controls to Chat and Responses", () => {
    const parsed = valueOf(parseGoogleRequest({
      model: "model",
      contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
      generationConfig: {
        topK: 32,
        candidateCount: 1,
        responseLogprobs: true,
        logprobs: 3,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 9,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    }));
    const chat = valueOf(renderChatRequest(parsed, "best-effort", "chat-model"));
    expect(chat).toMatchObject({
      model: "chat-model",
      n: 1,
      top_k: 32,
      logprobs: true,
      top_logprobs: 3,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 9,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pointer_response",
          schema: { type: "object", required: ["ok"] },
        },
      },
    });
    const responses = valueOf(renderResponsesRequest(parsed, "best-effort", "responses-model"));
    expect(responses).toMatchObject({
      model: "responses-model",
      top_logprobs: 3,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 9,
      text: {
        format: {
          type: "json_schema",
          name: "pointer_response",
          schema: { type: "object", required: ["ok"] },
        },
      },
    });
  });

  test("represents an explicitly disabled Gemini CLI thinking profile without requesting reasoning", () => {
    const parsed = valueOf(parseGoogleRequest({
      model: "Pointer non-reasoning model",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: {
        thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
      },
    }));

    expect(parsed.reasoning).toEqual({ enabled: false, budgetTokens: 0 });
  });

  test("does not mistake includeThoughts false alone for a disabled-reasoning request", () => {
    const parsed = valueOf(parseGoogleRequest({
      model: "Pointer model",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { thinkingConfig: { includeThoughts: false } },
    }));

    expect(parsed.reasoning).toBeUndefined();
  });

  test("correlates tool result names when translating another format to Google", () => {
    const parsed = valueOf(parseGoogleRequest({
      model: "model",
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { id: "call_1", name: "lookup", args: { key: "a" } } }],
        },
        {
          role: "user",
          parts: [{
            functionResponse: {
              id: "call_1",
              name: "lookup",
              response: { value: 1 },
            },
          }],
        },
      ],
    }));
    parsed.extensions = [];
    const rendered = valueOf(renderGoogleRequest(parsed));
    expect(rendered.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { id: "call_1", name: "lookup", args: { key: "a" } } }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: "call_1",
            name: "lookup",
            response: { value: 1 },
          },
        }],
      },
    ]);
  });

  test("preserves native response metadata and reports multiple-candidate portability", () => {
    const input = {
      model: "provider/raw-model",
      responseId: "response-1",
      modelVersion: "provider/raw-model-2026-08",
      promptFeedback: { safetyRatings: [{ category: "fixture", probability: "NEGLIGIBLE" }] },
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [{ text: "first" }] },
          finishReason: "STOP",
          groundingMetadata: { searchEntryPoint: { renderedContent: "fixture" } },
        },
        {
          index: 1,
          content: { role: "model", parts: [{ text: "second" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    };
    const parsedResult = parseGoogleResponse(input);
    const parsed = valueOf(parsedResult);
    expect(parsedResult.ok && parsedResult.findings.map((item) => item.detailCode)).toContain(
      "pointer_multiple_choices_lossy",
    );
    const rendered = valueOf(renderGoogleResponse(parsed, "best-effort", "Pointer Display Model"));
    expect(JSON.parse(JSON.stringify(rendered.candidates))).toEqual(
      JSON.parse(JSON.stringify(input.candidates)),
    );
    expect(rendered.promptFeedback).toEqual(input.promptFeedback);
    expect(rendered.modelVersion).toBe("Pointer Display Model");
  });

  test("normalizes prompt-level safety blocks as content filtering", () => {
    const parsed = valueOf(parseGoogleResponse({
      model: "model",
      promptFeedback: { blockReason: "SAFETY" },
      usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 },
    }));
    expect(parsed.status).toBe("incomplete");
    expect(parsed.finishReason).toBe("content_filter");
    expect(parsed.rawFinishReason).toBe("SAFETY");
  });
});
