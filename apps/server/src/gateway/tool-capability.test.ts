import { expect, test } from "bun:test";
import { discoveredToolCapability, recordDiscoveredToolEvidence, persistedToolCapability, toolCapabilityValue, modelCapabilityOverridesSchema } from "./tool-capability";
import { unsupportedGatewayCapability } from "./preflight";

test("missing discovery reconciles an inferred false, without erasing explicit denials", () => {
  expect(persistedToolCapability({ id: "fixture" }, false).status).toBe("unknown");
  for (const field of ["supportsTools", "supports_tools", "supports_tool_use"]) {
    expect(persistedToolCapability({ [field]: false }, false, true)).toMatchObject({ status: "unsupported", source: `discovery.${field}` });
  }
  expect(persistedToolCapability(null, false).status).toBe("unsupported");
  expect(persistedToolCapability({ id: "fixture" }, true).status).toBe("supported");
  expect(discoveredToolCapability({ supported_parameters: ["temperature"] }).status).toBe("unknown");
});

test("richer discovery normalizes positive and negative evidence but omission stays unknown", () => {
  expect(discoveredToolCapability({ capabilities: ["chat", "tools"] }).status).toBe("supported");
  expect(discoveredToolCapability({ capabilities: ["chat", "vision"] }).status).toBe("unknown");
  expect(discoveredToolCapability({ capabilities: { tools: false } }).status).toBe("unsupported");
  expect(discoveredToolCapability({ capability_discovery: { capabilities: ["tools"], observedAt: "2026-01-01T00:00:00Z" } })).toMatchObject({ status: "supported", source: "capability-discovery.capabilities", observedAt: "2026-01-01T00:00:00Z" });
  expect(discoveredToolCapability({ supportsTools: false, capability_discovery: { capabilities: ["tools"] } }).status).toBe("unsupported");
  expect(modelCapabilityOverridesSchema.safeParse({ tools: true }).success).toBe(true);
  expect(modelCapabilityOverridesSchema.safeParse({ customTools: true }).success).toBe(false);
});

test("unknown tools forward while explicit unsupported declarations and history fail", () => {
  const requests: import("./protocol/v1/schemas").JsonObject[] = [
    { tools: [{ type: "function", name: "lookup" }] },
    { additional_tools: [{ type: "custom", name: "lookup" }] },
    { input: [{ type: "additional_tools", tools: [{ type: "custom", name: "lookup" }] }] },
    { input: [{ type: "function_call_output", call_id: "call", output: "value" }] },
    { messages: [{ role: "tool", tool_call_id: "call", content: "value" }] },
    { contents: [{ role: "user", parts: [{ functionResponse: { name: "lookup", response: { value: "ok" } } }] }] },
  ];
  for (const body of requests) {
    expect(unsupportedGatewayCapability(body, { tools: toolCapabilityValue(discoveredToolCapability({})), vision: true, streaming: true })).toBeNull();
    expect(unsupportedGatewayCapability(body, { tools: false, vision: true, streaming: true })).toBe("tools");
  }
});

test("sync retains explicit prior negatives when metadata goes sparse, and never retains inferred defaults", () => {
  const negative = recordDiscoveredToolEvidence({id:"fixture", supportsTools:false}, null, undefined, "2026-01-01T00:00:00Z");
  const sparse = recordDiscoveredToolEvidence({id:"fixture"}, negative, undefined, "2026-02-01T00:00:00Z");
  expect(discoveredToolCapability(sparse)).toMatchObject({status:"unsupported", source:"discovery.supportsTools"});
  const unknown = recordDiscoveredToolEvidence({id:"fixture"}, {id:"fixture"});
  expect(discoveredToolCapability(unknown).status).toBe("unknown");
  const positive = recordDiscoveredToolEvidence({id:"fixture", supportsTools:true}, sparse);
  expect(discoveredToolCapability(positive).status).toBe("supported");
});
