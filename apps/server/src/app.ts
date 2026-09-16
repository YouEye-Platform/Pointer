import { Hono } from "hono";
import {
  POINTER_CAPABILITY_CONTRACT_VERSION,
  type PointerSurface,
} from "@pointer/contracts/capabilities";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { nanoid } from "nanoid";
import { config } from "./config";
import {
  authMiddleware,
  requirePermission,
  type AuthUser,
  type PointerPermission,
} from "./middleware/auth";
import adminRoutes from "./routes/admin";
import authRoutes from "./routes/auth";
import catalogRoutes from "./routes/catalog";
import codexAuthRoutes from "./routes/codex-auth";
import instancesRoutes from "./routes/instances";
import keysRoutes from "./routes/keys";
import modelGroupsRoutes from "./routes/model-groups";
import modelsRoutes from "./routes/models";
import platformRoutes from "./routes/platform";
import providersRoutes from "./routes/providers";
import providerAccountsRoutes from "./routes/provider-accounts";
import proxyRoutes, { googleProxyRoutes } from "./routes/proxy";
import sourcesRoutes from "./routes/sources";
import statsRoutes from "./routes/stats";
import testModelRoutes from "./routes/test-model";
import { auditManagementAction } from "./services/management-audit";
import { buildInfo } from "./services/build-info";
import { readiness } from "./services/readiness";
import type { PointerRuntimeBindings } from "./http-runtime";
import {
  GATEWAY_ENGINE_HEADER,
  GATEWAY_ENGINE_VERSION,
  GATEWAY_REQUEST_ID_HEADER,
  resolveRequestId,
} from "./gateway/compatibility";

type AppVariables = {
  gatewayRequestId: string;
  user: AuthUser;
  requestId: string;
};

type AppEnv = {
  Bindings: PointerRuntimeBindings;
  Variables: AppVariables;
};

export function requestIdMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const supplied = c.req.header("x-request-id")?.trim();
    const requestId =
      supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
        ? supplied
        : `req_${nanoid(16)}`;
    c.set("requestId", requestId);
    await next();
    if (!c.res.headers.has("x-pointer-request-id")) {
      c.header("x-pointer-request-id", requestId);
    }
  };
}

function gatewayRequestIdMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const resolution = resolveRequestId(c.req.header("x-request-id"));
    c.set("gatewayRequestId", resolution.metadata.requestId);
    c.header(GATEWAY_REQUEST_ID_HEADER, resolution.metadata.requestId);
    c.header(GATEWAY_ENGINE_HEADER, GATEWAY_ENGINE_VERSION);
    if (!resolution.ok) {
      if (c.req.path === "/v1beta" || c.req.path.startsWith("/v1beta/")) {
        return c.json({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: resolution.message,
            details: [{
              "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
              reason: resolution.code,
            }],
          },
        }, 400);
      }
      const error = {
        type: "invalid_request_error",
        code: resolution.code,
        message: resolution.message,
      };
      return c.req.path.endsWith("/messages")
        ? c.json({ type: "error", error }, 400)
        : c.json({ error }, 400);
    }
    await next();
    c.header(GATEWAY_REQUEST_ID_HEADER, resolution.metadata.requestId);
    c.header(GATEWAY_ENGINE_HEADER, GATEWAY_ENGINE_VERSION);
  };
}

function commonApp(
  surface: PointerSurface,
  corsOrigin: string | null = null
) {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", logger());
  if (corsOrigin) {
    app.use(
      "*",
      cors({
        origin: corsOrigin,
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders:
          surface === "combined"
            ? [
                "Content-Type",
                "Authorization",
                "Idempotency-Key",
                "x-request-id",
                "anthropic-version",
                "anthropic-beta",
                "x-api-key",
                "x-goog-api-key",
              ]
            : [
                "Content-Type",
                "Authorization",
                "Idempotency-Key",
                "x-request-id",
              ],
      })
    );
  }
  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      version: buildInfo.version,
      surface,
      build: buildInfo,
      timestamp: new Date().toISOString(),
    })
  );
  app.get("/readyz", async (c) => {
    const result = await readiness(surface);
    return c.json(result.body, result.httpStatus);
  });
  app.get("/.well-known/pointer", (c) => {
    if (surface === "inference") {
      c.header("access-control-allow-origin", "*");
    }
    return c.json({
      contractVersion: POINTER_CAPABILITY_CONTRACT_VERSION,
      deploymentMode: config.mode,
      localAuthAvailable: config.mode === "standalone",
      surface,
      managementContractVersion: config.mode === "managed" ? "platform-v1" : "local-v1",
      inferenceContractVersion: "gateway-v1",
      build: buildInfo,
    });
  });
  return app;
}

