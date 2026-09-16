import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config";
import { db, schema } from "../db";
import {
  platformAuthMiddleware,
  requirePermission,
  type AuthUser,
} from "../middleware/auth";
import {
  changeActorStateSchema,
  changeManagedActorStateSchema,
  changeInstallationGroupSchema,
  ensureInstallationSchema,
  listManagedGroupsQuerySchema,
  listInstallationsQuerySchema,
  ManagedServiceError,
  takeOverInstallationSchema,
} from "../services/managed-contracts";
import {
  abortRotation,
  acknowledgeDelivery,
  archiveInstallation,
  changeActorState,
  changeManagedActorState,
  changeInstallationGroup,
  commitRotation,
  disableInstallation,
  enableInstallation,
  ensureInstallation,
  installationView,
  listInstallationViews,
  prepareRotation,
  takeOverInstallation,
  validateExternalInstallationId,
  validateIdempotencyKey,
} from "../services/managed-installations";
import { auditManagementAction } from "../services/management-audit";
import { buildInfo } from "../services/build-info";
import { platformError } from "../services/platform-errors";

const app = new Hono<{
  Variables: { user: AuthUser; requestId: string };
}>();

app.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      platformError(
        c,
        413,
        "request_body_too_large",
        "Managed requests must not exceed 65536 bytes"
      ),
  })
);
app.use("*", platformAuthMiddleware);
app.use("*", async (c, next) => {
  await next();
  if (
    c.res.status >= 400
    && c.req.method !== "GET"
    && c.req.method !== "HEAD"
    && c.req.method !== "OPTIONS"
  ) {
    const principal = c.get("user");
    if (principal?.mode === "managed") {
      await auditManagementAction({
        principal,
        action: `${c.req.method.toLowerCase()}.${c.req.path}`,
        targetType: "platform_route",
        targetId: c.req.param("externalInstallationId") || null,
        outcome: "failure",
        errorCode: `http_${c.res.status}`,
      }).catch(() => {
        console.error("[audit] Failed to append managed platform failure audit");
      });
    }
  }
});

function handleError(c: any, error: unknown) {
  if (error instanceof ManagedServiceError) {
    return platformError(
      c,
      error.status,
      error.code,
      error.message,
      error.options
    );
  }
  console.error("[platform] Managed operation failed");
  return platformError(
    c,
    500,
    "managed_operation_failed",
    "The managed operation failed",
    { retryable: true }
  );
}

async function jsonBody(c: any) {
  try {
    return await c.req.json();
  } catch {
    throw new ManagedServiceError(400, "invalid_json", "The request body must be valid JSON");
  }
}

function mutationContext<T>(c: any, body: T) {
  return {
    principal: c.get("user") as AuthUser,
    externalInstallationId: c.req.param("externalInstallationId"),
    idempotencyKey: validateIdempotencyKey(c.req.header("Idempotency-Key")),
    body,
  };
}

app.get("/capabilities", async (c) => {
  return c.json({
    contractVersion: "1",
    deploymentMode: config.mode,
    protocols: {
      inference: [
        "openai-chat-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generate-content",
      ],
      groupSelection: true,
      actorRouting: true,
      routingOwnerTakeover: true,
      actorStateLifecycle: true,
      credentialDelivery: "1",
      keyRotation: "prepare-commit-abort",
    },
    surfaces: {
      listeners: "split-v1",
      readiness: "1",
    },
    build: buildInfo,
  });
});

app.get("/groups", requirePermission("management.read"), async (c) => {
  const principal = c.get("user");
  try {
    const parsed = listManagedGroupsQuerySchema.safeParse({
      owner: c.req.query("owner"),
    });
    if (!parsed.success) {
      return platformError(c, 400, "invalid_request", "The group owner query is invalid");
    }
    const ownerUserId = parsed.data.owner === "actor"
      ? principal.actorUserId
      : principal.ownerUserId;
    if (!ownerUserId) {
      return platformError(c, 403, "actor_identity_required", "An exact YouEye actor is required");
    }
    const groups = await db
      .select()
      .from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, ownerUserId))
      .orderBy(
        asc(schema.modelGroups.position),
        asc(schema.modelGroups.createdAt),
        asc(schema.modelGroups.id)
      );
    const defaults = groups.filter((group) => group.isDefault);
    if (defaults.length !== 1) {
      return platformError(
        c,
        503,
        "managed_configuration_unsafe",
        "The managed owner must have exactly one default group"
      );
    }
    const groupIds = groups.map((group) => group.id);
    const entries = groupIds.length
      ? await db
          .select()
          .from(schema.modelGroupEntries)
          .where(inArray(schema.modelGroupEntries.groupId, groupIds))
      : [];
    const providerIds = [...new Set(entries.map((entry) => entry.providerId))];
    const ownProviders = providerIds.length
      ? await db
          .select({ providerId: schema.providerKeys.providerId })
          .from(schema.providerKeys)
          .where(
            and(
              eq(schema.providerKeys.userId, ownerUserId),
              inArray(schema.providerKeys.providerId, providerIds)
            )
          )
      : [];
    const connectedProviders = new Set(ownProviders.map((row) => row.providerId));
    const linked = groupIds.length
      ? await db
          .select({
            groupId: schema.instances.modelGroupId,
            externalInstallationId:
              schema.managedAppInstallations.externalInstallationId,
          })
          .from(schema.managedAppInstallations)
          .innerJoin(
            schema.instances,
            eq(
              schema.instances.id,
              schema.managedAppInstallations.instanceId
            )
          )
          .where(
            and(
              eq(
                schema.managedAppInstallations.integrationId,
                principal.integrationId!
              ),
              ne(schema.managedAppInstallations.state, "archived"),
              inArray(schema.instances.modelGroupId, groupIds)
            )
          )
      : [];

    return c.json({
      contractVersion: "1",
      items: groups.map((group) => {
        const enabled = entries.filter(
          (entry) => entry.groupId === group.id && entry.enabled
        );
        const unavailable = enabled.filter(
          (entry) => !connectedProviders.has(entry.providerId)
        );
        const applications = linked
          .filter((item) => item.groupId === group.id)
          .map((item) => item.externalInstallationId);
        return {
          id: group.id,
          name: group.name,
          isDefault: group.isDefault,
          enabledModelCount: enabled.length,
          connectedProviderCount: new Set(
            enabled
              .filter((entry) => connectedProviders.has(entry.providerId))
              .map((entry) => entry.providerId)
          ).size,
          unavailableRouteCount: unavailable.length,
          deletionBlocked: group.isDefault || applications.length > 0,
          linkedApplications: applications,
          status:
            enabled.length === 0
              ? "empty"
              : unavailable.length > 0
                ? "degraded"
                : "available",
        };
      }),
    });
  } catch (error) {
    return handleError(c, error);
  }
});

