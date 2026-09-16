import { describe, expect, test } from "bun:test";
import {
  requestedGatewayCapabilities,
  requestsAnthropicServerTool,
  unsupportedGatewayCapability,
} from "./preflight";

describe("gateway V1 capability preflight", () => {
  test("detects tools, image input, and streaming across public shapes", () => {
    expect(requestedGatewayCapabilities({
      model: "model",
      tools: [{ type: "function", function: { name: "lookup" } }],
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }],
      stream: true,
    })).toEqual(["tools", "vision", "streaming"]);

    expect(requestedGatewayCapabilities({
      model: "model",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }],
    })).toEqual(["vision"]);
  });

  test("returns the first explicitly unsupported requested capability", () => {
    expect(unsupportedGatewayCapability({
      model: "model",
      tools: [{ name: "lookup" }],
      stream: true,
    }, { tools: false, vision: true, streaming: false })).toBe("tools");
  });

  test("treats Gemini CLI's empty Google tool wrapper as prompt-only", () => {
    expect(requestedGatewayCapabilities({
      model: "model",
      tools: [{ functionDeclarations: [] }],
    })).toEqual([]);
    expect(unsupportedGatewayCapability({
      model: "model",
      tools: [{ functionDeclarations: [] }],
    }, { tools: false, vision: true, streaming: true })).toBeNull();

    expect(requestedGatewayCapabilities({
      model: "model",
      tools: [{ functionDeclarations: [{ name: "lookup" }] }],
    })).toEqual(["tools"]);
    expect(requestedGatewayCapabilities({
      model: "model",
      tools: [{ googleSearch: {} }],
    })).toEqual(["tools"]);
  });

  test("allows requests whose capabilities are supported", () => {
    expect(unsupportedGatewayCapability({
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }, { tools: true, vision: true, streaming: true })).toBeNull();
  });

  test("distinguishes Anthropic server tools from caller-defined tools", () => {
    expect(requestsAnthropicServerTool({
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      }],
    })).toBe(true);
    expect(requestsAnthropicServerTool({
      tools: [{
        name: "save_report",
        description: "Save a report",
        input_schema: { type: "object" },
      }],
    })).toBe(false);
  });
});
