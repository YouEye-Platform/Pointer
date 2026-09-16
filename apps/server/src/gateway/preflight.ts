import type { JsonObject, JsonValue } from "./protocol/v1/schemas";

export type GatewayCapability = "tools" | "vision" | "streaming";

export interface GatewayModelCapabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
}

export function requestsAnthropicServerTool(body: JsonObject): boolean {
  return Array.isArray(body.tools) && body.tools.some(
    (tool) => tool !== null
      && typeof tool === "object"
      && !Array.isArray(tool)
      && typeof tool.type === "string",
  );
}

function requestsVision(value: JsonValue, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => requestsVision(item, depth + 1));
  const type = value.type;
  if (type === "image" || type === "image_url" || type === "input_image") return true;
  const inlineData = value.inlineData;
  if (
    inlineData
    && typeof inlineData === "object"
    && !Array.isArray(inlineData)
    && typeof inlineData.mimeType === "string"
    && inlineData.mimeType.startsWith("image/")
  ) return true;
  const fileData = value.fileData;
  if (
    fileData
    && typeof fileData === "object"
    && !Array.isArray(fileData)
    && typeof fileData.mimeType === "string"
    && fileData.mimeType.startsWith("image/")
  ) return true;
  return Object.values(value).some((item) => requestsVision(item, depth + 1));
}

function requestsTools(value: JsonValue | undefined): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((tool) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return true;

    // Gemini CLI intentionally retains the Google tool wrapper when its
    // allowlist is empty. An empty declaration list has no tool semantics and
    // must not prevent prompt-only use of a model without tool capability.
    if (Array.isArray(tool.functionDeclarations)) {
      return tool.functionDeclarations.length > 0
        || Object.keys(tool).some((key) => key !== "functionDeclarations");
    }

    return true;
  });
}

export function requestedGatewayCapabilities(body: JsonObject): GatewayCapability[] {
  const requested: GatewayCapability[] = [];
  if (requestsTools(body.tools)
    || (Array.isArray(body.functions) && body.functions.length > 0)) {
    requested.push("tools");
  }
  if (requestsVision(body)) requested.push("vision");
  if (body.stream === true) requested.push("streaming");
  return requested;
}

export function unsupportedGatewayCapability(
  body: JsonObject,
  capabilities: GatewayModelCapabilities,
): GatewayCapability | null {
  return requestedGatewayCapabilities(body).find((capability) => !capabilities[capability]) ?? null;
}
