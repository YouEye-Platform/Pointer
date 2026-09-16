import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import * as jose from "jose";
import { nanoid } from "nanoid";
import { config } from "../config";
import { db, schema } from "../db";
import { loadManagedIntegration } from "../services/managed-platform";
import { platformError } from "../services/platform-errors";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

export const POINTER_PERMISSIONS = [
  "management.read",
  "providers.manage",
  "groups.manage",
  "applications.provision",
  "usage.read",
  "settings.manage",
  "test.inference",
] as const;
export type PointerPermission = (typeof POINTER_PERMISSIONS)[number];

export type ManagementPrincipal = {
  ownerUserId: string;
  id: string;
  email: string | null;
  name: string;
  mode: "local" | "managed";
  role: "admin" | "user";
  permissions: string[];
  integrationId?: string;
  // Managed lifecycle requests retain service authority while carrying the
  // exact YouEye actor whose model groups may route an application instance.
  actorUserId?: string;
  actor?: {
    issuer: string;
    subject: string;
    displayName?: string;
  };
  requestId: string;
  assertionJti?: string;
  assertionExpiresAt?: number;
};

// Kept as a compatibility alias while existing domain routes move from user.id
// to the explicit ownerUserId authority.
export type AuthUser = ManagementPrincipal;

export type LocalAuthIdentity = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export async function signJwt(user: LocalAuthIdentity): Promise<string> {
  return new jose.SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export async function verifyJwt(token: string): Promise<ManagementPrincipal | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    });
    const userId = payload.sub;
    if (!userId) return null;
    const [row] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        kind: schema.users.kind,
        state: schema.users.state,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (
      !row
      || row.kind !== "local"
      || row.state !== "active"
      || !row.email
      || (row.role !== "admin" && row.role !== "user")
    ) {
      return null;
    }
    return {
      ownerUserId: row.id,
      id: row.id,
      email: row.email,
      name: row.name,
      mode: "local",
      role: row.role,
      permissions: ["*"],
      requestId: "",
    };
  } catch {
    return null;
  }
}

type PlatformClaims = {
  issuer: string;
  subject: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
  permissions: PointerPermission[];
  pointerAdmin: boolean;
  ownerScope: "service" | "actor";
  actor: {
    issuer: string;
    subject: string;
    displayName?: string;
  };
};

let remoteJwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function platformKeySet() {
  if (!config.platform) throw new Error("Managed platform configuration is unavailable");
  if (!remoteJwks) {
    remoteJwks = jose.createRemoteJWKSet(new URL(config.platform.jwksUrl), {
      cooldownDuration: config.platform.jwksCooldownSeconds * 1000,
      cacheMaxAge: config.platform.jwksCacheSeconds * 1000,
      timeoutDuration: 5_000,
    });
  }
  return remoteJwks;
}