app.get(
  "/installations",
  requirePermission("management.read"),
  async (c) => {
    const parsed = listInstallationsQuerySchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      state: c.req.query("state"),
    });
    if (!parsed.success) {
      return platformError(
        c,
        400,
        "invalid_request",
        "The installation list query is invalid"
      );
    }
    try {
      return c.json(
        await listInstallationViews({
          principal: c.get("user"),
          ...parsed.data,
        })
      );
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.put(
  "/installations/:externalInstallationId",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const parsed = ensureInstallationSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        return platformError(
          c,
          400,
          "invalid_request",
          "The installation request is invalid"
        );
      }
      const result = await ensureInstallation(mutationContext(c, parsed.data));
      return c.json(result.response, result.status as 200 | 201);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.get(
  "/installations/:externalInstallationId",
  requirePermission("management.read"),
  async (c) => {
    try {
      const externalInstallationId = c.req.param("externalInstallationId");
      validateExternalInstallationId(externalInstallationId);
      const principal = c.get("user");
      return c.json(
        await installationView(
          principal.integrationId!,
          externalInstallationId
        )
      );
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.patch(
  "/installations/:externalInstallationId/group",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const parsed = changeInstallationGroupSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        return platformError(
          c,
          400,
          "invalid_request",
          "The group assignment request is invalid"
        );
      }
      const result = await changeInstallationGroup(
        mutationContext(c, parsed.data)
      );
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.post(
  "/installations/:externalInstallationId/routing-owner/takeover",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const parsed = takeOverInstallationSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        return platformError(
          c,
          400,
          "invalid_request",
          "The routing-owner takeover request is invalid"
        );
      }
      const result = await takeOverInstallation(
        mutationContext(c, parsed.data)
      );
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.put(
  "/actors/current/state",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const parsed = changeActorStateSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        return platformError(
          c,
          400,
          "invalid_request",
          "The actor state request is invalid"
        );
      }
      const result = await changeActorState({
        principal: c.get("user"),
        idempotencyKey: validateIdempotencyKey(c.req.header("Idempotency-Key")),
        body: parsed.data,
      });
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.put(
  "/actors/state",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const parsed = changeManagedActorStateSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        return platformError(
          c,
          400,
          "invalid_request",
          "The managed actor state request is invalid"
        );
      }
      const result = await changeManagedActorState({
        principal: c.get("user"),
        idempotencyKey: validateIdempotencyKey(c.req.header("Idempotency-Key")),
        body: parsed.data,
      });
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

for (const [path, operation] of [
  ["disable", disableInstallation],
  ["enable", enableInstallation],
] as const) {
  app.post(
    `/installations/:externalInstallationId/${path}`,
    requirePermission("applications.provision"),
    async (c) => {
      try {
        const result = await operation(mutationContext(c, {}));
        return c.json(result.response);
      } catch (error) {
        return handleError(c, error);
      }
    }
  );
}

app.post(
  "/installations/:externalInstallationId/credential-deliveries/:deliveryId/ack",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const result = await acknowledgeDelivery(
        mutationContext(c, { deliveryId: c.req.param("deliveryId") })
      );
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

app.post(
  "/installations/:externalInstallationId/rotations",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const result = await prepareRotation(mutationContext(c, {}));
      return c.json(result.response, result.status as 200 | 201);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

for (const [path, operation] of [
  ["commit", commitRotation],
  ["abort", abortRotation],
] as const) {
  app.post(
    `/installations/:externalInstallationId/rotations/:rotationId/${path}`,
    requirePermission("applications.provision"),
    async (c) => {
      try {
        const result = await operation({
          ...mutationContext(c, {}),
          rotationId: c.req.param("rotationId"),
        });
        return c.json(result.response);
      } catch (error) {
        return handleError(c, error);
      }
    }
  );
}

app.delete(
  "/installations/:externalInstallationId",
  requirePermission("applications.provision"),
  async (c) => {
    try {
      const result = await archiveInstallation(mutationContext(c, {}));
      return c.json(result.response);
    } catch (error) {
      return handleError(c, error);
    }
  }
);

export default app;
