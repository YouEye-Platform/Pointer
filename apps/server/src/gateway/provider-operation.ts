import type { GatewayApiFormat } from "./compatibility";
import type { ProviderManifest } from "../providers/types";

export type ApiFormat = GatewayApiFormat;
export type GatewayProviderOperationId =
  | "generate"
  | "streamGenerate"
  | "countTokens"
  | "embedContent"
  | "batchEmbedContents";

export interface GatewayProviderOperation {
  operation: GatewayProviderOperationId;
  format: GatewayApiFormat;
  endpoint: string;
  declaration: "manifest" | "inferred";
}

export type GatewayOperationManifest = Pick<
  ProviderManifest,
  "type" | "endpoints" | "gateway"
>;

export function resolveProviderGatewayOperation(
  manifest: GatewayOperationManifest,
  operation: GatewayProviderOperationId = "generate",
): GatewayProviderOperation {
  const declared = manifest.gateway?.operations[operation];
  if (declared) {
    if (
      !["chat-completions", "messages", "responses", "google-generate-content"].includes(declared.format) ||
      !declared.endpoint.startsWith("/") ||
      declared.endpoint.startsWith("//")
    ) {
      throw new Error(`Invalid ${operation} gateway operation declaration`);
    }
    return { operation, ...declared, declaration: "manifest" };
  }

  if (operation !== "generate") {
    throw new Error(`Provider does not declare the ${operation} gateway operation`);
  }

  // Custom providers without an explicit operation use their declared wire endpoints and type.
  if (manifest.type === "anthropic-compatible") {
    return {
      operation,
      format: "messages",
      endpoint: manifest.endpoints?.messages ?? "/v1/messages",
      declaration: "inferred",
    };
  }
  if (manifest.endpoints?.chatCompletions) {
    return {
      operation,
      format: "chat-completions",
      endpoint: manifest.endpoints.chatCompletions,
      declaration: "inferred",
    };
  }
  if (manifest.endpoints?.responses) {
    return {
      operation,
      format: "responses",
      endpoint: manifest.endpoints.responses,
      declaration: "inferred",
    };
  }
  return {
    operation,
    format: "chat-completions",
    endpoint: "/chat/completions",
    declaration: "inferred",
  };
}

export function getProviderNativeFormat(provider: { manifest: GatewayOperationManifest }): GatewayApiFormat {
  return resolveProviderGatewayOperation(provider.manifest).format;
}

export function resolveProviderGatewayEndpoint(
  manifest: GatewayOperationManifest,
  endpointOverride?: string,
  operation: GatewayProviderOperationId = "generate",
): string {
  return endpointOverride ?? resolveProviderGatewayOperation(manifest, operation).endpoint;
}

export function buildProviderGatewayOperationUrl(
  baseUrl: string,
  manifest: GatewayOperationManifest,
  operation: GatewayProviderOperationId = "generate",
  model?: string,
): string {
  const endpoint = resolveProviderGatewayEndpoint(manifest, undefined, operation);
  const renderedEndpoint = model === undefined
    ? endpoint
    : endpoint.replace("{model}", encodeURIComponent(model.replace(/^models\//, "")));
  if (renderedEndpoint.includes("{model}")) {
    throw new Error(`Provider ${operation} endpoint requires a model`);
  }
  return `${baseUrl.replace(/\/$/, "")}${renderedEndpoint}`;
}