function permissionForMethods(read: PointerPermission, write: PointerPermission) {
  return async (c: any, next: () => Promise<void>) => {
    const permission = c.req.method === "GET" || c.req.method === "HEAD" ? read : write;
    return requirePermission(permission)(c, next);
  };
}

function protect(
  app: Hono<AppEnv>,
  path: string,
  read: PointerPermission,
  write: PointerPermission
) {
  app.use(path, authMiddleware);
  app.use(path, permissionForMethods(read, write));
  app.use(path, async (c, next) => {
    await next();
    const principal = c.get("user");
    if (
      principal?.mode === "managed"
      && c.req.method !== "GET"
      && c.req.method !== "HEAD"
      && c.req.method !== "OPTIONS"
    ) {
      await auditManagementAction({
        principal,
        action: `${c.req.method.toLowerCase()}.${c.req.path}`,
        targetType: "management_route",
        outcome: c.res.status < 400 ? "success" : "failure",
        errorCode: c.res.status < 400 ? null : `http_${c.res.status}`,
      }).catch(() => {
        console.error("[audit] Failed to append managed route audit");
      });
    }
  });
}

function mountManagementRoutes(app: Hono<AppEnv>) {
  protect(app, "/api/providers/*", "management.read", "providers.manage");
  protect(app, "/api/provider-accounts/*", "management.read", "providers.manage");
  protect(app, "/api/instances/*", "management.read", "applications.provision");
  protect(app, "/api/keys/*", "management.read", "applications.provision");
  protect(app, "/api/groups/*", "management.read", "groups.manage");
  protect(app, "/api/sources/*", "management.read", "settings.manage");
  protect(app, "/api/catalog/*", "management.read", "settings.manage");
  protect(app, "/api/stats/*", "usage.read", "usage.read");
  protect(app, "/api/admin/*", "settings.manage", "settings.manage");
  protect(app, "/api/test-model/*", "management.read", "test.inference");
  protect(app, "/api/codex-auth/*", "management.read", "providers.manage");

  app.route("/api/auth", authRoutes);
  app.route("/api/providers", providersRoutes);
  app.route("/api/provider-accounts", providerAccountsRoutes);
  app.route("/api/instances", instancesRoutes);
  app.route("/api/keys", keysRoutes);
  app.route("/api/groups", modelGroupsRoutes);
  app.route("/api/sources", sourcesRoutes);
  app.route("/api/catalog", catalogRoutes);
  app.route("/api/stats", statsRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/test-model", testModelRoutes);
  app.route("/api/codex-auth", codexAuthRoutes);
  app.route("/api/platform/v1", platformRoutes);
}

function mountInferenceRoutes(app: Hono<AppEnv>) {
  app.use("/v1/*", gatewayRequestIdMiddleware());
  app.use("/v1beta/*", gatewayRequestIdMiddleware());
  app.route("/v1", modelsRoutes);
  app.route("/v1", proxyRoutes);
  app.route("/v1beta", googleProxyRoutes);
}

export function createStandaloneApp() {
  const app = commonApp("combined", config.standalone.corsOrigin);
  if (process.env.DISABLE_COMPRESSION !== "true") {
    app.use("/api/*", compress());
  }
  mountManagementRoutes(app);
  mountInferenceRoutes(app);
  return app;
}

export function createManagementApp() {
  const app = commonApp("management", config.management?.corsOrigin ?? null);
  if (process.env.DISABLE_COMPRESSION !== "true") {
    app.use("/api/*", compress());
  }
  mountManagementRoutes(app);
  return app;
}

export function createInferenceApp() {
  const app = commonApp("inference");
  mountInferenceRoutes(app);
  return app;
}
