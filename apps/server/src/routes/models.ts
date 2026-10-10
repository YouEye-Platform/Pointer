import { registry } from "../providers/registry";
import { resolveWireCapabilities } from "../gateway/wire-capabilities";
import { resolveProviderGatewayOperation } from "../gateway/provider-operation";
import { Hono } from "hono";
import { apiKeyMiddleware, type ApiKeyContext } from "../middleware/api-key";
import { listModelsForApiKey } from "../services/model-resolution";

const app = new Hono<{ Variables: ApiKeyContext }>();

app.use("*", apiKeyMiddleware);

app.get("/models", async (c) => {
  const apiKey = c.get("apiKey");
  const entries = await listModelsForApiKey(apiKey);

  const models = await Promise.all(entries.map(async (entry) => {
    const provider = entry.providerAccountId ? await registry.getProviderForAccount(entry.providerId, entry.providerAccountId, apiKey.userId) : registry.getProvider(entry.providerId);
    const format = entry.nativeFormat ?? (provider ? resolveProviderGatewayOperation(provider.manifest, "generate").format : "chat-completions");
    return {
      id: entry.displayName,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "pointer",
      context_window: entry.contextWindow,
      max_output: entry.maxOutput,
      pricing: {
        input_per_million: entry.inputPrice,
        output_per_million: entry.outputPrice,
      },
      capabilities: entry.capabilities,
      capability_evidence: entry.capabilityEvidence,
      wire_capabilities: resolveWireCapabilities(format, provider?.manifest.gateway?.wire, entry.wireCapabilities, provider?.endpointWireCapabilities),
    };
  }));

  return c.json({ object: "list", data: models });
});

export default app;
