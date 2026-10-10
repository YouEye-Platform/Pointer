import { version } from "../../package.json";
import { fetchProviderModels } from "../../src/providers/model-discovery";
import { providerAuthHeaders } from "../../src/providers/auth-headers";
import { selectGatewayProxyRequest, selectGatewayProxyResponse } from "../../src/gateway/protocol/v1/runtime-proxy";
import type { GatewayApiFormat } from "../../src/gateway/compatibility";
import type { IProviderHandler, ProviderManifest, StaticModel } from "../../src/providers/types";
import { wireCapabilityOverridesSchema } from "../../src/gateway/wire-capabilities";

const formats = {
  "@ai-sdk/openai-compatible": ["chat-completions", "/chat/completions"],
  "@ai-sdk/openai": ["responses", "/responses"],
  "@ai-sdk/anthropic": ["messages", "/messages"],
} as const;
// The official Go endpoint table takes precedence over delayed models.dev
// provider-package metadata. Exact IDs only; never infer protocol from a name.
const documentedPackages: Record<string, keyof typeof formats> = {
  "qwen3.8-max": "@ai-sdk/anthropic",
  "qwen3.8-flash": "@ai-sdk/anthropic",
  "qwen3.7-plus": "@ai-sdk/anthropic",
};
const object = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const positive = (v: unknown): number | undefined => typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

export function goModelMetadata(inventory: unknown[], metadata: unknown): StaticModel[] {
  const provider = object(object(metadata)?.["opencode-go"]);
  const models = object(provider?.models);
  if (!provider || !models) throw new Error("OpenCode Go model metadata is unavailable");
  return inventory.flatMap(raw => {
    const id = object(raw)?.id;
    const model = typeof id === "string" ? object(models[id]) : null;
    if (!model || model.status === "deprecated") return [];
    const npm = documentedPackages[id] || object(model.provider)?.npm || provider.npm;
    const protocol = formats[npm as keyof typeof formats];
    if (!protocol) return [];
    const reasoningEfforts = [...new Set((Array.isArray(model.reasoning_options) ? model.reasoning_options : []).flatMap((option: unknown) => {
      const declared = object(option);
      if (declared?.type !== "effort" || !Array.isArray(declared.values)) return [];
      return declared.values.flatMap((effort: unknown) => {
        const parsed = wireCapabilityOverridesSchema.safeParse({ reasoningEfforts: [effort] });
        return parsed.success ? parsed.data.reasoningEfforts ?? [] : [];
      });
    }))];
    return [{
      metadataEvidence: {source:"https://models.dev/api.json#opencode-go",protocolSource:documentedPackages[id] ? "https://opencode.ai/docs/go/" : "https://models.dev/api.json#opencode-go",fetchedAt:new Date().toISOString()},
      id, name: typeof model.name === "string" ? model.name : id,
      contextWindow: positive(model.limit?.context), maxOutput: positive(model.limit?.output),
      supportsTools: model.tool_call === true,
      supportsVision: Array.isArray(model.modalities?.input) && model.modalities.input.includes("image"),
      supportsStreaming: true,
      supportsReasoning: model.reasoning === true,
      ...(reasoningEfforts.length ? { wireCapabilities: { reasoningEfforts } } : {}),
      nativeFormat: protocol[0], nativeEndpoint: protocol[1],
      ...(typeof model.cost?.input === "number" ? { inputPrice: model.cost.input } : {}),
      ...(typeof model.cost?.output === "number" ? { outputPrice: model.cost.output } : {}),
    }];
  });
}

