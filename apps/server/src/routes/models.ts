import { Hono } from "hono";
import { apiKeyMiddleware, type ApiKeyContext } from "../middleware/api-key";
import { listModelsForApiKey } from "../services/model-resolution";

const app = new Hono<{ Variables: ApiKeyContext }>();

app.use("*", apiKeyMiddleware);

app.get("/models", async (c) => {
  const apiKey = c.get("apiKey");
  const entries = await listModelsForApiKey(apiKey);

  const models = entries.map((entry) => ({
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
  }));

  return c.json({ object: "list", data: models });
});

export default app;
