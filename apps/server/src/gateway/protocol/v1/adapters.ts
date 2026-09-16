import { responseItemFromBlock } from "./responses-native";
import type { GatewayApiFormat } from "../../compatibility";
import { ZodError } from "zod";
import type {
  GatewayAdapterMode,
  GatewayAdapterResult,
  IrRequest,
  IrResponse,
  JsonObject,
} from "./schemas";
import { parseChatRequest, parseChatResponse, renderChatRequest, renderChatResponse } from "./chat";
import { parseMessagesRequest, parseMessagesResponse, renderMessagesRequest, renderMessagesResponse } from "./messages";
import { parseResponsesRequest, parseResponsesResponse, renderResponsesRequest, renderResponsesResponse } from "./responses";
import { parseGoogleRequest, parseGoogleResponse, renderGoogleRequest, renderGoogleResponse } from "./google";
import { invalidPayloadFailure, zodIssues } from "./common";

export function parsePublicRequest(
  format: GatewayApiFormat,
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrRequest> {
  try {
    if (format === "chat-completions") return parseChatRequest(input, mode);
    if (format === "messages") return parseMessagesRequest(input, mode);
    if (format === "responses") return parseResponsesRequest(input, mode);
    return parseGoogleRequest(input, mode);
  } catch (error) {
    return invalidPayloadFailure(format, error instanceof ZodError ? zodIssues(error) : [{ path: "request", message: "Gateway request validation failed" }]);
  }
}

export function renderPublicRequest(
  format: GatewayApiFormat,
  request: IrRequest,
  mode: GatewayAdapterMode = request.compatibilityPolicy,
  model = request.model,
): GatewayAdapterResult<JsonObject> {
  try {
    if (format !== "responses" && request.turns.some(turn => turn.blocks.some(block => responseItemFromBlock(block)))) {
      return invalidPayloadFailure(format, [{ path: "input", message: "Native Responses items require a Responses route" }]);
    }
    if (format === "chat-completions") return renderChatRequest(request, mode, model);
    if (format === "messages") return renderMessagesRequest(request, mode, model);
    if (format === "responses") return renderResponsesRequest(request, mode, model);
    return renderGoogleRequest(request, mode, model);
  } catch (error) {
    return invalidPayloadFailure(format, error instanceof ZodError ? zodIssues(error) : [{ path: "request", message: "Gateway request rendering failed" }]);
  }
}

export function parsePublicResponse(
  format: GatewayApiFormat,
  input: unknown,
  mode: GatewayAdapterMode = "best-effort",
): GatewayAdapterResult<IrResponse> {
  try {
    if (format === "chat-completions") return parseChatResponse(input, mode);
    if (format === "messages") return parseMessagesResponse(input, mode);
    if (format === "responses") return parseResponsesResponse(input, mode);
    return parseGoogleResponse(input, mode);
  } catch (error) {
    return invalidPayloadFailure(format, error instanceof ZodError ? zodIssues(error) : [{ path: "response", message: "Gateway response validation failed" }]);
  }
}

export function renderPublicResponse(
  format: GatewayApiFormat,
  response: IrResponse,
  mode: GatewayAdapterMode = response.compatibilityPolicy,
  model = response.model,
): GatewayAdapterResult<JsonObject> {
  try {
    if (format !== "responses" && response.output.some(block => responseItemFromBlock(block))) {
      return invalidPayloadFailure(format, [{ path: "output", message: "Native Responses items require a Responses client" }]);
    }
    if (format === "chat-completions") return renderChatResponse(response, mode, model);
    if (format === "messages") return renderMessagesResponse(response, mode, model);
    if (format === "responses") return renderResponsesResponse(response, mode, model);
    return renderGoogleResponse(response, mode, model);
  } catch (error) {
    return invalidPayloadFailure(format, error instanceof ZodError ? zodIssues(error) : [{ path: "response", message: "Gateway response rendering failed" }]);
  }
}
