import { createMiddleware } from "hono/factory";
import { db, schema } from "../db";
import { eq, and, sql } from "drizzle-orm";
import { isTestKey } from "../services/internal-test-keys";

export type ApiKeyContext = {
  apiKey: {
    id: string;
    userId: string;
    instanceId: string;
    allowedModels: string[];
    fallbackProviderId: string | null;
    purpose: string;
    lifecycle: string;
    managedInstallationId: string | null;
    usageSource?: "test";
  };
};

export const apiKeyMiddleware = createMiddleware<{
  Variables: ApiKeyContext;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");
  const xGoogleApiKey = c.req.header("x-goog-api-key");
  const googleRoute = c.req.path === "/v1beta" || c.req.path.startsWith("/v1beta/");

  let key: string | undefined;
  if (googleRoute) {
    const conflicting = [
      authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined,
      xApiKey,
      xGoogleApiKey,
    ].filter((value): value is string => Boolean(value));
    if (new Set(conflicting).size > 1) {
      return apiKeyError(c, 400, "invalid_argument", "Conflicting API key headers");
    }
    key = xGoogleApiKey;
  } else if (authHeader?.startsWith("Bearer ")) {
    key = authHeader.slice(7);
  } else if (xApiKey) {
    key = xApiKey;
  }

  if (!key) {
    return apiKeyError(c, 401, "invalid_api_key", "Missing API key");
  }

  if (!key.startsWith("ptr_")) {
    return apiKeyError(c, 401, "invalid_api_key", "Invalid API key format");
  }

  const keyHash = await hashApiKey(key);
  const [record] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.keyHash, keyHash), eq(schema.apiKeys.revoked, false)))
    .limit(1);

  if (!record) {
    return apiKeyError(c, 401, "invalid_api_key", "Invalid API key");
  }

  const [instance] = await db
    .select({
      id: schema.instances.id,
      state: schema.instances.state,
      origin: schema.instances.origin,
      modelGroupId: schema.instances.modelGroupId,
    })
    .from(schema.instances)
    .where(
      and(
        eq(schema.instances.id, record.instanceId),
        eq(schema.instances.userId, record.userId)
      )
    )
    .limit(1);
  if (!instance) {
    return inferenceError(c, 401, "invalid_api_key", "Invalid API key");
  }
  if (instance.state !== "active") {
    return inferenceError(
      c,
      403,
      instance.state === "archived" ? "installation_archived" : "installation_disabled",
      "This Pointer instance is not active"
    );
  }

  if (record.purpose === "managed_application") {
    const scopes = (record.scopes as string[] | null) ?? [];
    if (!record.managedInstallationId || !scopes.includes("inference")) {
      return inferenceError(
        c,
        403,
        "managed_key_scope_invalid",
        "This managed credential cannot perform inference"
      );
    }
    const [installation] = await db
      .select()
      .from(schema.managedAppInstallations)
      .where(
        and(
          eq(schema.managedAppInstallations.id, record.managedInstallationId),
          eq(schema.managedAppInstallations.instanceId, record.instanceId)
        )
      )
      .limit(1);
    if (!installation) {
      return inferenceError(
        c,
        403,
        "installation_drift",
        "The managed installation is unavailable"
      );
    }
    if (installation.state !== "active" && installation.state !== "rotating") {
      return inferenceError(
        c,
        403,
        installation.state === "archived"
          ? "installation_archived"
          : "installation_disabled",
        "The managed installation is not active"
      );
    }
    const [routingOwner] = await db
      .select({ state: schema.users.state })
      .from(schema.users)
      .where(eq(schema.users.id, installation.routingOwnerUserId))
      .limit(1);
    if (!routingOwner || routingOwner.state !== "active") {
      return inferenceError(
        c,
        403,
        "routing_owner_unavailable",
        "The managed installation owner is unavailable"
      );
    }
    const isActive =
      record.lifecycle === "active"
      && installation.activeApiKeyId === record.id;
    const isPending =
      record.lifecycle === "pending"
      && installation.state === "rotating"
      && installation.pendingApiKeyId === record.id;
    if (!isActive && !isPending) {
      return inferenceError(
        c,
        401,
        "credential_inactive",
        "The managed credential is not active"
      );
    }
    if (instance.origin !== "managed" || !instance.modelGroupId) {
      return inferenceError(
        c,
        403,
        "installation_group_unavailable",
        "The managed installation has no usable model group"
      );
    }
  } else if (record.lifecycle !== "active") {
    return inferenceError(c, 401, "credential_inactive", "Invalid API key");
  }

  c.set("apiKey", {
    id: record.id,
    userId: record.userId,
    instanceId: record.instanceId,
    allowedModels: (record.allowedModels as string[]) || ["*"],
    fallbackProviderId: record.fallbackProviderId,
    purpose: record.purpose,
    lifecycle: record.lifecycle,
    managedInstallationId: record.managedInstallationId,
    usageSource: isTestKey(record.id) ? "test" : undefined,
  });

  db.update(schema.apiKeys)
    .set({ lastUsed: new Date(), requestCount: sql`${schema.apiKeys.requestCount} + 1` })
    .where(eq(schema.apiKeys.id, record.id))
    .execute()
    .catch(() => {});

  await next();
});

function inferenceError(
  c: any,
  status: 401 | 403,
  code: string,
  message: string
) {
  return apiKeyError(c, status, code, message);
}

function apiKeyError(
  c: any,
  status: 400 | 401 | 403,
  code: string,
  message: string,
) {
  if (c.req.path === "/v1beta" || c.req.path.startsWith("/v1beta/")) {
    return c.json(
      {
        error: {
          code: status,
          message,
          status: status === 400
            ? "INVALID_ARGUMENT"
            : status === 401
              ? "UNAUTHENTICATED"
              : "PERMISSION_DENIED",
          details: [{
            "@type": "type.googleapis.com/pointer.gateway.v1.ErrorInfo",
            reason: code,
          }],
        },
      },
      status,
    );
  }
  return c.json(
    {
      error: {
        message,
        type: "pointer_gateway_error",
        code,
      },
    },
    status
  );
}

export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hashBuffer).toString("hex");
}

export function matchesGlob(pattern: string, value: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return regex.test(value);
}

export function isModelAllowed(allowedModels: string[], modelId: string): boolean {
  return allowedModels.some((pattern) => matchesGlob(pattern, modelId));
}
