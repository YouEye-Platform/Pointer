import { describe, expect, test } from "bun:test";
import { parsePublicResponse, renderPublicResponse, type IrResponse } from ".";

function responseWithOutput(output: IrResponse["output"]): IrResponse {
  return {
    protocol: "pointer.gateway.ir",
    version: 1,
    kind: "response",
    sourceFormat: "responses",
    compatibilityPolicy: "best-effort",
    compatibility: [],
    extensions: [],
    id: "resp_semantic_loss",
    model: "model",
    status: "completed",
    output,
    finishReason: "stop",
  };
}

describe("Gateway V1 response semantic loss", () => {
  test("Messages makes refusal-to-text conversion explicit", () => {
    const response = responseWithOutput([
      { type: "refusal", text: "Cannot comply", id: "msg_refusal_1" },
    ]);
    const bestEffort = renderPublicResponse("messages", response, "best-effort");
    expect(bestEffort.ok).toBe(true);
    if (bestEffort.ok) {
      expect(bestEffort.value.content).toEqual([{ type: "text", text: "Cannot comply" }]);
      expect(bestEffort.findings.map((entry) => entry.detailCode)).toContain(
        "pointer_messages_refusal_emulated",
      );
    }
    const strict = renderPublicResponse("messages", response, "strict");
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.code).toBe("pointer_feature_lossy");
  });

  test("Chat and Messages report Responses item IDs they cannot represent", () => {
    const response = responseWithOutput([
      {
        type: "tool_call",
        id: "call_1",
        itemId: "item_1",
        name: "lookup",
        arguments: {},
      },
    ]);
    for (const format of ["chat-completions", "messages"] as const) {
      const rendered = renderPublicResponse(format, response, "best-effort");
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.findings.some((entry) =>
          entry.detailCode.endsWith("output_item_id_dropped")
        )).toBe(true);
      }
    }
  });

  test("Responses annotations round-trip and cross-format loss is explicit", () => {
    const parsed = parsePublicResponse("responses", {
      id: "resp_annotations",
      model: "model",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_annotations",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "cited",
          annotations: [{ type: "url_citation", url: "https://example.invalid" }],
        }],
      }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sameFormat = renderPublicResponse("responses", parsed.value, "best-effort");
    expect(sameFormat.ok).toBe(true);
    if (sameFormat.ok) expect(JSON.stringify(sameFormat.value)).toContain("url_citation");

    for (const format of ["chat-completions", "messages"] as const) {
      const bestEffort = renderPublicResponse(format, parsed.value, "best-effort");
      expect(bestEffort.ok).toBe(true);
      if (bestEffort.ok) {
        expect(bestEffort.findings.some((entry) =>
          entry.detailCode.endsWith("annotations_dropped")
        )).toBe(true);
      }
      const strict = renderPublicResponse(format, parsed.value, "strict");
      expect(strict.ok).toBe(false);
    }
  });
});
