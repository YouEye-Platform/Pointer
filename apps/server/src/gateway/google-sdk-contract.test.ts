import { describe, expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";

interface ObservedRequest {
  method: string;
  path: string;
  query: string;
  apiKey: string | null;
  body: unknown;
}

describe("official Google Gen AI SDK wire contract", () => {
  test("uses Pointer's v1beta routes, Google key header, and SSE framing", async () => {
    const calls: ObservedRequest[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : null;
        calls.push({
          method: request.method,
          path: url.pathname,
          query: url.search,
          apiKey: request.headers.get("x-goog-api-key"),
          body,
        });
        if (url.pathname.endsWith(":streamGenerateContent")) {
          return new Response([
            `data: ${JSON.stringify({
              responseId: "sdk-stream",
              modelVersion: "Pointer Display Model",
              candidates: [{
                index: 0,
                content: { role: "model", parts: [{ text: "streamed" }] },
              }],
            })}\n\n`,
            `data: ${JSON.stringify({
              responseId: "sdk-stream",
              modelVersion: "Pointer Display Model",
              candidates: [{ index: 0, finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 2,
                candidatesTokenCount: 1,
                totalTokenCount: 3,
              },
            })}\n\n`,
          ].join(""), { headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname.endsWith(":generateContent")) {
          return Response.json({
            responseId: "sdk-generate",
            modelVersion: "Pointer Display Model",
            candidates: [{
              index: 0,
              content: { role: "model", parts: [{ text: "generated" }] },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 1,
              totalTokenCount: 3,
            },
          });
        }
        if (url.pathname.endsWith(":countTokens")) {
          return Response.json({ totalTokens: 2 });
        }
        if (url.pathname.endsWith(":batchEmbedContents")) {
          return Response.json({
            embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
          });
        }
        if (url.pathname === "/v1beta/models") {
          return Response.json({
            models: [{
              name: "models/Pointer Display Model",
              displayName: "Pointer Display Model",
              supportedGenerationMethods: ["generateContent", "countTokens"],
            }],
          });
        }
        if (url.pathname.startsWith("/v1beta/models/")) {
          return Response.json({
            name: "models/Pointer Display Model",
            displayName: "Pointer Display Model",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          });
        }
        return Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      },
    });

    try {
      const ai = new GoogleGenAI({
        apiKey: "ptr_sdk_fixture",
        apiVersion: "v1beta",
        httpOptions: { baseUrl: `http://127.0.0.1:${server.port}` },
      });
      const generated = await ai.models.generateContent({
        model: "Pointer Display Model",
        contents: "hello",
        config: {
          systemInstruction: "Return JSON",
          tools: [{
            functionDeclarations: [{
              name: "lookup",
              description: "Lookup a fixture",
              parametersJsonSchema: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
              },
            }],
          }],
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
          thinkingConfig: { includeThoughts: true, thinkingBudget: 64 },
        },
      });
      expect(generated.text).toBe("generated");

      const streaming = await ai.models.generateContentStream({
        model: "Pointer Display Model",
        contents: "hello stream",
      });
      let streamed = "";
      for await (const chunk of streaming) streamed += chunk.text ?? "";
      expect(streamed).toBe("streamed");

      const count = await ai.models.countTokens({
        model: "Pointer Display Model",
        contents: "hello",
      });
      expect(count.totalTokens).toBe(2);

      const embeddings = await ai.models.embedContent({
        model: "Pointer Embedding Model",
        contents: ["one", "two"],
      });
      expect(embeddings.embeddings?.map((embedding) => embedding.values)).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);

      const models = await ai.models.list({ config: { pageSize: 10 } });
      expect(models.page[0]?.name).toBe("models/Pointer Display Model");
      const model = await ai.models.get({ model: "Pointer Display Model" });
      expect(model.displayName).toBe("Pointer Display Model");

      expect(calls).toHaveLength(6);
      expect(calls.every((call) => call.apiKey === "ptr_sdk_fixture")).toBe(true);
      expect(calls.map((call) => `${call.method} ${call.path}${call.query}`)).toEqual([
        "POST /v1beta/models/Pointer%20Display%20Model:generateContent",
        "POST /v1beta/models/Pointer%20Display%20Model:streamGenerateContent?alt=sse",
        "POST /v1beta/models/Pointer%20Display%20Model:countTokens",
        "POST /v1beta/models/Pointer%20Embedding%20Model:batchEmbedContents",
        "GET /v1beta/models?pageSize=10",
        "GET /v1beta/models/Pointer%20Display%20Model",
      ]);
      expect(calls[0]?.body).toMatchObject({
        systemInstruction: { parts: [{ text: "Return JSON" }] },
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object", required: ["answer"] },
          thinkingConfig: { includeThoughts: true, thinkingBudget: 64 },
        },
      });
      expect(calls[3]?.body).toMatchObject({
        requests: [
          { model: "models/Pointer Embedding Model", content: { parts: [{ text: "one" }] } },
          { model: "models/Pointer Embedding Model", content: { parts: [{ text: "two" }] } },
        ],
      });
    } finally {
      server.stop(true);
    }
  });
});