async function discoverGo(config: ProviderManifest, key: string) {
  const inventory = await fetchProviderModels(config, key);
  const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("OpenCode Go model metadata is unavailable");
  const models = goModelMetadata(inventory, await response.json());
  const accepted = new Set(models.map(model => model.id));
  return {models, diagnostics:{
    catalogueSource:"https://opencode.ai/zen/go/v1/models",
    metadataSource:"https://models.dev/api.json#opencode-go",
    fetchedAt:new Date().toISOString(),
    authentication:"unverified_by_public_catalogue",
    unsupportedModels:inventory.map(raw=>object(raw)?.id).filter(id=>typeof id === "string" && !accepted.has(id)),
  }};
}
const handler: IProviderHandler = {
  async fetchModels(config: ProviderManifest, key: string) {
    return (await discoverGo(config,key)).models;
  },
  async getAccountInfo(key: string, config: ProviderManifest) {
    return (await discoverGo(config,key)).diagnostics;
  },
  async testConnection(config, key) {
    try {
      // Public discovery cannot validate a subscription. Probe one paid model
      // through inference, using a bounded coding request on this account only.
      const { models } = await discoverGo(config, key);
      // Use the documented general coding model. Picking the cheapest public
      // entry can select a region-restricted model (for example Muse Spark),
      // falsely making a valid key look unusable. Never retry other models.
      const model = models.find(m => m.id === "glm-5.3-flash" && m.supportsTools && m.nativeFormat && m.nativeEndpoint
        && typeof m.inputPrice === "number" && typeof m.outputPrice === "number"
        && m.inputPrice + m.outputPrice > 0);
      if (!model) return {success:false,status:422,error:"The Go connection-check model is unavailable. Use Model Test to select an available subscription model."};
      const format = model.nativeFormat as GatewayApiFormat;
      const selected = selectGatewayProxyRequest({sourceFormat:"chat-completions",targetFormat:format,providerModelId:model.id,payload:{
        model:model.id,stream:false,max_tokens:512,
        messages:[{role:"user",content:"Review this JavaScript function for a coding connection check: function add(a, b) { return a - b; }. Return only the corrected one-line function."}],
      }});
      if (!selected.ok) return {success:false,status:422,error:"The selected Go model cannot run the connection check."};
      const headers = {...config.headers,...providerAuthHeaders(config,key),"Content-Type":"application/json",
        "User-Agent":`Pointer/${version}`,"x-opencode-session":`pointer-connection-${crypto.randomUUID()}`,
        ...(format === "messages" ? {"x-api-key":key,"anthropic-version":"2023-06-01"} : {}),
      };
      const response = await fetch(`${config.baseUrl.replace(/\/$/,"")}${model.nativeEndpoint}`,{
        method:"POST",headers,body:JSON.stringify(selected.request),signal:AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = response.status === 401 ? "OpenCode Go rejected this API key. Copy the key from the subscribed workspace in OpenCode Console."
          : response.status === 403 ? "OpenCode Go denied subscription access. Check this key's workspace and active Go subscription in OpenCode Console."
          : response.status === 429 ? "OpenCode Go usage or rate limit reached. Check your subscription usage in OpenCode Console."
          : `OpenCode Go connection check failed (HTTP ${response.status}). Try Model Test for the selected model.`;
        return {success:false,status:response.status,error};
      }
      const result = selectGatewayProxyResponse({sourceFormat:format,targetFormat:"chat-completions",payload:await response.json(),model:model.id});
      return result.ok ? {success:true,status:response.status}
        : {success:false,status:502,error:"OpenCode Go returned an invalid inference response."};
    } catch {
      // Never reflect provider response bodies, credentials or network errors.
      return {success:false,status:0,error:"OpenCode Go connection check could not complete. Check connectivity, sync models and try again."};
    }
  },
  buildHeaders(ctx) {
    if (!ctx.providerSessionId) throw new Error("OpenCode Go requires a stable conversation header (x-opencode-session)");
    return {
      "x-opencode-session": ctx.providerSessionId,
      "User-Agent": `Pointer/${version}`,
      ...(ctx.providerNativeEndpoint === "/messages" ? { "x-api-key": ctx.providerApiKey, "anthropic-version": "2023-06-01" } : {}),
    };
  },
};
export default handler;
