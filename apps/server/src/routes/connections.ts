import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { EngineCapacityError, isManagementOperation } from "@pointer/engine";
import type { AuthUser } from "../middleware/auth";
import { enginePool, initialEngineConfig } from "../services/engine";
import { syncEngineCatalog } from "../services/engine-catalog";

// app.ts authenticates and authorizes this surface before acquiring an engine.
// An owner cannot be selected through the URL, query, or request body.
const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
app.post("/sync", async c => {
  const owner = c.get("user")?.ownerUserId;
  if (!owner) return c.json({ error: "Account owner required" }, 403);
  const input = await c.req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input) || (input.reference !== undefined && typeof input.reference !== "boolean"))
    return c.json({ error: "A JSON object with an optional reference boolean is required" }, 400);
  try { return c.json(await syncEngineCatalog(owner, input.reference !== false)); }
  catch { return c.json({ error: "Model discovery could not finish; retry shortly" }, 502); }
});
app.all("/*", async c => {
  const url = new URL(c.req.url);
  const path = "/api" + url.pathname.slice("/api/connections".length) + url.search;
  // Visibility belongs to Pointer groups, not a second public engine switch.
  if (path.split("?")[0] === "/api/model-visibility") return c.json({ error: "Unsupported provider operation" }, 404);
  if (path.split("?")[0] === "/api/combos" && c.req.method !== "GET")
    return c.json({ error: "Configure routing through a Pointer group" }, 403);
  if (!isManagementOperation(path, c.req.method))
    return c.json({ error: "Unsupported connection operation" }, 404);
  const owner = c.get("user")?.ownerUserId;
  if (!owner) return c.json({ error: "Account owner required" }, 403);
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (hasBody && c.req.method !== "DELETE" && !c.req.header("content-type")?.startsWith("application/json"))
    return c.json({ error: "A JSON request body is required" }, 415);
  const body = hasBody ? await c.req.text() : undefined;
  if (body) {
    try {
      const value = JSON.parse(body);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch { return c.json({ error: "A JSON object is required" }, 400); }
  }
  try {
    const response = await enginePool.run(owner, initialEngineConfig, async engine => {
      const response = await engine.management(path, {
        method: c.req.method, headers: { "content-type": "application/json" },
        body: body || undefined, signal: c.req.raw.signal,
      });
      const operation = path.split("?")[0];
      if (response.ok && operation?.includes("login")) {
        const result = await response.clone().json() as { flowId?: string; status?: string; done?: boolean };
        const submitted = body ? JSON.parse(body) : {};
        if (operation === "/api/codex-auth/login" && typeof result.flowId === "string")
          enginePool.hold(owner, `codex:${result.flowId}`);
        if (operation === "/api/oauth/login" && typeof submitted.provider === "string")
          enginePool.hold(owner, `oauth:${submitted.provider}`);
        if (operation === "/api/codex-auth/login/cancel" && typeof submitted.flowId === "string")
          enginePool.releaseHold(owner, `codex:${submitted.flowId}`);
        if (operation === "/api/oauth/login/cancel" && typeof submitted.provider === "string")
          enginePool.releaseHold(owner, `oauth:${submitted.provider}`);
        if (operation === "/api/codex-auth/login-status" && ["done", "error", "expired", "cancelled"].includes(result.status ?? ""))
          enginePool.releaseHold(owner, `codex:${url.searchParams.get("flowId")}`);
      }
      if (response.ok && operation === "/api/oauth/status") {
        const result = await response.clone().json() as { done?: boolean; error?: string };
        if (result.done || result.error) enginePool.releaseHold(owner, `oauth:${url.searchParams.get("provider")}`);
      }
      return response;
    });
    const headers = new Headers({ "cache-control": "no-store" });
    headers.set("content-type", response.headers.get("content-type") ?? "application/json");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof EngineCapacityError)
      return c.json({ error: "Connection capacity is busy; retry shortly" }, 503, { "retry-after": "5" });
    return c.json({ error: "Connection service unavailable" }, 502);
  }
});

export default app;
