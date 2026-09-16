import type { GatewayApiFormat } from "../../compatibility";
import type {
  GatewayAdapterFailure,
  GatewayAdapterMode,
  IrCompatibilityFinding,
  JsonObject,
} from "./schemas";
import {
  parsePublicRequest,
  parsePublicResponse,
  renderPublicRequest,
  renderPublicResponse,
} from "./adapters";

export interface GatewayRequestExecution {
  primaryEngine: "v1";
  value: JsonObject;
  findings: IrCompatibilityFinding[];
}

export interface GatewayRequestExecutionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  model?: string;
  adapterMode?: GatewayAdapterMode;
}

export interface GatewayResponseExecution extends GatewayRequestExecution {}

export interface GatewayResponseExecutionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  model: string;
  adapterMode?: GatewayAdapterMode;
}

export function executeGatewayRequestAdapter(
  input: GatewayRequestExecutionInput,
): GatewayRequestExecution | GatewayAdapterFailure {
  const adapterMode = input.adapterMode ?? "best-effort";
  const parsed = parsePublicRequest(input.sourceFormat, input.payload, adapterMode);
  if (!parsed.ok) return parsed;
  const rendered = renderPublicRequest(
    input.targetFormat,
    parsed.value,
    adapterMode,
    input.model ?? parsed.value.model,
  );
  if (!rendered.ok) return rendered;
  return { primaryEngine: "v1", value: rendered.value, findings: rendered.findings };
}

export function executeGatewayResponseAdapter(
  input: GatewayResponseExecutionInput,
): GatewayResponseExecution | GatewayAdapterFailure {
  const adapterMode = input.adapterMode ?? "best-effort";
  const parsed = parsePublicResponse(input.sourceFormat, input.payload, adapterMode);
  if (!parsed.ok) return parsed;
  const rendered = renderPublicResponse(input.targetFormat, parsed.value, adapterMode, input.model);
  if (!rendered.ok) return rendered;
  return { primaryEngine: "v1", value: rendered.value, findings: rendered.findings };
}
