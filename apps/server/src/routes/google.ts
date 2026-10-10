import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiKeyMiddleware } from "../middleware/api-key";
import { listModelsForApiKey, resolveModel } from "../services/model-resolution";
import { googleEngineRequest, googleEngineResponse, googleEngineCountRequest } from "../services/engine-google";
import { forwardInference, type InferenceEnv } from "./inference";

const app = new Hono<InferenceEnv>();
app.use("*", apiKeyMiddleware);
app.use("*", bodyLimit({ maxSize: 32 * 1024 * 1024 }));
const modelView = (entry: Pick<Awaited<ReturnType<typeof listModelsForApiKey>>[number], "displayName" | "contextWindow" | "maxOutput">) => ({
  name: `models/${entry.displayName}`, displayName: entry.displayName,
  inputTokenLimit: entry.contextWindow, outputTokenLimit: entry.maxOutput,
  supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
});
app.get("/models", async c => c.json({ models: (await listModelsForApiKey(c.get("apiKey"))).map(modelView) }));
app.get("/models/*", async c => {
  const name = decodeURIComponent(new URL(c.req.url).pathname.split("/models/")[1] ?? "");
  const model = await resolveModel(name, c.get("apiKey"));
  return model ? c.json(modelView({ ...model, displayName: name })) : c.json({ error: { code: 404, status: "NOT_FOUND", message: "Model not found" } }, 404);
});
app.post("/models/*", async c => {
  const target = new URL(c.req.url).pathname.split("/models/")[1] ?? "";
  const colon = target.lastIndexOf(":");
  const model = decodeURIComponent(target.slice(0, colon));
  const action = target.slice(colon + 1);
  if (colon < 1 || !["generateContent", "streamGenerateContent", "countTokens"].includes(action))
    return c.json({ error: { code: 404, status: "NOT_FOUND", message: "Model method not found" } }, 404);
  let body: Record<string, unknown>;
  try { body = action === "countTokens" ? googleEngineCountRequest(await c.req.json(), model)
    : googleEngineRequest(await c.req.json(), model, action === "streamGenerateContent"); }
  catch { return c.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid Gemini request" } }, 400); }
  try {
    if (action === "countTokens") {
      const response = await forwardInference(c, "/messages/count_tokens", body);
      if (!response.ok) return googleEngineResponse(response, model, c.get("gatewayRequestId"));
      const count = await response.json() as { input_tokens?: unknown };
      if (typeof count.input_tokens !== "number" || !Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0)
        throw new Error("Invalid engine token count");
      return c.json({ totalTokens: count.input_tokens }, 200, {
        "cache-control": "no-store", "x-pointer-token-count-source": "estimated",
      });
    }
    return await googleEngineResponse(await forwardInference(c, "/responses", body), model, c.get("gatewayRequestId"));
  } catch {
    return c.json({ error: { code: 502, status: "UNAVAILABLE", message: "Gemini response could not be completed" } }, 502);
  }
});

export default app;