export async function verifyPlatformAssertionWithKeySet(
  token: string,
  keySet: jose.JWTVerifyGetKey
): Promise<PlatformClaims> {
  if (!config.platform) throw new Error("Managed platform configuration is unavailable");
  const platform = config.platform;
  const { payload } = await jose.jwtVerify(token, keySet, {
    issuer: platform.issuer,
    audience: platform.audience,
    algorithms: platform.signingAlgorithms,
    clockTolerance: platform.clockSkewSeconds,
    requiredClaims: ["sub", "iat", "exp", "jti", "act", "pointer_permissions", "pointer_admin"],
  });

  if (
    payload.sub !== platform.subject
    || typeof payload.iat !== "number"
    || typeof payload.exp !== "number"
    || typeof payload.jti !== "string"
    || payload.jti.length < 8
    || payload.jti.length > 200
  ) {
    throw new Error("Platform assertion identity is invalid");
  }
  if (payload.exp <= payload.iat || payload.exp - payload.iat > platform.maxAssertionLifetimeSeconds) {
    throw new Error("Platform assertion lifetime is invalid");
  }
  if (typeof payload.pointer_admin !== "boolean") throw new Error("Platform assertion role is invalid");
  const ownerScope = payload.pointer_owner_scope === "actor" ? "actor" : "service";
  if (payload.pointer_owner_scope !== undefined && payload.pointer_owner_scope !== "actor") {
    throw new Error("Platform assertion owner scope is invalid");
  }
  if (ownerScope === "service" && payload.pointer_admin !== true) {
    throw new Error("Service-scope platform assertions require administrator authority");
  }
  if (
    !Array.isArray(payload.pointer_permissions)
    || payload.pointer_permissions.length === 0
    || payload.pointer_permissions.some(
      (permission) =>
        typeof permission !== "string"
        || !POINTER_PERMISSIONS.includes(permission as PointerPermission)
    )
  ) {
    throw new Error("Platform assertion permissions are invalid");
  }
  const act = payload.act;
  if (
    !act
    || typeof act !== "object"
    || Array.isArray(act)
    || typeof (act as Record<string, unknown>).sub !== "string"
  ) {
    throw new Error("Platform assertion actor is invalid");
  }
  const actorSubject = (act as Record<string, unknown>).sub as string;
  const actorIssuer =
    typeof (act as Record<string, unknown>).iss === "string"
      ? ((act as Record<string, unknown>).iss as string)
      : platform.issuer;
  const displayName =
    typeof (act as Record<string, unknown>).name === "string"
      ? ((act as Record<string, unknown>).name as string)
      : undefined;
  if (
    actorSubject.length < 1
    || actorSubject.length > 300
    || actorIssuer.length < 1
    || actorIssuer.length > 500
    || (displayName && displayName.length > 200)
  ) {
    throw new Error("Platform assertion actor is invalid");
  }

  return {
    issuer: payload.iss!,
    subject: payload.sub,
    jti: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    permissions: [...new Set(payload.pointer_permissions as PointerPermission[])],
    pointerAdmin: payload.pointer_admin,
    ownerScope,
    actor: {
      issuer: actorIssuer,
      subject: actorSubject,
      ...(displayName ? { displayName } : {}),
    },
  };
}

export async function verifyPlatformAssertion(token: string): Promise<PlatformClaims> {
  return verifyPlatformAssertionWithKeySet(token, platformKeySet());
}

function bearerToken(value: string | undefined) {
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

function requestId(c: { get(name: "requestId"): string | undefined }) {
  return c.get("requestId") || `req_${nanoid(16)}`;
}

function isMutation(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function uniqueViolation(error: unknown) {
  const value = `${(error as any)?.code ?? ""} ${(error as any)?.cause?.code ?? ""}`;
  return value.includes("23505");
}

async function markAssertionUsed(integrationId: string, claims: PlatformClaims) {
  const jtiHash = await hashValue(claims.jti);
  await db.insert(schema.platformAssertionReplays).values({
    id: `rpl_${nanoid(16)}`,
    integrationId,
    jtiHash,
    expiresAt: new Date(claims.expiresAt * 1000),
  });
}

async function ensureExternalActor(
  claims: PlatformClaims,
  options: { requireActive: boolean }
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pointer-external:${claims.actor.issuer}:${claims.actor.subject}`}))`);
    const [existing] = await tx.select().from(schema.users).where(and(
      eq(schema.users.externalIssuer, claims.actor.issuer),
      eq(schema.users.externalSubject, claims.actor.subject),
    )).limit(1);
    const role = claims.pointerAdmin ? "admin" : "user";
    const name = claims.actor.displayName ?? "YouEye user";
    let user = existing;
    if (!user) {
      [user] = await tx.insert(schema.users).values({
        id: `ext_${nanoid(16)}`,
        kind: "external",
        email: null,
        name,
        passwordHash: null,
        role,
        externalIssuer: claims.actor.issuer,
        externalSubject: claims.actor.subject,
        state: "active",
      }).returning();
      await tx.insert(schema.modelGroups).values({
        id: `grp_${nanoid(12)}`,
        userId: user.id,
        name: "My models",
        isDefault: true,
        position: 0,
      });
    } else if (user.name !== name || user.role !== role) {
      [user] = await tx.update(schema.users).set({ name, role, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id)).returning();
    }
    if (!user || (options.requireActive && user.state !== "active")) {
      throw new Error("External user is disabled");
    }
    return user;
  });
}

