import {
  and,
  asc,
  eq,
  gt,
  inArray,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { config } from "../config";
import { db, schema } from "../db";
import { hashApiKey } from "../middleware/api-key";
import type { ManagementPrincipal } from "../middleware/auth";
import { decrypt, encrypt } from "./encryption";
import { auditManagementAction } from "./management-audit";
import {
  EXTERNAL_INSTALLATION_ID_PATTERN,
  ManagedServiceError,
  type ensureInstallationSchema,
} from "./managed-contracts";
import { invalidateModelResolutionCache } from "./model-resolution";
import type { z } from "zod";

type EnsureBody = z.infer<typeof ensureInstallationSchema>;

type MutationContext<T> = {
  principal: ManagementPrincipal;
  externalInstallationId: string;
  idempotencyKey: string;
  body: T;
};

type StoredMutationResult = {
  status: number;
  body: Record<string, unknown>;
};

function assertManagedPrincipal(principal: ManagementPrincipal) {
  if (
    principal.mode !== "managed"
    || !principal.integrationId
    || !config.platform
  ) {
    throw new ManagedServiceError(
      403,
      "permission_denied",
      "A managed platform principal is required"
    );
  }
  return {
    integrationId: principal.integrationId,
    serviceOwnerUserId: principal.ownerUserId,
    actorUserId: principal.actorUserId ?? null,
    platform: config.platform,
  };
}

function requestedRoutingOwner(
  managed: ReturnType<typeof assertManagedPrincipal>,
  scope: "service" | "actor"
) {
  if (scope === "service") return managed.serviceOwnerUserId;
  if (!managed.actorUserId) {
    throw new ManagedServiceError(
      403,
      "actor_identity_required",
      "An exact YouEye actor is required for personal application routing"
    );
  }
  return managed.actorUserId;
}

export function validateExternalInstallationId(value: string) {
  if (!EXTERNAL_INSTALLATION_ID_PATTERN.test(value)) {
    throw new ManagedServiceError(
      400,
      "invalid_external_installation_id",
      "The external installation ID has an invalid format"
    );
  }
}

export function validateIdempotencyKey(value: string | undefined) {
  if (
    !value
    || value.length < 8
    || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new ManagedServiceError(
      400,
      "idempotency_key_required",
      "A valid Idempotency-Key header is required"
    );
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Buffer.from(digest).toString("hex");
}

async function mutationIdentity(
  action: string,
  idempotencyKey: string,
  request: unknown
) {
  return {
    action,
    idempotencyKeyHash: await sha256(idempotencyKey),
    requestHash: await sha256(JSON.stringify(canonicalize(request))),
  };
}

async function lockInstallation(
  tx: any,
  integrationId: string,
  externalInstallationId: string
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`managed-installation:${integrationId}:${externalInstallationId}`}))`
  );
}

async function priorMutation(
  tx: any,
  integrationId: string,
  identity: Awaited<ReturnType<typeof mutationIdentity>>
): Promise<StoredMutationResult | null> {
  const [existing] = await tx
    .select()
    .from(schema.platformIdempotency)
    .where(
      and(
        eq(schema.platformIdempotency.integrationId, integrationId),
        eq(schema.platformIdempotency.action, identity.action),
        eq(schema.platformIdempotency.idempotencyKeyHash, identity.idempotencyKeyHash)
      )
    )
    .limit(1);
  if (!existing) return null;
  if (existing.expiresAt.getTime() <= Date.now()) {
    await tx
      .delete(schema.platformIdempotency)
      .where(eq(schema.platformIdempotency.id, existing.id));
    return null;
  }
  if (existing.requestHash !== identity.requestHash) {
    throw new ManagedServiceError(
      409,
      "idempotency_conflict",
      "The idempotency key was already used with a different request"
    );
  }
  return {
    status: existing.resultStatus ?? 200,
    body: (existing.resultBody as Record<string, unknown> | null) ?? {},
  };
}

async function storeMutation(
  tx: any,
  integrationId: string,
  identity: Awaited<ReturnType<typeof mutationIdentity>>,
  status: number,
  body: Record<string, unknown>
) {
  if (!config.platform) throw new Error("Managed platform configuration is unavailable");
  await tx.insert(schema.platformIdempotency).values({
    id: `idem_${nanoid(18)}`,
    integrationId,
    action: identity.action,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestHash: identity.requestHash,
    state: "completed",
    resultStatus: status,
    resultBody: body,
    expiresAt: new Date(Date.now() + config.platform.idempotencyTtlSeconds * 1000),
  });
}

async function ownedGroup(
  tx: any,
  ownerUserId: string,
  groupId: string,
  requireModels = true
) {
  const [group] = await tx
    .select()
    .from(schema.modelGroups)
    .where(
      and(
        eq(schema.modelGroups.id, groupId),
        eq(schema.modelGroups.userId, ownerUserId)
      )
    )
    .limit(1);
  if (!group) {
    throw new ManagedServiceError(404, "group_not_found", "The selected group was not found");
  }
  const [count] = await tx
    .select({
      value: sql<number>`count(*) filter (where ${schema.modelGroupEntries.enabled} = true)::int`,
    })
    .from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, group.id));
  if (requireModels && Number(count?.value ?? 0) === 0) {
    throw new ManagedServiceError(
      409,
      "group_unavailable",
      "The selected group has no enabled model routes"
    );
  }
  return group;
}

async function currentDefaultGroup(tx: any, ownerUserId: string) {
  const [group] = await tx
    .select()
    .from(schema.modelGroups)
    .where(
      and(
        eq(schema.modelGroups.userId, ownerUserId),
        eq(schema.modelGroups.isDefault, true)
      )
    )
    .limit(1);
  if (!group) {
    throw new ManagedServiceError(
      503,
      "managed_configuration_unsafe",
      "The managed owner has no default group",
      { retryable: false }
    );
  }
  return ownedGroup(tx, ownerUserId, group.id);
}

async function installationByExternal(
  tx: any,
  integrationId: string,
  externalInstallationId: string
) {
  const [installation] = await tx
    .select()
    .from(schema.managedAppInstallations)
    .where(
      and(
        eq(schema.managedAppInstallations.integrationId, integrationId),
        eq(
          schema.managedAppInstallations.externalInstallationId,
          externalInstallationId
        )
      )
    )
    .limit(1);
  return installation ?? null;
}

async function createRawKey() {
  const rawKey = `ptr_${nanoid(32)}`;
  return {
    rawKey,
    keyHash: await hashApiKey(rawKey),
    keyPreview: `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`,
  };
}

async function deliveryValue(deliveryId: string | null | undefined, integrationId: string) {
  if (!deliveryId) return null;
  const [delivery] = await db
    .select()
    .from(schema.credentialDeliveries)
    .where(
      and(
        eq(schema.credentialDeliveries.id, deliveryId),
        eq(schema.credentialDeliveries.integrationId, integrationId)
      )
    )
    .limit(1);
  if (
    !delivery
    || delivery.acknowledgedAt
    || delivery.purgedAt
    || !delivery.payloadEncrypted
  ) {
    return null;
  }
  if (delivery.expiresAt.getTime() <= Date.now()) {
    const now = new Date();
    await db
      .update(schema.credentialDeliveries)
      .set({ payloadEncrypted: null, purgedAt: now })
      .where(eq(schema.credentialDeliveries.id, delivery.id));
    return null;
  }
  try {
    return {
      id: delivery.id,
      credential: decrypt(delivery.payloadEncrypted),
      expiresAt: delivery.expiresAt.toISOString(),
      acknowledgementRequired: true,
    };
  } catch {
    throw new ManagedServiceError(
      500,
      "credential_delivery_corrupt",
      "Credential delivery could not be opened"
    );
  }
}

export async function installationView(
  integrationId: string,
  externalInstallationId: string
) {
  const [installation] = await db
    .select()
    .from(schema.managedAppInstallations)
    .where(
      and(
        eq(schema.managedAppInstallations.integrationId, integrationId),
        eq(
          schema.managedAppInstallations.externalInstallationId,
          externalInstallationId
        )
      )
    )
    .limit(1);
  if (!installation) {
    throw new ManagedServiceError(
      404,
      "installation_not_found",
      "The managed application installation was not found"
    );
  }

  const ownerUserId = installation.routingOwnerUserId;
  const [routingOwner] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      kind: schema.users.kind,
      state: schema.users.state,
      externalIssuer: schema.users.externalIssuer,
      externalSubject: schema.users.externalSubject,
    })
    .from(schema.users)
    .where(eq(schema.users.id, ownerUserId))
    .limit(1);

  const [instance] = await db
    .select()
    .from(schema.instances)
    .where(
      and(
        eq(schema.instances.id, installation.instanceId),
        eq(schema.instances.userId, ownerUserId)
      )
    )
    .limit(1);
  const group = instance?.modelGroupId
    ? (
        await db
          .select()
          .from(schema.modelGroups)
          .where(
            and(
              eq(schema.modelGroups.id, instance.modelGroupId),
              eq(schema.modelGroups.userId, ownerUserId)
            )
          )
          .limit(1)
      )[0] ?? null
    : null;
  const activeKey = installation.activeApiKeyId
    ? (
        await db
          .select({
            id: schema.apiKeys.id,
            keyPreview: schema.apiKeys.keyPreview,
            lifecycle: schema.apiKeys.lifecycle,
            revoked: schema.apiKeys.revoked,
            generation: schema.apiKeys.generation,
            lastUsed: schema.apiKeys.lastUsed,
            requestCount: schema.apiKeys.requestCount,
          })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, installation.activeApiKeyId))
          .limit(1)
      )[0] ?? null
    : null;
  const pendingKey = installation.pendingApiKeyId
    ? (
        await db
          .select({
            id: schema.apiKeys.id,
            keyPreview: schema.apiKeys.keyPreview,
            lifecycle: schema.apiKeys.lifecycle,
            revoked: schema.apiKeys.revoked,
            generation: schema.apiKeys.generation,
          })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, installation.pendingApiKeyId))
          .limit(1)
      )[0] ?? null
    : null;
  const activeDelivery = activeKey
    ? (
        await db
          .select({
            id: schema.credentialDeliveries.id,
            expiresAt: schema.credentialDeliveries.expiresAt,
            acknowledgedAt: schema.credentialDeliveries.acknowledgedAt,
            purgedAt: schema.credentialDeliveries.purgedAt,
            hasPayload: sql<boolean>`${schema.credentialDeliveries.payloadEncrypted} is not null`,
          })
          .from(schema.credentialDeliveries)
          .where(eq(schema.credentialDeliveries.apiKeyId, activeKey.id))
          .limit(1)
      )[0] ?? null
    : null;

  const entries = group
    ? await db
        .select({
          providerId: schema.modelGroupEntries.providerId,
          enabled: schema.modelGroupEntries.enabled,
        })
        .from(schema.modelGroupEntries)
        .where(eq(schema.modelGroupEntries.groupId, group.id))
    : [];
  const providerIds = [...new Set(entries.filter((entry) => entry.enabled).map((entry) => entry.providerId))];
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
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const unavailableRouteCount = enabledEntries.filter(
    (entry) => !connectedProviders.has(entry.providerId)
  ).length;

  const driftCodes: string[] = [];
  if (!instance) driftCodes.push("instance_missing");
  if (!routingOwner) driftCodes.push("routing_owner_missing");
  if (routingOwner?.state !== "active" && installation.state !== "archived") {
    driftCodes.push("routing_owner_unavailable");
  }
  if (instance && instance.origin !== "managed") driftCodes.push("instance_origin_mismatch");
  if (!group && installation.state !== "archived") driftCodes.push("group_missing");
  if (!activeKey && installation.state !== "archived") driftCodes.push("active_key_missing");
  if (activeKey?.revoked && installation.state !== "archived") driftCodes.push("active_key_revoked");
  if (installation.state === "rotating" && !pendingKey) driftCodes.push("pending_key_missing");
  if (installation.state === "active" && instance?.state !== "active") {
    driftCodes.push("instance_state_mismatch");
  }
  const deliveryState = !activeDelivery
    ? "not_applicable"
    : activeDelivery.acknowledgedAt
      ? "acknowledged"
      : activeDelivery.expiresAt.getTime() <= Date.now() || !activeDelivery.hasPayload
        ? "expired"
        : "pending_acknowledgement";
  if (deliveryState === "expired") driftCodes.push("credential_delivery_expired");

  return {
    externalInstallationId: installation.externalInstallationId,
    app: {
      id: installation.appId,
      displayName: installation.displayName,
      version: installation.appVersion,
      adapterRevision: installation.adapterRevision,
    },
    pointer: {
      installationId: installation.id,
      instanceId: installation.instanceId,
    },
    routingOwner: routingOwner
      ? {
          id: routingOwner.id,
          displayName: routingOwner.name,
          kind: routingOwner.kind,
          state: routingOwner.state,
          externalIssuer: routingOwner.externalIssuer,
          externalSubject: routingOwner.externalSubject,
        }
      : null,
    state: installation.state,
    selectedGroup: group
      ? {
          id: group.id,
          name: group.name,
          isDefault: group.isDefault,
          modelCount: enabledEntries.length,
          providerCount: new Set(enabledEntries.map((entry) => entry.providerId)).size,
          unavailableRouteCount,
        }
      : installation.historicalGroupId
        ? {
            id: installation.historicalGroupId,
            name: installation.historicalGroupName,
            isDefault: false,
            modelCount: 0,
            providerCount: 0,
            unavailableRouteCount: 0,
            historical: true,
          }
        : null,
    credential: activeKey
      ? {
          id: activeKey.id,
          preview: activeKey.keyPreview,
          lifecycle: activeKey.lifecycle,
          generation: activeKey.generation,
          lastUsed: activeKey.lastUsed?.toISOString() ?? null,
          requestCount: activeKey.requestCount ?? 0,
          revoked: activeKey.revoked ?? false,
          deliveryState,
        }
      : null,
    pendingCredential: pendingKey
      ? {
          id: pendingKey.id,
          preview: pendingKey.keyPreview,
          lifecycle: pendingKey.lifecycle,
          generation: pendingKey.generation,
          revoked: pendingKey.revoked ?? false,
        }
      : null,
    lastReconciledAt: installation.lastReconciledAt?.toISOString() ?? null,
    drift: {
      codes: driftCodes,
      healthy: driftCodes.length === 0 && unavailableRouteCount === 0,
      unavailableRouteCount,
      recoveryActions:
        deliveryState === "expired"
          ? ["rotate_credential"]
          : driftCodes.length
            ? ["reconcile"]
            : [],
    },
    archivedAt: installation.archivedAt?.toISOString() ?? null,
  };
}

export async function listInstallationViews(input: {
  principal: ManagementPrincipal;
  cursor?: string;
  limit: number;
  state?: string;
}) {
  const managed = assertManagedPrincipal(input.principal);
  const conditions = [
    eq(schema.managedAppInstallations.integrationId, managed.integrationId),
  ];
  if (input.cursor) {
    conditions.push(
      gt(schema.managedAppInstallations.externalInstallationId, input.cursor)
    );
  }
  if (input.state) {
    conditions.push(eq(schema.managedAppInstallations.state, input.state));
  }
  const rows = await db
    .select({
      externalInstallationId:
        schema.managedAppInstallations.externalInstallationId,
    })
    .from(schema.managedAppInstallations)
    .where(and(...conditions))
    .orderBy(asc(schema.managedAppInstallations.externalInstallationId))
    .limit(input.limit + 1);
  const selected = rows.slice(0, input.limit);
  return {
    items: await Promise.all(
      selected.map((row) =>
        installationView(
          managed.integrationId,
          row.externalInstallationId
        )
      )
    ),
    nextCursor:
      rows.length > input.limit
        ? selected[selected.length - 1]?.externalInstallationId ?? null
        : null,
  };
}

export async function ensureInstallation(ctx: MutationContext<EnsureBody>) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const routingOwnerUserId = requestedRoutingOwner(
    managed,
    ctx.body.routingOwner
  );
  const action = `ensure:${ctx.externalInstallationId}`;
  const identity = await mutationIdentity(action, ctx.idempotencyKey, {
    externalInstallationId: ctx.externalInstallationId,
    ...ctx.body,
  });
  const keyMaterial = await createRawKey();

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;

    const existing = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (existing) {
      if (existing.state === "archived") {
        throw new ManagedServiceError(
          409,
          "external_installation_id_reused",
          "An archived installation ID cannot be reused"
        );
      }
      const [instance] = await tx
        .select()
        .from(schema.instances)
        .where(eq(schema.instances.id, existing.instanceId))
        .limit(1);
      if (!instance || instance.origin !== "managed") {
        throw new ManagedServiceError(
          409,
          "installation_drift",
          "The managed installation instance is inconsistent"
        );
      }
      if (
        existing.appId !== ctx.body.appId
        || existing.routingOwnerUserId !== routingOwnerUserId
        || instance.userId !== routingOwnerUserId
        || (ctx.body.groupId !== undefined
          && instance?.modelGroupId !== ctx.body.groupId)
      ) {
        throw new ManagedServiceError(
          409,
          "external_installation_id_reused",
          "The external installation ID is already bound to incompatible state"
        );
      }
      await tx
        .update(schema.managedAppInstallations)
        .set({
          displayName: ctx.body.displayName,
          appVersion: ctx.body.appVersion ?? null,
          adapterRevision: ctx.body.adapterRevision ?? null,
          lastReconciliationResult: { status: "matched" },
          lastReconciledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.managedAppInstallations.id, existing.id));
      await tx
        .update(schema.instances)
        .set({
          name: ctx.body.displayName,
          icon: ctx.body.iconUrl ?? instance.icon,
          updatedAt: new Date(),
        })
        .where(eq(schema.instances.id, existing.instanceId));
      const stored = {
        status: 200,
        body: {
          installationId: existing.id,
          externalInstallationId: existing.externalInstallationId,
          created: false,
        },
      };
      await storeMutation(
        tx,
        managed.integrationId,
        identity,
        stored.status,
        stored.body
      );
      return stored;
    }

    const group = ctx.body.groupId
      ? await ownedGroup(tx, routingOwnerUserId, ctx.body.groupId)
      : await currentDefaultGroup(tx, routingOwnerUserId);
    const installationId = `mai_${nanoid(18)}`;
    const instanceId = `inst_${nanoid(12)}`;
    const apiKeyId = `key_${nanoid(18)}`;
    const deliveryId = `del_${nanoid(18)}`;
    const now = new Date();

    await tx.insert(schema.instances).values({
      id: instanceId,
      userId: routingOwnerUserId,
      name: ctx.body.displayName,
      icon: ctx.body.iconUrl ?? "{}",
      color: "#3B82F6",
      modelGroupId: group.id,
      origin: "managed",
      state: "active",
    });
    await tx.insert(schema.managedAppInstallations).values({
      id: installationId,
      integrationId: managed.integrationId,
      externalInstallationId: ctx.externalInstallationId,
      appId: ctx.body.appId,
      displayName: ctx.body.displayName,
      routingOwnerUserId,
      instanceId,
      activeApiKeyId: null,
      pendingApiKeyId: null,
      state: "provisioning",
      appVersion: ctx.body.appVersion ?? null,
      adapterRevision: ctx.body.adapterRevision ?? null,
      lastReconciliationResult: { status: "created" },
      lastReconciledAt: now,
      historicalGroupId: group.id,
      historicalGroupName: group.name,
    });
    await tx.insert(schema.apiKeys).values({
      id: apiKeyId,
      userId: routingOwnerUserId,
      instanceId,
      keyHash: keyMaterial.keyHash,
      keyPreview: keyMaterial.keyPreview,
      name: `${ctx.body.displayName} managed key`,
      allowedModels: ["*"],
      scopes: ["inference"],
      purpose: "managed_application",
      lifecycle: "active",
      managedInstallationId: installationId,
      generation: 1,
      revoked: false,
    });
    await tx.insert(schema.credentialDeliveries).values({
      id: deliveryId,
      integrationId: managed.integrationId,
      installationId,
      apiKeyId,
      mutationKeyHash: identity.idempotencyKeyHash,
      payloadEncrypted: encrypt(keyMaterial.rawKey),
      expiresAt: new Date(
        now.getTime() + managed.platform.credentialDeliveryTtlSeconds * 1000
      ),
    });
    await tx
      .update(schema.managedAppInstallations)
      .set({
        activeApiKeyId: apiKeyId,
        state: "active",
        updatedAt: now,
      })
      .where(eq(schema.managedAppInstallations.id, installationId));

    const stored = {
      status: 201,
      body: {
        installationId,
        externalInstallationId: ctx.externalInstallationId,
        deliveryId,
        created: true,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  const resultBody = result.body as Record<string, unknown>;
  const deliveryId =
    typeof resultBody.deliveryId === "string" ? resultBody.deliveryId : null;
  const response = {
    installation: await installationView(
      managed.integrationId,
      ctx.externalInstallationId
    ),
    credentialDelivery: await deliveryValue(deliveryId, managed.integrationId),
  };
  await auditManagementAction({
    principal: ctx.principal,
    action: "installation.ensure",
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    outcome: "success",
    newState: { created: resultBody.created === true },
  });
  return { status: result.status, response };
}

export async function acknowledgeDelivery(
  ctx: MutationContext<{ deliveryId: string }>
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const identity = await mutationIdentity(
    `delivery-ack:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    ctx.body
  );

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    const [delivery] = await tx
      .select()
      .from(schema.credentialDeliveries)
      .where(
        and(
          eq(schema.credentialDeliveries.id, ctx.body.deliveryId),
          eq(schema.credentialDeliveries.integrationId, managed.integrationId),
          eq(schema.credentialDeliveries.installationId, installation.id)
        )
      )
      .limit(1);
    if (!delivery) {
      throw new ManagedServiceError(
        404,
        "credential_delivery_not_found",
        "The credential delivery was not found"
      );
    }
    if (!delivery.acknowledgedAt && delivery.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(schema.credentialDeliveries)
        .set({ payloadEncrypted: null, purgedAt: new Date() })
        .where(eq(schema.credentialDeliveries.id, delivery.id));
      throw new ManagedServiceError(
        410,
        "credential_delivery_expired",
        "The credential delivery has expired"
      );
    }
    const now = new Date();
    if (!delivery.acknowledgedAt) {
      await tx
        .update(schema.credentialDeliveries)
        .set({
          payloadEncrypted: null,
          acknowledgedAt: now,
          purgedAt: now,
        })
        .where(eq(schema.credentialDeliveries.id, delivery.id));
    }
    const stored = {
      status: 200,
      body: {
        installationId: installation.id,
        deliveryId: delivery.id,
        acknowledged: true,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  await auditManagementAction({
    principal: ctx.principal,
    action: "credential.acknowledge",
    targetType: "credential_delivery",
    targetId: ctx.body.deliveryId,
    outcome: "success",
    newState: { acknowledged: true },
  });
  return { status: result.status, response: result.body };
}

export async function changeInstallationGroup(
  ctx: MutationContext<{ groupId: string }>
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const identity = await mutationIdentity(
    `group-change:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    ctx.body
  );
  let oldGroupId: string | null = null;

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    if (installation.state === "archived") {
      throw new ManagedServiceError(
        409,
        "installation_archived",
        "An archived installation cannot change groups"
      );
    }
    if (
      installation.routingOwnerUserId !== managed.serviceOwnerUserId
      && installation.routingOwnerUserId !== managed.actorUserId
    ) {
      throw new ManagedServiceError(
        409,
        "routing_owner_mismatch",
        "Take over this application's AI connection before choosing one of your groups"
      );
    }
    const group = await ownedGroup(
      tx,
      installation.routingOwnerUserId,
      ctx.body.groupId
    );
    const [instance] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, installation.instanceId))
      .limit(1);
    if (!instance) {
      throw new ManagedServiceError(
        409,
        "installation_drift",
        "The managed installation instance is missing"
      );
    }
    oldGroupId = instance.modelGroupId;
    await tx
      .update(schema.instances)
      .set({ modelGroupId: group.id, updatedAt: new Date() })
      .where(eq(schema.instances.id, instance.id));
    await tx
      .update(schema.managedAppInstallations)
      .set({
        historicalGroupId: group.id,
        historicalGroupName: group.name,
        lastReconciliationResult: { status: "group_changed" },
        lastReconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.managedAppInstallations.id, installation.id));
    const stored = {
      status: 200,
      body: {
        installationId: installation.id,
        instanceId: instance.id,
        groupId: group.id,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  const instanceId =
    typeof result.body.instanceId === "string" ? result.body.instanceId : undefined;
  invalidateModelResolutionCache(instanceId);
  await auditManagementAction({
    principal: ctx.principal,
    action: "installation.group.change",
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    oldState: { groupId: oldGroupId },
    newState: { groupId: ctx.body.groupId },
    outcome: "success",
  });
  return {
    status: result.status,
    response: await installationView(
      managed.integrationId,
      ctx.externalInstallationId
    ),
  };
}

export async function takeOverInstallation(
  ctx: MutationContext<{ groupId: string }>
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  if (!managed.actorUserId) {
    throw new ManagedServiceError(
      403,
      "actor_identity_required",
      "An exact administrator identity is required to take over AI routing"
    );
  }
  if (ctx.principal.role !== "admin") {
    throw new ManagedServiceError(
      403,
      "administrator_required",
      "Only a YouEye administrator can take over AI routing"
    );
  }
  const actorUserId = managed.actorUserId;
  const identity = await mutationIdentity(
    `routing-owner-takeover:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    ctx.body
  );
  let oldOwnerUserId: string | null = null;
  let instanceId: string | undefined;

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    if (installation.state === "archived") {
      throw new ManagedServiceError(
        409,
        "installation_archived",
        "An archived installation cannot be taken over"
      );
    }
    if (installation.state === "rotating") {
      throw new ManagedServiceError(
        409,
        "rotation_state_conflict",
        "Finish or abort the active credential rotation first"
      );
    }
    const group = await ownedGroup(tx, actorUserId, ctx.body.groupId);
    const [instance] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, installation.instanceId))
      .limit(1);
    if (!instance || instance.origin !== "managed") {
      throw new ManagedServiceError(
        409,
        "installation_drift",
        "The managed installation instance is inconsistent"
      );
    }

    oldOwnerUserId = installation.routingOwnerUserId;
    instanceId = instance.id;
    const ownerUnavailable =
      (installation.lastReconciliationResult as { status?: string } | null)?.status
      === "owner_unavailable";
    const nextState = ownerUnavailable ? "active" : installation.state;
    const now = new Date();
    await tx
      .update(schema.apiKeys)
      .set({ userId: actorUserId })
      .where(
        and(
          eq(schema.apiKeys.managedInstallationId, installation.id),
          eq(schema.apiKeys.revoked, false)
        )
      );
    await tx
      .update(schema.instances)
      .set({
        userId: actorUserId,
        modelGroupId: group.id,
        state: nextState === "active" ? "active" : "disabled",
        updatedAt: now,
      })
      .where(eq(schema.instances.id, instance.id));
    await tx
      .update(schema.managedAppInstallations)
      .set({
        routingOwnerUserId: actorUserId,
        state: nextState,
        historicalGroupId: group.id,
        historicalGroupName: group.name,
        lastReconciliationResult: {
          status: "routing_owner_taken_over",
          previousOwnerUserId: oldOwnerUserId,
        },
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(schema.managedAppInstallations.id, installation.id));
    const stored = {
      status: 200,
      body: {
        installationId: installation.id,
        instanceId: instance.id,
        routingOwnerUserId: actorUserId,
        groupId: group.id,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  invalidateModelResolutionCache(instanceId);
  await auditManagementAction({
    principal: ctx.principal,
    action: "installation.routing-owner.takeover",
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    oldState: { routingOwnerUserId: oldOwnerUserId },
    newState: {
      routingOwnerUserId: actorUserId,
      groupId: ctx.body.groupId,
    },
    outcome: "success",
  });
  return {
    status: result.status,
    response: await installationView(
      managed.integrationId,
      ctx.externalInstallationId
    ),
  };
}

export async function changeActorState(ctx: {
  principal: ManagementPrincipal;
  idempotencyKey: string;
  body: { state: "active" | "disabled" };
}) {
  const managed = assertManagedPrincipal(ctx.principal);
  if (!managed.actorUserId) {
    throw new ManagedServiceError(
      403,
      "actor_identity_required",
      "An exact YouEye actor is required"
    );
  }
  return changeActorStateForUser(ctx, managed.actorUserId);
}

export async function changeManagedActorState(ctx: {
  principal: ManagementPrincipal;
  idempotencyKey: string;
  body: { actorSubject: string; state: "active" | "disabled" };
}) {
  const managed = assertManagedPrincipal(ctx.principal);
  if (ctx.principal.role !== "admin") {
    throw new ManagedServiceError(
      403,
      "administrator_required",
      "Only a YouEye administrator can change another actor's lifecycle state"
    );
  }
  const actorIssuer = ctx.principal.actor?.issuer;
  if (!actorIssuer) {
    throw new ManagedServiceError(
      403,
      "actor_issuer_required",
      "The YouEye identity issuer is required"
    );
  }
  const [actor] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.externalIssuer, actorIssuer),
      eq(schema.users.externalSubject, ctx.body.actorSubject)
    ))
    .limit(1);
  if (!actor) {
    return {
      status: 200,
      response: {
        actorUserId: null,
        state: ctx.body.state,
        affectedInstallations: 0,
        attentionRequired: false,
        absent: true,
      },
    };
  }
  return changeActorStateForUser(
    { ...ctx, body: { state: ctx.body.state } },
    actor.id
  );
}

