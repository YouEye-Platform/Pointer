import type { WireCapabilities } from "../../wire-capabilities";
import { EXTENDED_RESPONSES_CAPABILITIES, resolveWireCapabilities } from "../../wire-capabilities";
import { prepareToolCodec, restoreIrTools, type ToolCodecContext } from "./tool-codec";
import { invalidPayloadFailure, finding, completeAdapter } from "./common";
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
  toolContext?: ToolCodecContext;
}

export interface GatewayRequestExecutionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  model?: string;
  adapterMode?: GatewayAdapterMode;
  wireCapabilities?: WireCapabilities;
}

export interface GatewayResponseExecution extends GatewayRequestExecution {}

export interface GatewayResponseExecutionInput {
  sourceFormat: GatewayApiFormat;
  targetFormat: GatewayApiFormat;
  payload: unknown;
  model: string;
  adapterMode?: GatewayAdapterMode;
  toolContext?: ToolCodecContext;
}

export function executeGatewayRequestAdapter(
  input: GatewayRequestExecutionInput,
): GatewayRequestExecution | GatewayAdapterFailure {
  const adapterMode = input.adapterMode ?? "best-effort";
  const parsed = parsePublicRequest(input.sourceFormat, input.payload, adapterMode);
  if (!parsed.ok) return parsed;
  try {
    if (parsed.value.turns.flatMap(t => t.blocks).some(b => b.type === "reasoning" && b.encryptedContent && (b.encryptedSourceFormat ?? input.sourceFormat) !== input.targetFormat)) throw new Error("Opaque reasoning replay is protocol scoped");
    if (parsed.value.reasoning?.effort && input.wireCapabilities?.reasoningEfforts && !input.wireCapabilities.reasoningEfforts.includes(parsed.value.reasoning.effort)) throw new Error("Unsupported reasoning effort");
    const prepared = prepareToolCodec(parsed.value, input.targetFormat, input.wireCapabilities ?? (input.targetFormat === "responses" ? EXTENDED_RESPONSES_CAPABILITIES : resolveWireCapabilities(input.targetFormat)));
    const rendered = renderPublicRequest(
      input.targetFormat,
      prepared.request,
      adapterMode,
      input.model ?? parsed.value.model,
    );
    if (!rendered.ok) return rendered;
    const value = { ...rendered.value };
    const caps = input.wireCapabilities;
    if (caps && input.targetFormat === "responses") {
      if (!caps.clientMetadata) delete value.client_metadata;
      if (!caps.reasoningContext && value.reasoning && typeof value.reasoning === "object" && !Array.isArray(value.reasoning)) { const reasoning = { ...value.reasoning }; delete reasoning.context; value.reasoning = reasoning; }
      if (!caps.verbosity && value.text && typeof value.text === "object" && !Array.isArray(value.text)) { const text = { ...value.text }; delete text.verbosity; value.text = text; }
    }
    const findings = [...parsed.findings, ...rendered.findings];
    if (prepared.context.grammarPrompted) findings.push(finding(input.sourceFormat, "tools.format", "lossy", "pointer_custom_grammar_prompted", "Grammar is prompted, not enforced by this endpoint.", input.targetFormat));
    const assessed = completeAdapter(input.targetFormat, adapterMode, value, findings);
    if (!assessed.ok) return assessed;
    return { primaryEngine: "v1", value: assessed.value, findings: assessed.findings, toolContext: prepared.context };
  } catch { return invalidPayloadFailure(input.sourceFormat, [{ path: "tools", message: "Invalid or unsupported tool semantics" }]); }
}

export function executeGatewayResponseAdapter(
  input: GatewayResponseExecutionInput,
): GatewayResponseExecution | GatewayAdapterFailure {
  const adapterMode = input.adapterMode ?? "best-effort";
  const parsed = parsePublicResponse(input.sourceFormat, input.payload, adapterMode);
  if (!parsed.ok) return parsed;
  try {
    if (input.targetFormat !== "responses" && !input.toolContext && parsed.value.output.some(b => b.type === "tool_call" && (b.inputKind === "text" || b.namespace || b.toolKind))) throw new Error("Undeclared extended tool response");
    const rendered = renderPublicResponse(input.targetFormat, restoreIrTools(parsed.value, input.toolContext), adapterMode, input.model);
    if (!rendered.ok) return rendered;
    return { primaryEngine: "v1", value: rendered.value, findings: rendered.findings };
  } catch { return invalidPayloadFailure(input.sourceFormat, [{ path: "output", message: "Invalid bridged tool response" }]); }
}
