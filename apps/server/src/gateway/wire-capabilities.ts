import { z } from "zod";
import type { GatewayApiFormat } from "./compatibility";

/** Wire support is endpoint metadata, independent of a model's marketing name. */
export const wireCapabilityOverridesSchema = z.object({
  additionalTools: z.boolean().optional(),
  customTools: z.boolean().optional(),
  namespaceTools: z.boolean().optional(),
  grammar: z.boolean().optional(),
  toolSearch: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  clientMetadata: z.boolean().optional(),
  reasoningContext: z.boolean().optional(),
  verbosity: z.boolean().optional(),
  reasoningEfforts: z.array(z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])).min(1).optional(),
  toolNameMaxLength: z.number().int().min(24).max(256).optional(),
}).strict();
export type WireCapabilityOverrides = z.infer<typeof wireCapabilityOverridesSchema>;
export type WireCapabilities = Required<Omit<WireCapabilityOverrides, "reasoningEfforts">> & {
  reasoningEfforts?: WireCapabilityOverrides["reasoningEfforts"];
};

export function resolveWireCapabilities(
  format: GatewayApiFormat,
  provider?: WireCapabilityOverrides,
  model?: unknown,
  endpoint?: WireCapabilityOverrides,
): WireCapabilities {
  const declared = wireCapabilityOverridesSchema.safeParse(model);
  const result: WireCapabilities = {
    additionalTools: false, customTools: false, namespaceTools: false,
    grammar: false, toolSearch: false, webSearch: false, clientMetadata: false,
    reasoningContext: false, verbosity: false, toolNameMaxLength: 64,
    ...wireCapabilityOverridesSchema.parse(provider ?? {}),
    ...(declared.success ? declared.data : {}),
    ...wireCapabilityOverridesSchema.parse(endpoint ?? {}),
  };
  // These wires cannot carry Responses containers even if metadata says otherwise.
  if (format !== "responses") {
    result.additionalTools = false; result.customTools = false;
    result.namespaceTools = false; result.grammar = false;
    result.toolSearch = false; result.clientMetadata = false;
    result.reasoningContext = false; result.verbosity = false;
  }
  return result;
}

export const EXTENDED_RESPONSES_CAPABILITIES: WireCapabilities = {
  additionalTools: true, customTools: true, namespaceTools: true,
  grammar: true, toolSearch: true, webSearch: true, clientMetadata: true,
  reasoningContext: true, verbosity: true, toolNameMaxLength: 64,
};