async function changeActorStateForUser(ctx: {
  principal: ManagementPrincipal;
  idempotencyKey: string;
  body: { state: "active" | "disabled" };
}, actorUserId: string) {
  const managed = assertManagedPrincipal(ctx.principal);
  const identity = await mutationIdentity(
    `actor-state:${actorUserId}`,
    ctx.idempotencyKey,
    ctx.body
  );

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`managed-actor:${managed.integrationId}:${actorUserId}`}))`
    );
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const [actor] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, actorUserId))
      .limit(1);
    if (!actor || actor.kind !== "external") {
      throw new ManagedServiceError(
        404,
        "actor_not_found",
        "The managed actor was not found"
      );
    }
    const now = new Date();
    await tx
      .update(schema.users)
      .set({ state: ctx.body.state, updatedAt: now })
      .where(eq(schema.users.id, actor.id));

    const installations = await tx
      .select({
        id: schema.managedAppInstallations.id,
        instanceId: schema.managedAppInstallations.instanceId,
      })
      .from(schema.managedAppInstallations)
      .where(
        and(
          eq(schema.managedAppInstallations.integrationId, managed.integrationId),
          eq(schema.managedAppInstallations.routingOwnerUserId, actor.id),
          sql`${schema.managedAppInstallations.state} <> 'archived'`
        )
      );
    if (ctx.body.state === "disabled" && installations.length > 0) {
      const installationIds = installations.map((item) => item.id);
      const instanceIds = installations.map((item) => item.instanceId);
      const preparedRotations = await tx
        .select({
          id: schema.managedKeyRotations.id,
          pendingKeyId: schema.managedKeyRotations.pendingKeyId,
          deliveryId: schema.managedKeyRotations.deliveryId,
        })
        .from(schema.managedKeyRotations)
        .where(
          and(
            inArray(schema.managedKeyRotations.installationId, installationIds),
            eq(schema.managedKeyRotations.state, "prepared")
          )
        );
      if (preparedRotations.length > 0) {
        await tx
          .update(schema.apiKeys)
          .set({ lifecycle: "retired", revoked: true, revokedAt: now })
          .where(
            inArray(
              schema.apiKeys.id,
              preparedRotations.map((rotation) => rotation.pendingKeyId)
            )
          );
        await tx
          .update(schema.credentialDeliveries)
          .set({ payloadEncrypted: null, purgedAt: now })
          .where(
            inArray(
              schema.credentialDeliveries.id,
              preparedRotations.map((rotation) => rotation.deliveryId)
            )
          );
        await tx
          .update(schema.managedKeyRotations)
          .set({ state: "aborted", abortedAt: now })
          .where(
            inArray(
              schema.managedKeyRotations.id,
              preparedRotations.map((rotation) => rotation.id)
            )
          );
      }
      await tx
        .update(schema.instances)
        .set({ state: "disabled", updatedAt: now })
        .where(inArray(schema.instances.id, instanceIds));
      await tx
        .update(schema.managedAppInstallations)
        .set({
          state: "disabled",
          pendingApiKeyId: null,
          lastReconciliationResult: { status: "owner_unavailable" },
          lastReconciledAt: now,
          updatedAt: now,
        })
        .where(inArray(schema.managedAppInstallations.id, installationIds));
    }

    const stored = {
      status: 200,
      body: {
        actorUserId: actor.id,
        state: ctx.body.state,
        affectedInstallations: installations.length,
        attentionRequired:
          ctx.body.state === "active" && installations.length > 0,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  invalidateModelResolutionCache();
  await auditManagementAction({
    principal: ctx.principal,
    action: `actor.${ctx.body.state}`,
    targetType: "managed_actor",
    targetId: actorUserId,
    outcome: "success",
    newState: { state: ctx.body.state },
  });
  return { status: result.status, response: result.body };
}

async function setInstallationEnabled(
  ctx: MutationContext<Record<string, never>>,
  enabled: boolean
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const operation = enabled ? "enable" : "disable";
  const identity = await mutationIdentity(
    `${operation}:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    {}
  );

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    if (installation.state === "archived") {
      throw new ManagedServiceError(
        409,
        "installation_archived",
        "An archived installation cannot be enabled or disabled"
      );
    }
    if (installation.state === "rotating") {
      throw new ManagedServiceError(
        409,
        "rotation_state_conflict",
        "Finish or abort the active rotation first"
      );
    }
    if (enabled) {
      const [routingOwner] = await tx
        .select({ state: schema.users.state })
        .from(schema.users)
        .where(eq(schema.users.id, installation.routingOwnerUserId))
        .limit(1);
      if (!routingOwner || routingOwner.state !== "active") {
        throw new ManagedServiceError(
          409,
          "routing_owner_unavailable",
          "Take over the AI connection or restore its owner before enabling it"
        );
      }
    }
    const state = enabled ? "active" : "disabled";
    await tx
      .update(schema.managedAppInstallations)
      .set({ state, updatedAt: new Date() })
      .where(eq(schema.managedAppInstallations.id, installation.id));
    await tx
      .update(schema.instances)
      .set({ state, updatedAt: new Date() })
      .where(eq(schema.instances.id, installation.instanceId));
    const stored = {
      status: 200,
      body: { installationId: installation.id, state },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  await auditManagementAction({
    principal: ctx.principal,
    action: `installation.${operation}`,
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    outcome: "success",
    newState: { state: enabled ? "active" : "disabled" },
  });
  return {
    status: result.status,
    response: await installationView(
      managed.integrationId,
      ctx.externalInstallationId
    ),
  };
}