export const platformAuthMiddleware = createMiddleware<{
  Variables: { user: AuthUser; requestId: string };
}>(async (c, next) => {
  if (c.get("user")) {
    await next();
    return;
  }
  const currentRequestId = requestId(c);
  if (config.mode !== "managed" || !config.platform) {
    return platformError(
      c,
      404,
      "managed_mode_required",
      "This platform API is unavailable in standalone mode"
    );
  }

  const token = bearerToken(c.req.header("Authorization"));
  if (!token) {
    return platformError(c, 401, "platform_auth_invalid", "Platform authentication is required");
  }

  try {
    const [claims, integration] = await Promise.all([
      verifyPlatformAssertion(token),
      loadManagedIntegration(),
    ]);
    if (
      !integration
      || integration.ownerKind !== "service"
      || integration.ownerState !== "active"
      || integration.expectedIssuer !== claims.issuer
      || integration.expectedSubject !== claims.subject
      || integration.expectedAudience !== config.platform.audience
    ) {
      return platformError(c, 401, "platform_auth_invalid", "Platform authentication is invalid");
    }

    if (isMutation(c.req.method)) {
      try {
        await markAssertionUsed(integration.id, claims);
      } catch (error) {
        if (uniqueViolation(error)) {
          return platformError(
            c,
            409,
            "platform_assertion_replayed",
            "This mutation assertion has already been used"
          );
        }
        throw error;
      }
    }

    const lifecycleRoute = c.req.path === "/api/platform/v1" || c.req.path.startsWith("/api/platform/v1/");
    if (lifecycleRoute && claims.ownerScope === "actor") {
      return platformError(c, 403, "actor_scope_not_allowed", "Personal assertions cannot call platform lifecycle routes");
    }
    const actorUser = await ensureExternalActor(claims, {
      requireActive: claims.ownerScope === "actor",
    });
    const ownerUserId = claims.ownerScope === "actor"
      ? actorUser.id
      : integration.ownerUserId;
    const principal: ManagementPrincipal = {
      ownerUserId,
      id: ownerUserId,
      email: actorUser?.email ?? null,
      name: actorUser?.name ?? integration.ownerName,
      mode: "managed",
      role: actorUser ? (actorUser.role as "admin" | "user") : "admin",
      permissions: claims.permissions,
      integrationId: integration.id,
      actorUserId: actorUser.id,
      actor: claims.actor,
      requestId: currentRequestId,
      assertionJti: claims.jti,
      assertionExpiresAt: claims.expiresAt,
    };
    c.set("requestId", currentRequestId);
    c.set("user", principal);
    await db
      .update(schema.platformIntegrations)
      .set({ lastAuthenticatedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.platformIntegrations.id, integration.id),
          eq(schema.platformIntegrations.state, "active")
        )
      );
  } catch {
    return platformError(c, 401, "platform_auth_invalid", "Platform authentication is invalid");
  }
  await next();
});

export const authMiddleware = createMiddleware<{
  Variables: { user: AuthUser; requestId: string };
}>(async (c, next) => {
  if (c.get("user")) {
    await next();
    return;
  }
  if (config.mode === "managed") {
    return platformAuthMiddleware(c, next);
  }
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const user = await verifyJwt(token);
  if (!user) return c.json({ error: "Invalid or expired token" }, 401);
  user.requestId = requestId(c);
  c.set("user", user);
  await next();
});

export const adminMiddleware = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return user.mode === "managed"
      ? platformError(c, 403, "permission_denied", "Administrator permission is required")
      : c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

export function requirePermission(permission: PointerPermission) {
  return createMiddleware<{ Variables: { user: AuthUser } }>(async (c, next) => {
    const user = c.get("user");
    if (
      user.mode === "managed"
      && !user.permissions.includes(permission)
      && !user.permissions.includes("*")
    ) {
      return platformError(c, 403, "permission_denied", "The required permission is missing");
    }
    await next();
  });
}

export async function hashValue(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(hash).toString("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
