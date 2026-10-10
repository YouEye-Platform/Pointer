import { z } from "zod";

export const modelCapabilityOverridesSchema = z.object({ tools: z.boolean().optional() }).strict();
export type ModelCapabilityOverrides = z.infer<typeof modelCapabilityOverridesSchema>;
export type ToolCapability = {
  status: "supported" | "unsupported" | "unknown";
  source: string;
  observedAt: string | null;
};

export function toolCapability(value: boolean | null | undefined, source: string, observedAt: string | null = null): ToolCapability {
  return { status: value === true ? "supported" : value === false ? "unsupported" : "unknown", source, observedAt };
}

export function toolCapabilityValue(evidence: ToolCapability): boolean | null {
  return evidence.status === "supported" ? true : evidence.status === "unsupported" ? false : null;
}

/** Positive list membership is evidence; omission is not an explicit denial. */
export function discoveredToolCapability(model: Record<string, unknown>, fallback?: boolean, observedAt: string | null = null): ToolCapability {
  for (const field of ["supports_tool_use", "supportsTools", "supports_tools"]) {
    if (typeof model[field] === "boolean") return toolCapability(model[field], `discovery.${field}`, observedAt);
  }
  const nested = model.capabilities;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const field of ["tools", "tool_use", "function_calling"]) {
      const value = (nested as Record<string, unknown>)[field];
      if (typeof value === "boolean") return toolCapability(value, `discovery.capabilities.${field}`, observedAt);
    }
  }
  if (Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools")) {
    return toolCapability(true, "discovery.supported_parameters", observedAt);
  }
  if (Array.isArray(nested) && nested.some(value => ["tools", "tool_use", "function_calling"].includes(String(value)))) {
    return toolCapability(true, "discovery.capabilities", observedAt);
  }
  const richer = model.capability_discovery;
  if (richer && typeof richer === "object" && !Array.isArray(richer)) {
    const record = richer as Record<string, unknown>;
    const evidence = discoveredToolCapability({
      supports_tool_use: record.supports_tool_use, supportsTools: record.supportsTools, supports_tools: record.supports_tools,
      capabilities: record.capabilities, supported_parameters: record.supported_parameters,
    }, undefined, typeof record.observedAt === "string" ? record.observedAt : observedAt);
    if (evidence.status !== "unknown") return { ...evidence, source: `capability-discovery.${evidence.source.replace("discovery.", "")}` };
  }
  const retained = model.pointer_tool_evidence as Partial<ToolCapability> | undefined;
  if (retained && ["supported", "unsupported"].includes(String(retained.status))
    && typeof retained.source === "string" && /^(discovery\.|capability-discovery\.)/.test(retained.source)
    && (retained.observedAt === null || typeof retained.observedAt === "string")) {
    return retained as ToolCapability;
  }
  if (typeof fallback === "boolean") return toolCapability(fallback, "provider.manifest", observedAt);
  return toolCapability(null, "discovery.unspecified", observedAt);
}

/** Persist evidence, preserving prior explicit declarations when later metadata omits them. */
export function recordDiscoveredToolEvidence(model: Record<string, unknown>, previous: unknown, fallback?: boolean, observedAt = new Date().toISOString()): Record<string, unknown> {
  const { pointer_tool_evidence: _untrusted, ...current } = model;
  let evidence = discoveredToolCapability(current, fallback, observedAt);
  if (evidence.status === "unknown" && previous && typeof previous === "object" && !Array.isArray(previous)) {
    const record = previous as Record<string, unknown>;
    const storedTime = (record.pointer_tool_evidence as Partial<ToolCapability> | undefined)?.observedAt;
    const earlier = discoveredToolCapability(record, undefined, typeof storedTime === "string" ? storedTime : null);
    if (earlier.status !== "unknown" && /^(discovery\.|capability-discovery\.)/.test(earlier.source)) evidence = earlier;
  }
  return { ...current, pointer_tool_evidence: evidence };
}

/** Reconcile legacy inferred false without erasing a boolean present in raw evidence. */
export function persistedToolCapability(raw: unknown, stored: boolean | null | undefined, fallback?: boolean, observedAt: string | null = null): ToolCapability {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const evidence = discoveredToolCapability(raw as Record<string, unknown>, fallback, observedAt);
    if (evidence.status !== "unknown") return evidence;
    // Legacy sync promoted positive manifest/catalog evidence into the column.
    if (stored === true) return toolCapability(true, "legacy.persisted-positive", observedAt);
    return evidence;
  }
  return toolCapability(stored, "persisted", observedAt);
}