export function enableInstallation(ctx: MutationContext<Record<string, never>>) {
  return setInstallationEnabled(ctx, true);
}

export function disableInstallation(ctx: MutationContext<Record<string, never>>) {
  return setInstallationEnabled(ctx, false);
}

export async function prepareRotation(ctx: MutationContext<Record<string, never>>) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const identity = await mutationIdentity(
    `rotation-prepare:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    {}
  );
  const keyMaterial = await createRawKey();

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    if (installation.state !== "active" || !installation.activeApiKeyId) {
      const code =
        installation.state === "archived"
          ? "installation_archived"
          : installation.state === "disabled"
            ? "installation_disabled"
            : "rotation_state_conflict";
      throw new ManagedServiceError(
        409,
        code,
        "The installation is not in a rotatable state"
      );
    }
    const [oldKey] = await tx
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, installation.activeApiKeyId))
      .limit(1);
    if (!oldKey || oldKey.revoked || oldKey.lifecycle !== "active") {
      throw new ManagedServiceError(
        409,
        "installation_drift",
        "The installation active credential is inconsistent"
      );
    }
    const pendingKeyId = `key_${nanoid(18)}`;
    const deliveryId = `del_${nanoid(18)}`;
    const rotationId = `rot_${nanoid(18)}`;
    const now = new Date();
    await tx.insert(schema.apiKeys).values({
      id: pendingKeyId,
      userId: installation.routingOwnerUserId,
      instanceId: installation.instanceId,
      keyHash: keyMaterial.keyHash,
      keyPreview: keyMaterial.keyPreview,
      name: `${installation.displayName} managed key`,
      allowedModels: ["*"],
      scopes: ["inference"],
      purpose: "managed_application",
      lifecycle: "pending",
      managedInstallationId: installation.id,
      generation: oldKey.generation + 1,
      replacementOfKeyId: oldKey.id,
      revoked: false,
    });
    await tx.insert(schema.credentialDeliveries).values({
      id: deliveryId,
      integrationId: managed.integrationId,
      installationId: installation.id,
      apiKeyId: pendingKeyId,
      mutationKeyHash: identity.idempotencyKeyHash,
      payloadEncrypted: encrypt(keyMaterial.rawKey),
      expiresAt: new Date(
        now.getTime() + managed.platform.credentialDeliveryTtlSeconds * 1000
      ),
    });
    await tx.insert(schema.managedKeyRotations).values({
      id: rotationId,
      installationId: installation.id,
      previousKeyId: oldKey.id,
      pendingKeyId,
      deliveryId,
      state: "prepared",
    });
    await tx
      .update(schema.managedAppInstallations)
      .set({
        pendingApiKeyId: pendingKeyId,
        state: "rotating",
        updatedAt: now,
      })
      .where(eq(schema.managedAppInstallations.id, installation.id));
    const stored = {
      status: 201,
      body: {
        installationId: installation.id,
        rotationId,
        deliveryId,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  const deliveryId =
    typeof result.body.deliveryId === "string" ? result.body.deliveryId : null;
  await auditManagementAction({
    principal: ctx.principal,
    action: "credential.rotation.prepare",
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    outcome: "success",
    newState: { state: "rotating" },
  });
  return {
    status: result.status,
    response: {
      rotationId: result.body.rotationId,
      installation: await installationView(
        managed.integrationId,
        ctx.externalInstallationId
      ),
      credentialDelivery: await deliveryValue(deliveryId, managed.integrationId),
    },
  };
}

async function finishRotation(
  ctx: MutationContext<Record<string, never>> & { rotationId: string },
  commit: boolean
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const operation = commit ? "commit" : "abort";
  const identity = await mutationIdentity(
    `rotation-${operation}:${ctx.externalInstallationId}:${ctx.rotationId}`,
    ctx.idempotencyKey,
    {}
  );

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    const [rotation] = await tx
      .select()
      .from(schema.managedKeyRotations)
      .where(
        and(
          eq(schema.managedKeyRotations.id, ctx.rotationId),
          eq(schema.managedKeyRotations.installationId, installation.id)
        )
      )
      .limit(1);
    if (!rotation) {
      throw new ManagedServiceError(
        404,
        "rotation_not_found",
        "The credential rotation was not found"
      );
    }
    if (rotation.state !== "prepared") {
      const expected = commit ? "committed" : "aborted";
      if (rotation.state !== expected) {
        throw new ManagedServiceError(
          409,
          "rotation_state_conflict",
          "The rotation is already in an incompatible terminal state"
        );
      }
    } else if (commit) {
      const [delivery] = await tx
        .select()
        .from(schema.credentialDeliveries)
        .where(eq(schema.credentialDeliveries.id, rotation.deliveryId))
        .limit(1);
      if (!delivery?.acknowledgedAt) {
        throw new ManagedServiceError(
          409,
          "credential_delivery_not_acknowledged",
          "Acknowledge protected credential installation before committing rotation"
        );
      }
      const now = new Date();
      await tx
        .update(schema.apiKeys)
        .set({ lifecycle: "retired", revoked: true, revokedAt: now })
        .where(eq(schema.apiKeys.id, rotation.previousKeyId));
      await tx
        .update(schema.apiKeys)
        .set({ lifecycle: "active" })
        .where(eq(schema.apiKeys.id, rotation.pendingKeyId));
      await tx
        .update(schema.managedKeyRotations)
        .set({ state: "committed", committedAt: now })
        .where(eq(schema.managedKeyRotations.id, rotation.id));
      await tx
        .update(schema.managedAppInstallations)
        .set({
          activeApiKeyId: rotation.pendingKeyId,
          pendingApiKeyId: null,
          state: "active",
          updatedAt: now,
        })
        .where(eq(schema.managedAppInstallations.id, installation.id));
    } else {
      const now = new Date();
      await tx
        .update(schema.apiKeys)
        .set({ lifecycle: "retired", revoked: true, revokedAt: now })
        .where(eq(schema.apiKeys.id, rotation.pendingKeyId));
      await tx
        .update(schema.credentialDeliveries)
        .set({ payloadEncrypted: null, purgedAt: now })
        .where(eq(schema.credentialDeliveries.id, rotation.deliveryId));
      await tx
        .update(schema.managedKeyRotations)
        .set({ state: "aborted", abortedAt: now })
        .where(eq(schema.managedKeyRotations.id, rotation.id));
      await tx
        .update(schema.managedAppInstallations)
        .set({
          pendingApiKeyId: null,
          state: "active",
          updatedAt: now,
        })
        .where(eq(schema.managedAppInstallations.id, installation.id));
    }
    const stored = {
      status: 200,
      body: {
        installationId: installation.id,
        rotationId: rotation.id,
        state: commit ? "committed" : "aborted",
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  await auditManagementAction({
    principal: ctx.principal,
    action: `credential.rotation.${operation}`,
    targetType: "credential_rotation",
    targetId: ctx.rotationId,
    outcome: "success",
    newState: { state: commit ? "committed" : "aborted" },
  });
  return {
    status: result.status,
    response: {
      rotationId: ctx.rotationId,
      installation: await installationView(
        managed.integrationId,
        ctx.externalInstallationId
      ),
    },
  };
}

export function commitRotation(
  ctx: MutationContext<Record<string, never>> & { rotationId: string }
) {
  return finishRotation(ctx, true);
}

export function abortRotation(
  ctx: MutationContext<Record<string, never>> & { rotationId: string }
) {
  return finishRotation(ctx, false);
}

export async function archiveInstallation(
  ctx: MutationContext<Record<string, never>>
) {
  validateExternalInstallationId(ctx.externalInstallationId);
  const managed = assertManagedPrincipal(ctx.principal);
  const identity = await mutationIdentity(
    `archive:${ctx.externalInstallationId}`,
    ctx.idempotencyKey,
    {}
  );

  const result = await db.transaction(async (tx) => {
    await lockInstallation(tx, managed.integrationId, ctx.externalInstallationId);
    const prior = await priorMutation(tx, managed.integrationId, identity);
    if (prior) return prior;
    const installation = await installationByExternal(
      tx,
      managed.integrationId,
      ctx.externalInstallationId
    );
    if (!installation) {
      throw new ManagedServiceError(
        404,
        "installation_not_found",
        "The managed application installation was not found"
      );
    }
    const now = new Date();
    if (installation.state !== "archived") {
      const [instance] = await tx
        .select()
        .from(schema.instances)
        .where(eq(schema.instances.id, installation.instanceId))
        .limit(1);
      let historicalGroupId = installation.historicalGroupId;
      let historicalGroupName = installation.historicalGroupName;
      if (instance?.modelGroupId) {
        const [group] = await tx
          .select()
          .from(schema.modelGroups)
          .where(eq(schema.modelGroups.id, instance.modelGroupId))
          .limit(1);
        historicalGroupId = group?.id ?? historicalGroupId;
        historicalGroupName = group?.name ?? historicalGroupName;
      }
      await tx
        .update(schema.apiKeys)
        .set({ lifecycle: "retired", revoked: true, revokedAt: now })
        .where(eq(schema.apiKeys.managedInstallationId, installation.id));
      await tx
        .update(schema.credentialDeliveries)
        .set({ payloadEncrypted: null, purgedAt: now })
        .where(eq(schema.credentialDeliveries.installationId, installation.id));
      await tx
        .update(schema.managedKeyRotations)
        .set({ state: "aborted", abortedAt: now })
        .where(
          and(
            eq(schema.managedKeyRotations.installationId, installation.id),
            eq(schema.managedKeyRotations.state, "prepared")
          )
        );
      await tx
        .update(schema.instances)
        .set({
          state: "archived",
          modelGroupId: null,
          archivedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.instances.id, installation.instanceId));
      await tx
        .update(schema.managedAppInstallations)
        .set({
          state: "archived",
          pendingApiKeyId: null,
          historicalGroupId,
          historicalGroupName,
          archivedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.managedAppInstallations.id, installation.id));
    }
    const stored = {
      status: 200,
      body: {
        installationId: installation.id,
        externalInstallationId: installation.externalInstallationId,
        archived: true,
        credentialsRevoked: true,
      },
    };
    await storeMutation(
      tx,
      managed.integrationId,
      identity,
      stored.status,
      stored.body
    );
    return stored;
  });

  invalidateModelResolutionCache();
  await auditManagementAction({
    principal: ctx.principal,
    action: "installation.archive",
    targetType: "managed_installation",
    targetId: ctx.externalInstallationId,
    outcome: "success",
    newState: { state: "archived" },
  });
  return { status: result.status, response: result.body };
}
