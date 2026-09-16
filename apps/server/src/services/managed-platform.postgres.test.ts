import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db";

const enabled = process.env.MANAGED_POSTGRES_TEST === "1";
const expectedDatabase = process.env.MANAGED_POSTGRES_TEST_DATABASE;
const databaseUrl = process.env.DATABASE_URL;
const jwksPort = 43991;
const issuer = "https://youeye.test";
const audience = "pointer-management-test";
const subject = "youeye-server-test";
const integrationId = "youeye-managed-postgres-test";
const externalInstallationId = "managed-test-installation";
const secondExternalInstallationId = "managed-test-concurrent";
let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let activeKid = "managed-test-key";
let jwksAvailable = true;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let management: any;
let inference: any;
let serviceUserId = "";
let defaultGroupId = "";
let secondGroupId = "";
let activeKey = "";
let replacementKey = "";
let secondActiveKey = "";
let newDefaultKey = "";

function assertSafeDatabase() {
  if (!databaseUrl || !expectedDatabase) {
    throw new Error(
      "Managed PostgreSQL tests require DATABASE_URL and MANAGED_POSTGRES_TEST_DATABASE"
    );
  }
  const actual = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (
    actual !== expectedDatabase
    || !/(?:^|[_-])test(?:$|[_-])/i.test(actual)
  ) {
    throw new Error(`Refusing managed tests against database ${actual || "<unknown>"}`);
  }
}

type AssertionOptions = {
  aud?: string;
  iss?: string | null;
  sub?: string | null;
  jti?: string | null;
  iat?: number;
  exp?: number;
  nbf?: number;
  actor?: unknown;
  permissions?: unknown;
  admin?: unknown;
  ownerScope?: unknown;
};

async function assertion(options: AssertionOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  const selectedAudience =
    typeof options.aud === "string" ? options.aud : audience;
  const payload: Record<string, unknown> = {
    pointer_admin: options.admin === undefined ? true : options.admin,
    ...(options.ownerScope === undefined ? {} : { pointer_owner_scope: options.ownerScope }),
    pointer_permissions: options.permissions === undefined ? [
      "management.read",
      "providers.manage",
      "groups.manage",
      "applications.provision",
      "usage.read",
      "settings.manage",
      "test.inference",
    ] : options.permissions,
  };
  if (options.actor !== null) {
    payload.act =
      options.actor
      ?? { sub: "admin-stable-subject", iss: issuer, name: "Test administrator" };
  }
  let signer = new SignJWT(payload).setProtectedHeader({
    alg: "RS256",
    kid: activeKid,
  });
  if (options.iss !== null) signer = signer.setIssuer(options.iss ?? issuer);
  signer = signer.setAudience(selectedAudience);
  if (options.sub !== null) signer = signer.setSubject(options.sub ?? subject);
  if (options.jti !== null) {
    signer = signer.setJti(options.jti ?? `jti_${crypto.randomUUID()}`);
  }
  signer = signer
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 120);
  if (options.nbf !== undefined) signer = signer.setNotBefore(options.nbf);
  return signer.sign(privateKey);
}

async function request(
  path: string,
  init: RequestInit = {},
  token?: string
) {
  const auth = token ?? (await assertion());
  return management.request(`http://management.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function idempotency(value: string) {
  return { "Idempotency-Key": value };
}

describe.skipIf(!enabled)("managed platform PostgreSQL lifecycle", () => {
  beforeAll(async () => {
    assertSafeDatabase();
    process.env.JWT_SECRET ||= "managed-jwt-test-secret";
    process.env.ENCRYPTION_SECRET ||= "managed-encryption-test-secret";
    process.env.CORS_ORIGIN ||= "http://standalone.test";
    process.env.POINTER_DEPLOYMENT_MODE = "managed";
    process.env.MANAGEMENT_BIND = "127.0.0.1";
    process.env.MANAGEMENT_PORT = "44001";
    process.env.INFERENCE_BIND = "127.0.0.1";
    process.env.INFERENCE_PORT = "44002";
    process.env.PLATFORM_ISSUER = issuer;
    process.env.PLATFORM_AUDIENCE = audience;
    process.env.PLATFORM_SUBJECT = subject;
    process.env.PLATFORM_INTEGRATION_ID = integrationId;
    process.env.PLATFORM_JWKS_URL = `http://127.0.0.1:${jwksPort}/jwks`;
    process.env.PLATFORM_SIGNING_ALGORITHMS = "RS256";
    process.env.PLATFORM_JWKS_COOLDOWN_SECONDS = "1";
    process.env.PLATFORM_JWKS_CACHE_SECONDS = "1";
    process.env.CREDENTIAL_DELIVERY_TTL_SECONDS = "300";

    await db.execute(sql`truncate table users cascade`);

    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    jwksServer = Bun.serve({
      hostname: "127.0.0.1",
      port: jwksPort,
      fetch() {
        if (!jwksAvailable) {
          return Response.json({ error: "unavailable" }, { status: 503 });
        }
        return Response.json({
          keys: [{ ...publicJwk, kid: activeKid, alg: "RS256", use: "sig" }],
        });
      },
    });

    const [{ ensureManagedIntegration }, appModule, registryModule] =
      await Promise.all([
        import("./managed-platform"),
        import("../app"),
        import("../providers/registry"),
      ]);
    await registryModule.registry.initialize();
    const integration = await ensureManagedIntegration();
    if (!integration) throw new Error("Managed integration was not created");
    serviceUserId = integration.ownerUserId;
    management = appModule.createManagementApp();
    inference = appModule.createInferenceApp();

    const [defaultGroup] = await db
      .select()
      .from(schema.modelGroups)
      .where(
        and(
          eq(schema.modelGroups.userId, serviceUserId),
          eq(schema.modelGroups.isDefault, true)
        )
      )
      .limit(1);
    if (!defaultGroup) throw new Error("Managed default group was not created");
    defaultGroupId = defaultGroup.id;
    secondGroupId = "grp_managed_test_second";
    await db.insert(schema.modelGroups).values({
      id: secondGroupId,
      userId: serviceUserId,
      name: "Secondary",
      isDefault: false,
      position: 1,
    });
    await db.insert(schema.modelGroupEntries).values([
      {
        id: "managed-test-default-entry",
        groupId: defaultGroupId,
        modelId: "fixture/default-model",
        providerId: "fixture-provider-a",
        enabled: true,
        position: 0,
      },
      {
        id: "managed-test-second-entry",
        groupId: secondGroupId,
        modelId: "fixture/second-model",
        providerId: "fixture-provider-b",
        enabled: true,
        position: 0,
      },
    ]);
  });

  afterAll(async () => {
    jwksServer?.stop(true);
    await db.execute(sql`truncate table users cascade`);
  });

  test("isolates listeners and reports safe capabilities", async () => {
    expect((await inference.request("http://inference.test/api/groups")).status).toBe(404);
    expect((await management.request("http://management.test/v1/models")).status).toBe(404);
    const publicCapability = await inference.request(
      "http://inference.test/.well-known/pointer"
    );
    expect(publicCapability.status).toBe(200);
    expect(publicCapability.headers.get("access-control-allow-origin")).toBe("*");
    expect(await publicCapability.json()).toMatchObject({
      deploymentMode: "managed",
      localAuthAvailable: false,
      surface: "inference",
    });
    const protectedCapability = await request("/api/platform/v1/capabilities");
    expect(protectedCapability.status).toBe(200);
    expect(await protectedCapability.json()).toMatchObject({
      contractVersion: "1",
      deploymentMode: "managed",
    });
    const [servicePrincipal] = await db
      .select({
        kind: schema.users.kind,
        email: schema.users.email,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.id, serviceUserId))
      .limit(1);
    expect(servicePrincipal).toEqual({
      kind: "service",
      email: null,
      passwordHash: null,
    });
    const register = await management.request(
      "http://management.test/api/auth/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "blocked@example.test",
          name: "Blocked",
          password: "not-created",
        }),
      }
    );
    expect(register.status).toBe(404);
    expect(await register.json()).toMatchObject({
      error: { code: "local_auth_disabled" },
    });
  });

  test("refreshes rotated JWKS keys and fails closed while JWKS is unavailable", async () => {
    const rotated = await generateKeyPair("RS256");
    privateKey = rotated.privateKey;
    publicJwk = await exportJWK(rotated.publicKey);
    activeKid = "managed-test-key-rotated";
    await Bun.sleep(1100);
    expect((await request("/api/platform/v1/capabilities")).status).toBe(200);

    const unavailable = await generateKeyPair("RS256");
    privateKey = unavailable.privateKey;
    publicJwk = await exportJWK(unavailable.publicKey);
    activeKid = "managed-test-key-unavailable";
    jwksAvailable = false;
    await Bun.sleep(1100);
    expect((await request("/api/platform/v1/capabilities")).status).toBe(401);

    jwksAvailable = true;
    await Bun.sleep(1100);
    expect((await request("/api/platform/v1/capabilities")).status).toBe(200);
  });

  test("maps managed actors to stable, isolated personal owners", async () => {
    const permissions = [
      "management.read",
      "providers.manage",
      "groups.manage",
      "applications.provision",
      "usage.read",
      "test.inference",
    ];
    const actorA = { sub: "person-a-stable-id", iss: issuer, name: "Person A" };
    const actorB = { sub: "person-b-stable-id", iss: issuer, name: "Person B" };

    const firstA = await request("/api/groups", {}, await assertion({ actor: actorA, admin: false, permissions, ownerScope: "actor" }));
    expect(firstA.status).toBe(200);
    expect(await firstA.json()).toMatchObject([{ name: "My models", isDefault: true }]);

    const created = await request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Person A private group" }),
    }, await assertion({ actor: actorA, admin: false, permissions, ownerScope: "actor" }));
    expect(created.status).toBe(201);

    const groupsA = await request("/api/groups", {}, await assertion({ actor: actorA, admin: false, permissions, ownerScope: "actor" }));
    const groupsB = await request("/api/groups", {}, await assertion({ actor: actorB, admin: false, permissions, ownerScope: "actor" }));
    expect((await groupsA.json()).map((group: { name: string }) => group.name)).toContain("Person A private group");
    expect((await groupsB.json()).map((group: { name: string }) => group.name)).not.toContain("Person A private group");

    const external = await db.select({
      kind: schema.users.kind,
      subject: schema.users.externalSubject,
      role: schema.users.role,
    }).from(schema.users).where(isNotNull(schema.users.externalSubject));
    expect(external).toEqual(expect.arrayContaining([
      { kind: "external", subject: actorA.sub, role: "user" },
      { kind: "external", subject: actorB.sub, role: "user" },
    ]));

    const lifecycle = await request("/api/platform/v1/capabilities", {}, await assertion({
      actor: actorA, admin: false, permissions, ownerScope: "actor",
    }));
    expect(lifecycle.status).toBe(403);
    expect(await lifecycle.json()).toMatchObject({ error: { code: "actor_scope_not_allowed" } });

    const actorAdmin = await assertion({ actor: actorA, admin: true, ownerScope: "actor" });
    const imported = await request("/api/providers/import", {
      method: "POST",
      body: JSON.stringify({ yaml: "id: actor-global\nname: actor-global\nbaseUrl: https://example.com" }),
    }, actorAdmin);
    expect(imported.status).toBe(201);
    const deniedImport = await request("/api/providers/import", {
      method: "POST", body: JSON.stringify({ yaml: "id: forbidden\nname: Forbidden\nbaseUrl: https://example.com" }),
    }, await assertion({ actor: actorB, admin: false, permissions, ownerScope: "actor" }));
    expect(deniedImport.status).toBe(403);
    const deleted = await request("/api/providers/actor-global", {
      method: "DELETE",
    }, await assertion({ actor: actorA, admin: true, ownerScope: "actor" }));
    expect(deleted.status).toBe(200);
  });

  test("routes one managed application through its actor and supports explicit takeover", async () => {
    const actorA = { sub: "person-a-stable-id", iss: issuer, name: "Person A" };
    const actorB = { sub: "person-b-stable-id", iss: issuer, name: "Person B" };
    const externalId = "managed-test-actor-routed-app";
    const actorRows = await db
      .select({ id: schema.users.id, subject: schema.users.externalSubject })
      .from(schema.users)
      .where(isNotNull(schema.users.externalSubject));
    const actorAUserId = actorRows.find((row) => row.subject === actorA.sub)?.id;
    const actorBUserId = actorRows.find((row) => row.subject === actorB.sub)?.id;
    if (!actorAUserId || !actorBUserId) throw new Error("Actor fixtures were not created");
    const [actorAGroup] = await db
      .select()
      .from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.userId, actorAUserId), eq(schema.modelGroups.isDefault, true)))
      .limit(1);
    const [actorBGroup] = await db
      .select()
      .from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.userId, actorBUserId), eq(schema.modelGroups.isDefault, true)))
      .limit(1);
    if (!actorAGroup || !actorBGroup) throw new Error("Actor groups were not created");
    await db.insert(schema.modelGroupEntries).values([
      {
        id: "managed-test-actor-a-entry",
        groupId: actorAGroup.id,
        modelId: "fixture/default-model",
        providerId: "fixture-provider-a",
        enabled: true,
        position: 0,
      },
      {
        id: "managed-test-actor-b-entry",
        groupId: actorBGroup.id,
        modelId: "fixture/second-model",
        providerId: "fixture-provider-b",
        enabled: true,
        position: 0,
      },
    ]);

    const groups = await request(
      "/api/platform/v1/groups?owner=actor",
      {},
      await assertion({ actor: actorA })
    );
    expect(groups.status).toBe(200);
    expect(await groups.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: actorAGroup.id, isDefault: true }),
      ]),
    });

    const ensured = await request(
      `/api/platform/v1/installations/${externalId}`,
      {
        method: "PUT",
        headers: idempotency("managed-actor-ensure-001"),
        body: JSON.stringify({
          appId: "open-webui",
          displayName: "Open WebUI",
          routingOwner: "actor",
          groupId: actorAGroup.id,
          iconUrl: "https://apps.example.test/open-webui.png",
        }),
      },
      await assertion({ actor: actorA })
    );
    expect(ensured.status).toBe(201);
    const ensuredBody = await ensured.json();
    const actorKey = ensuredBody.credentialDelivery.credential as string;
    expect(ensuredBody.installation.routingOwner).toMatchObject({
      id: actorAUserId,
      externalSubject: actorA.sub,
      state: "active",
    });
    expect(ensuredBody.installation.selectedGroup.id).toBe(actorAGroup.id);

    const actorInstances = await request(
      "/api/instances",
      {},
      await assertion({ actor: actorA, admin: false, ownerScope: "actor" })
    );
    expect(actorInstances.status).toBe(200);
    expect(await actorInstances.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ensuredBody.installation.pointer.instanceId,
        origin: "managed",
        managedApplication: expect.objectContaining({ appId: "open-webui" }),
      }),
    ]));
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${actorKey}` },
        })
      ).status
    ).toBe(200);

    const implicitTransfer = await request(
      `/api/platform/v1/installations/${externalId}/group`,
      {
        method: "PATCH",
        headers: idempotency("managed-actor-group-bypass-001"),
        body: JSON.stringify({ groupId: actorBGroup.id }),
      },
      await assertion({ actor: actorB })
    );
    expect(implicitTransfer.status).toBe(409);
    expect(await implicitTransfer.json()).toMatchObject({
      error: { code: "routing_owner_mismatch" },
    });

    const nonAdminTakeover = await request(
      `/api/platform/v1/installations/${externalId}/routing-owner/takeover`,
      {
        method: "POST",
        headers: idempotency("managed-actor-takeover-user-denied-001"),
        body: JSON.stringify({ groupId: actorBGroup.id }),
      },
      await assertion({ actor: actorB, admin: false })
    );
    // A non-administrator cannot mint a valid platform-service assertion, so
    // the request is rejected at authentication before the route-level guard.
    expect(nonAdminTakeover.status).toBe(401);

    const takeover = await request(
      `/api/platform/v1/installations/${externalId}/routing-owner/takeover`,
      {
        method: "POST",
        headers: idempotency("managed-actor-takeover-001"),
        body: JSON.stringify({ groupId: actorBGroup.id }),
      },
      await assertion({ actor: actorB })
    );
    expect(takeover.status).toBe(200);
    expect(await takeover.json()).toMatchObject({
      routingOwner: { id: actorBUserId, externalSubject: actorB.sub },
      selectedGroup: { id: actorBGroup.id },
    });

    const ownerDisabled = await request(
      "/api/platform/v1/actors/current/state",
      {
        method: "PUT",
        headers: idempotency("managed-actor-disable-001"),
        body: JSON.stringify({ state: "disabled" }),
      },
      await assertion({ actor: actorB })
    );
    expect(ownerDisabled.status).toBe(200);
    expect(await ownerDisabled.json()).toMatchObject({
      state: "disabled",
      affectedInstallations: 1,
    });
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${actorKey}` },
        })
      ).status
    ).toBe(403);

    const recovered = await request(
      `/api/platform/v1/installations/${externalId}/routing-owner/takeover`,
      {
        method: "POST",
        headers: idempotency("managed-actor-recover-001"),
        body: JSON.stringify({ groupId: actorAGroup.id }),
      },
      await assertion({ actor: actorA })
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      state: "active",
      routingOwner: { id: actorAUserId },
    });
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${actorKey}` },
        })
      ).status
    ).toBe(200);

    const identityDeleted = await request(
      "/api/platform/v1/actors/state",
      {
        method: "PUT",
        headers: idempotency("managed-actor-target-disable-001"),
        body: JSON.stringify({ actorSubject: actorA.sub, state: "disabled" }),
      },
      await assertion({
        actor: { sub: "youeye-system-lifecycle", iss: issuer, name: "YouEye lifecycle" },
      })
    );
    expect(identityDeleted.status).toBe(200);
    expect(await identityDeleted.json()).toMatchObject({
      actorUserId: actorAUserId,
      state: "disabled",
      affectedInstallations: 1,
    });
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${actorKey}` },
        })
      ).status
    ).toBe(403);

    const archived = await request(
      `/api/platform/v1/installations/${externalId}`,
      {
        method: "DELETE",
        headers: idempotency("managed-actor-archive-001"),
      },
      await assertion({ actor: actorA })
    );
    expect(archived.status).toBe(200);
    const identityRestored = await request(
      "/api/platform/v1/actors/state",
      {
        method: "PUT",
        headers: idempotency("managed-actor-target-enable-001"),
        body: JSON.stringify({ actorSubject: actorA.sub, state: "active" }),
      },
      await assertion({
        actor: { sub: "youeye-system-lifecycle", iss: issuer, name: "YouEye lifecycle" },
      })
    );
    expect(identityRestored.status).toBe(200);
    const hiddenArchived = await request(
      "/api/instances",
      {},
      await assertion({ actor: actorA, admin: false, ownerScope: "actor" })
    );
    expect((await hiddenArchived.json()).some((row: { id: string }) =>
      row.id === ensuredBody.installation.pointer.instanceId
    )).toBe(false);
  });

  test("fails closed for invalid assertions and replayed mutation tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalid = await Promise.all([
      assertion({ aud: "wrong-audience" }),
      assertion({ iss: "https://wrong-issuer.test" }),
      assertion({ sub: "wrong-server" }),
      assertion({ exp: now - 120, iat: now - 240 }),
      assertion({ nbf: now + 120 }),
      assertion({ exp: now + 600, iat: now }),
      assertion({ actor: null }),
      assertion({ permissions: null }),
      assertion({ permissions: ["management.read", "unknown.permission"] }),
      assertion({ admin: "yes" }),
      assertion({ ownerScope: "unknown" }),
      assertion({ jti: null }),
    ]);
    for (const token of invalid) {
      expect(
        (await request("/api/platform/v1/capabilities", {}, token)).status
      ).toBe(401);
    }

    const localPointerJwt = await new SignJWT({
      sub: "local-user",
      email: "local@example.test",
      name: "Local",
      role: "admin",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(
      (
        await request(
          "/api/platform/v1/capabilities",
          {},
          localPointerJwt
        )
      ).status
    ).toBe(401);

    const [integration] = await db
      .select()
      .from(schema.platformIntegrations)
      .where(
        eq(schema.platformIntegrations.externalServerId, integrationId)
      )
      .limit(1);
    await db
      .update(schema.platformIntegrations)
      .set({ state: "disabled" })
      .where(eq(schema.platformIntegrations.id, integration.id));
    expect(
      (await request("/api/platform/v1/capabilities")).status
    ).toBe(401);
    await db
      .update(schema.platformIntegrations)
      .set({ state: "active" })
      .where(eq(schema.platformIntegrations.id, integration.id));

    const repeated = await assertion();
    const first = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-replay-test-001"),
        body: JSON.stringify({
          appId: "fixture-app",
          displayName: "Concurrent fixture",
          groupId: defaultGroupId,
        }),
      },
      repeated
    );
    expect(first.status).toBe(201);
    secondActiveKey = (await first.json()).credentialDelivery.credential;
    const replay = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}/disable`,
      {
        method: "POST",
        headers: idempotency("managed-replay-test-002"),
        body: "{}",
      },
      repeated
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { code: "platform_assertion_replayed" },
    });
  });

  test("enforces mutation permissions and managed request size limits", async () => {
    const before = await db
      .select({ id: schema.modelGroups.id })
      .from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, serviceUserId));
    const denied = await request(
      "/api/groups",
      {
        method: "POST",
        body: JSON.stringify({ name: "Must not be created" }),
      },
      await assertion({ permissions: ["management.read"] })
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "permission_denied" },
    });
    const after = await db
      .select({ id: schema.modelGroups.id })
      .from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, serviceUserId));
    expect(after.length).toBe(before.length);

    const oversized = await request(
      "/api/platform/v1/installations/managed-test-oversized",
      {
        method: "PUT",
        headers: idempotency("managed-oversized-test-001"),
        body: JSON.stringify({
          appId: "fixture-app",
          displayName: "x".repeat(70 * 1024),
        }),
      }
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "request_body_too_large" },
    });
  });

  test("serializes concurrent ensure calls to one instance and key", async () => {
    const externalId = "managed-test-concurrency-race";
    const requestBody = JSON.stringify({
      appId: "fixture-app",
      displayName: "Concurrent fixture",
      groupId: defaultGroupId,
    });
    const [left, right] = await Promise.all([
      request(`/api/platform/v1/installations/${externalId}`, {
        method: "PUT",
        headers: idempotency("managed-concurrent-ensure-001"),
        body: requestBody,
      }),
      request(`/api/platform/v1/installations/${externalId}`, {
        method: "PUT",
        headers: idempotency("managed-concurrent-ensure-001"),
        body: requestBody,
      }),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    const installations = await db
      .select()
      .from(schema.managedAppInstallations)
      .where(
        eq(schema.managedAppInstallations.externalInstallationId, externalId)
      );
    expect(installations.length).toBe(1);
    const keys = await db
      .select()
      .from(schema.apiKeys)
      .where(
        eq(schema.apiKeys.managedInstallationId, installations[0]!.id)
      );
    expect(keys.length).toBe(1);
  });

  test("ensures one installation with recoverable one-time delivery", async () => {
    const body = {
      appId: "fixture-openai-app",
      displayName: "Fixture AI application",
      appVersion: "1.0.0",
      groupId: defaultGroupId,
      adapterRevision: "fixture-v1",
    };
    const first = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-ensure-test-001"),
        body: JSON.stringify(body),
      }
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    activeKey = firstBody.credentialDelivery.credential;
    expect(activeKey).toMatch(/^ptr_[A-Za-z0-9_-]+$/);
    expect(firstBody.installation.selectedGroup.id).toBe(defaultGroupId);

    const retry = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-ensure-test-001"),
        body: JSON.stringify(body),
      }
    );
    expect(retry.status).toBe(201);
    expect((await retry.json()).credentialDelivery.credential).toBe(activeKey);

    const acknowledged = await request(
      `/api/platform/v1/installations/${externalInstallationId}/credential-deliveries/${firstBody.credentialDelivery.id}/ack`,
      {
        method: "POST",
        headers: idempotency("managed-initial-delivery-ack-001"),
        body: "{}",
      }
    );
    expect(acknowledged.status).toBe(200);
    const afterAcknowledgement = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-ensure-test-001"),
        body: JSON.stringify(body),
      }
    );
    expect((await afterAcknowledgement.json()).credentialDelivery).toBeNull();

    const reconciled = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-ensure-metadata-test-001"),
        body: JSON.stringify({
          ...body,
          displayName: "Updated fixture application",
          appVersion: "1.1.0",
          adapterRevision: "fixture-v2",
        }),
      }
    );
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      installation: {
        app: {
          displayName: "Updated fixture application",
          version: "1.1.0",
          adapterRevision: "fixture-v2",
        },
      },
      credentialDelivery: null,
    });

    const conflict = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-ensure-test-001"),
        body: JSON.stringify({ ...body, displayName: "Changed body" }),
      }
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const get = await request(
      `/api/platform/v1/installations/${externalInstallationId}`
    );
    const getText = await get.text();
    expect(get.status).toBe(200);
    expect(getText).not.toContain(activeKey);
    const listText = await (
      await request("/api/platform/v1/installations?limit=100")
    ).text();
    expect(listText).not.toContain(activeKey);

    const [delivery] = await db
      .select()
      .from(schema.credentialDeliveries)
      .innerJoin(
        schema.managedAppInstallations,
        eq(
          schema.managedAppInstallations.id,
          schema.credentialDeliveries.installationId
        )
      )
      .where(
        eq(
          schema.managedAppInstallations.externalInstallationId,
          externalInstallationId
        )
      )
      .limit(1);
    expect(delivery.credential_deliveries.payloadEncrypted).toBeNull();
  });

  test("keeps group routing live while preserving instance and key identity", async () => {
    const before = await request(
      `/api/platform/v1/installations/${externalInstallationId}`
    );
    const beforeBody = await before.json();
    const initialModels = await inference.request("http://inference.test/v1/models", {
      headers: { authorization: `Bearer ${activeKey}` },
    });
    expect(initialModels.status).toBe(200);
    expect(JSON.stringify(await initialModels.json())).toContain("Default Model");

    const changed = await request(
      `/api/platform/v1/installations/${externalInstallationId}/group`,
      {
        method: "PATCH",
        headers: idempotency("managed-group-change-001"),
        body: JSON.stringify({ groupId: secondGroupId }),
      }
    );
    expect(changed.status).toBe(200);
    const changedBody = await changed.json();
    expect(changedBody.pointer.instanceId).toBe(beforeBody.pointer.instanceId);
    expect(changedBody.credential.id).toBe(beforeBody.credential.id);
    expect(changedBody.selectedGroup.id).toBe(secondGroupId);

    const afterModels = await inference.request("http://inference.test/v1/models", {
      headers: { authorization: `Bearer ${activeKey}` },
    });
    const afterText = await afterModels.text();
    expect(afterModels.status).toBe(200);
    expect(afterText).toContain("Second Model");
    expect(afterText).not.toContain("Default Model");
  });

  test("disables, enables, rotates, and archives without losing attribution", async () => {
    const disabled = await request(
      `/api/platform/v1/installations/${externalInstallationId}/disable`,
      {
        method: "POST",
        headers: idempotency("managed-disable-test-001"),
        body: "{}",
      }
    );
    expect(disabled.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${activeKey}` },
        })
      ).status
    ).toBe(403);

    const enabledResponse = await request(
      `/api/platform/v1/installations/${externalInstallationId}/enable`,
      {
        method: "POST",
        headers: idempotency("managed-enable-test-001"),
        body: "{}",
      }
    );
    expect(enabledResponse.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${activeKey}` },
        })
      ).status
    ).toBe(200);

    const prepared = await request(
      `/api/platform/v1/installations/${externalInstallationId}/rotations`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-prepare-001"),
        body: "{}",
      }
    );
    expect(prepared.status).toBe(201);
    const preparedBody = await prepared.json();
    replacementKey = preparedBody.credentialDelivery.credential;
    const rotationId = preparedBody.rotationId;
    const concurrentPrepare = await request(
      `/api/platform/v1/installations/${externalInstallationId}/rotations`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-concurrent-prepare-001"),
        body: "{}",
      }
    );
    expect(concurrentPrepare.status).toBe(409);
    expect(await concurrentPrepare.json()).toMatchObject({
      error: { code: "rotation_state_conflict" },
    });
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${activeKey}` },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${replacementKey}` },
        })
      ).status
    ).toBe(200);

    const earlyCommit = await request(
      `/api/platform/v1/installations/${externalInstallationId}/rotations/${rotationId}/commit`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-early-commit-001"),
        body: "{}",
      }
    );
    expect(earlyCommit.status).toBe(409);

    const acknowledged = await request(
      `/api/platform/v1/installations/${externalInstallationId}/credential-deliveries/${preparedBody.credentialDelivery.id}/ack`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-ack-001"),
        body: "{}",
      }
    );
    expect(acknowledged.status).toBe(200);

    const committed = await request(
      `/api/platform/v1/installations/${externalInstallationId}/rotations/${rotationId}/commit`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-commit-001"),
        body: "{}",
      }
    );
    expect(committed.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${activeKey}` },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${replacementKey}` },
        })
      ).status
    ).toBe(200);

    const [installation] = await db
      .select()
      .from(schema.managedAppInstallations)
      .where(
        eq(
          schema.managedAppInstallations.externalInstallationId,
          externalInstallationId
        )
      )
      .limit(1);
    await db.insert(schema.usageLogs).values({
      id: "managed-test-usage",
      apiKeyId: installation.activeApiKeyId,
      userId: serviceUserId,
      instanceId: installation.instanceId,
      modelId: "fixture/second-model",
      providerId: "fixture-provider-b",
      statusCode: 200,
      outcome: "success",
      source: "proxy",
    });

    const archived = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "DELETE",
        headers: idempotency("managed-archive-test-001"),
      }
    );
    expect(archived.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${replacementKey}` },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await db
          .select({ id: schema.usageLogs.id })
          .from(schema.usageLogs)
          .where(eq(schema.usageLogs.id, "managed-test-usage"))
      ).length
    ).toBe(1);

    const repeatedArchive = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "DELETE",
        headers: idempotency("managed-archive-test-002"),
      }
    );
    expect(repeatedArchive.status).toBe(200);
    expect(await repeatedArchive.json()).toMatchObject({
      archived: true,
      credentialsRevoked: true,
    });
    const reused = await request(
      `/api/platform/v1/installations/${externalInstallationId}`,
      {
        method: "PUT",
        headers: idempotency("managed-archived-reuse-test-001"),
        body: JSON.stringify({
          appId: "fixture-openai-app",
          displayName: "Reused archived app",
          groupId: secondGroupId,
        }),
      }
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({
      error: { code: "external_installation_id_reused" },
    });
  });

  test("aborts a prepared rotation while preserving the old credential", async () => {
    const prepared = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}/rotations`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-abort-prepare-001"),
        body: "{}",
      }
    );
    expect(prepared.status).toBe(201);
    const body = await prepared.json();
    const pendingKey = body.credentialDelivery.credential as string;
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${pendingKey}` },
        })
      ).status
    ).toBe(200);
    const aborted = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}/rotations/${body.rotationId}/abort`,
      {
        method: "POST",
        headers: idempotency("managed-rotation-abort-001"),
        body: "{}",
      }
    );
    expect(aborted.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${pendingKey}` },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${secondActiveKey}` },
        })
      ).status
    ).toBe(200);
  });

  test("protects managed resources from ordinary mutation and linked group deletion", async () => {
    const installationResponse = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}`
    );
    const installation = await installationResponse.json();
    const instanceId = installation.pointer.instanceId as string;
    const keyId = installation.credential.id as string;

    const instanceMutation = await request(`/api/instances/${instanceId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Bypass attempt" }),
    });
    expect(instanceMutation.status).toBe(409);
    expect(await instanceMutation.json()).toMatchObject({
      code: "managed_resource_protected",
    });

    const keyMutation = await request(`/api/keys/${keyId}`, {
      method: "DELETE",
    });
    expect(keyMutation.status).toBe(409);
    expect(await keyMutation.json()).toMatchObject({
      code: "managed_resource_protected",
    });

    const assigned = await request(
      `/api/platform/v1/installations/${secondExternalInstallationId}/group`,
      {
        method: "PATCH",
        headers: idempotency("managed-linked-group-test-001"),
        body: JSON.stringify({ groupId: secondGroupId }),
      }
    );
    expect(assigned.status).toBe(200);

    const groupDeletion = await request(`/api/groups/${secondGroupId}`, {
      method: "DELETE",
    });
    expect(groupDeletion.status).toBe(409);
    expect(await groupDeletion.json()).toMatchObject({
      code: "group_linked",
      linkedApplications: [secondExternalInstallationId],
    });
  });

  test("uses the current default only for new installs and shares ownership across actors", async () => {
    const existingBefore = await (
      await request(
        "/api/platform/v1/installations/managed-test-concurrency-race"
      )
    ).json();
    expect(existingBefore.selectedGroup.id).toBe(defaultGroupId);

    const defaultDeletion = await request(`/api/groups/${defaultGroupId}`, {
      method: "DELETE",
    });
    expect(defaultDeletion.status).toBe(400);
    expect(await defaultDeletion.json()).toMatchObject({
      code: "default_group",
    });

    const selectedDefault = await request(
      `/api/groups/${secondGroupId}/set-default`,
      { method: "PUT", body: "{}" }
    );
    expect(selectedDefault.status).toBe(200);

    const existingAfter = await (
      await request(
        "/api/platform/v1/installations/managed-test-concurrency-race"
      )
    ).json();
    expect(existingAfter.selectedGroup.id).toBe(defaultGroupId);
    expect(existingAfter.selectedGroup.isDefault).toBe(false);

    const actorB = {
      sub: "admin-second-subject",
      iss: issuer,
      name: "Second administrator",
    };
    const newExternalId = "managed-test-new-default";
    const ensured = await request(
      `/api/platform/v1/installations/${newExternalId}`,
      {
        method: "PUT",
        headers: idempotency("managed-new-default-test-001"),
        body: JSON.stringify({
          appId: "fixture-default-app",
          displayName: "New default fixture",
        }),
      },
      await assertion({ actor: actorB })
    );
    expect(ensured.status).toBe(201);
    const ensuredBody = await ensured.json();
    expect(ensuredBody.installation.selectedGroup.id).toBe(secondGroupId);
    newDefaultKey = ensuredBody.credentialDelivery.credential;

    const [actorAudit] = await db
      .select({
        actorSubject: schema.managementAudit.actorSubject,
        targetId: schema.managementAudit.targetId,
      })
      .from(schema.managementAudit)
      .where(eq(schema.managementAudit.targetId, newExternalId))
      .limit(1);
    expect(actorAudit).toEqual({
      actorSubject: actorB.sub,
      targetId: newExternalId,
    });

    const actorAGroupIds = (
      await (await request("/api/platform/v1/groups")).json()
    ).items.map((group: { id: string }) => group.id);
    const actorBGroupIds = (
      await (
        await request(
          "/api/platform/v1/groups",
          {},
          await assertion({ actor: actorB })
        )
      ).json()
    ).items.map((group: { id: string }) => group.id);
    expect(actorBGroupIds).toEqual(actorAGroupIds);

    const aliased = await request(
      `/api/groups/${secondGroupId}/entries/managed-test-second-entry`,
      {
        method: "PUT",
        body: JSON.stringify({ alias: "Edited Route" }),
      }
    );
    expect(aliased.status).toBe(200);
    const models = await inference.request("http://inference.test/v1/models", {
      headers: { authorization: `Bearer ${secondActiveKey}` },
    });
    expect(models.status).toBe(200);
    expect(await models.text()).toContain("Edited Route");

    await db
      .update(schema.credentialDeliveries)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        eq(
          schema.credentialDeliveries.id,
          ensuredBody.credentialDelivery.id
        )
      );
    const expiredRetry = await request(
      `/api/platform/v1/installations/${newExternalId}`,
      {
        method: "PUT",
        headers: idempotency("managed-new-default-test-001"),
        body: JSON.stringify({
          appId: "fixture-default-app",
          displayName: "New default fixture",
        }),
      }
    );
    expect(expiredRetry.status).toBe(201);
    expect(await expiredRetry.json()).toMatchObject({
      credentialDelivery: null,
      installation: {
        credential: { deliveryState: "expired" },
        drift: { recoveryActions: ["rotate_credential"] },
      },
    });

    const recovery = await request(
      `/api/platform/v1/installations/${newExternalId}/rotations`,
      {
        method: "POST",
        headers: idempotency("managed-expired-delivery-rotation-001"),
        body: "{}",
      }
    );
    expect(recovery.status).toBe(201);
    const recoveryBody = await recovery.json();
    const abortedRecovery = await request(
      `/api/platform/v1/installations/${newExternalId}/rotations/${recoveryBody.rotationId}/abort`,
      {
        method: "POST",
        headers: idempotency("managed-expired-delivery-abort-001"),
        body: "{}",
      }
    );
    expect(abortedRecovery.status).toBe(200);
    expect(
      (
        await inference.request("http://inference.test/v1/models", {
          headers: { authorization: `Bearer ${newDefaultKey}` },
        })
      ).status
    ).toBe(200);
  });

  test("never persists delivered credentials in idempotency or audit data", async () => {
    const [idempotencyRows, auditRows] = await Promise.all([
      db.select().from(schema.platformIdempotency),
      db.select().from(schema.managementAudit),
    ]);
    const persisted = JSON.stringify({ idempotencyRows, auditRows });
    expect(persisted).not.toContain(activeKey);
    expect(persisted).not.toContain(replacementKey);
    expect(persisted).not.toContain(newDefaultKey);
    expect(auditRows.length).toBeGreaterThan(0);
  });

  test("purges expired delivery, replay, idempotency, and audit state", async () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 60_000);
    const oldAudit = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.credentialDeliveries)
      .set({ expiresAt: expired })
      .where(isNotNull(schema.credentialDeliveries.payloadEncrypted));
    await db
      .update(schema.platformAssertionReplays)
      .set({ expiresAt: expired });
    await db
      .update(schema.platformIdempotency)
      .set({ expiresAt: expired });
    await db
      .update(schema.managementAudit)
      .set({ createdAt: oldAudit });

    const { pruneManagedState } = await import("./managed-retention");
    await pruneManagedState(now);

    const [deliveries, replays, idempotencyRows, auditRows] = await Promise.all([
      db
        .select({ payload: schema.credentialDeliveries.payloadEncrypted })
        .from(schema.credentialDeliveries)
        .where(lt(schema.credentialDeliveries.expiresAt, now)),
      db.select().from(schema.platformAssertionReplays),
      db.select().from(schema.platformIdempotency),
      db.select().from(schema.managementAudit),
    ]);
    expect(deliveries.every((delivery) => delivery.payload === null)).toBe(true);
    expect(replays).toHaveLength(0);
    expect(idempotencyRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});
