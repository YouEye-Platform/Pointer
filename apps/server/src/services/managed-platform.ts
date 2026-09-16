import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { config } from "../config";
import { db, schema } from "../db";

export type ManagedIntegrationContext = {
  id: string;
  ownerUserId: string;
  externalServerId: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedSubject: string;
  state: string;
  ownerName: string;
  ownerState: string;
  ownerKind: string;
};

export async function ensureManagedIntegration(): Promise<ManagedIntegrationContext | null> {
  if (config.mode !== "managed" || !config.platform) return null;
  const platform = config.platform;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"managed-platform:" + platform.integrationId}))`
    );

    const [existing] = await tx
      .select()
      .from(schema.platformIntegrations)
      .where(eq(schema.platformIntegrations.externalServerId, platform.integrationId))
      .limit(1);

    let integration = existing;
    if (!integration) {
      const ownerUserId = `svc_${nanoid(16)}`;
      await tx.insert(schema.users).values({
        id: ownerUserId,
        kind: "service",
        email: null,
        name: platform.servicePrincipalName,
        passwordHash: null,
        role: "admin",
        state: "active",
      });
      [integration] = await tx
        .insert(schema.platformIntegrations)
        .values({
          id: `int_${nanoid(16)}`,
          kind: "youeye",
          externalServerId: platform.integrationId,
          ownerUserId,
          expectedIssuer: platform.issuer,
          expectedAudience: platform.audience,
          expectedSubject: platform.subject,
          state: "active",
        })
        .returning();
    }

    if (
      integration.expectedIssuer !== platform.issuer
      || integration.expectedAudience !== platform.audience
      || integration.expectedSubject !== platform.subject
    ) {
      throw new Error("Managed platform trust configuration does not match persisted integration");
    }
    if (integration.state !== "active") {
      throw new Error("Managed platform integration is disabled");
    }

    const [owner] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, integration.ownerUserId))
      .limit(1);
    if (!owner || owner.kind !== "service" || owner.passwordHash !== null || owner.state !== "active") {
      throw new Error("Managed platform service-principal invariant failed");
    }
    if (owner.name !== platform.servicePrincipalName) {
      await tx
        .update(schema.users)
        .set({ name: platform.servicePrincipalName, updatedAt: new Date() })
        .where(eq(schema.users.id, owner.id));
    }

    const groups = await tx
      .select()
      .from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, owner.id))
      .orderBy(
        asc(schema.modelGroups.position),
        asc(schema.modelGroups.createdAt),
        asc(schema.modelGroups.id)
      );
    const defaults = groups.filter((group) => group.isDefault);
    if (defaults.length > 1) {
      throw new Error("Managed platform has multiple default groups");
    }
    if (groups.length === 0) {
      await tx.insert(schema.modelGroups).values({
        id: `grp_${nanoid(12)}`,
        userId: owner.id,
        name: "Default",
        isDefault: true,
        position: 0,
      });
    } else if (defaults.length === 0) {
      await tx
        .update(schema.modelGroups)
        .set({ isDefault: true })
        .where(eq(schema.modelGroups.id, groups[0]!.id));
    }

    return {
      id: integration.id,
      ownerUserId: integration.ownerUserId,
      externalServerId: integration.externalServerId,
      expectedIssuer: integration.expectedIssuer,
      expectedAudience: integration.expectedAudience,
      expectedSubject: integration.expectedSubject,
      state: integration.state,
      ownerName: platform.servicePrincipalName,
      ownerState: owner.state,
      ownerKind: owner.kind,
    };
  });
}

export async function loadManagedIntegration(): Promise<ManagedIntegrationContext | null> {
  if (config.mode !== "managed" || !config.platform) return null;
  const [row] = await db
    .select({
      id: schema.platformIntegrations.id,
      ownerUserId: schema.platformIntegrations.ownerUserId,
      externalServerId: schema.platformIntegrations.externalServerId,
      expectedIssuer: schema.platformIntegrations.expectedIssuer,
      expectedAudience: schema.platformIntegrations.expectedAudience,
      expectedSubject: schema.platformIntegrations.expectedSubject,
      state: schema.platformIntegrations.state,
      ownerName: schema.users.name,
      ownerState: schema.users.state,
      ownerKind: schema.users.kind,
    })
    .from(schema.platformIntegrations)
    .innerJoin(schema.users, eq(schema.users.id, schema.platformIntegrations.ownerUserId))
    .where(
      and(
        eq(schema.platformIntegrations.externalServerId, config.platform.integrationId),
        eq(schema.platformIntegrations.state, "active")
      )
    )
    .limit(1);
  return row ?? null;
}

export async function managedDefaultGroup(ownerUserId: string) {
  const [group] = await db
    .select()
    .from(schema.modelGroups)
    .where(
      and(
        eq(schema.modelGroups.userId, ownerUserId),
        eq(schema.modelGroups.isDefault, true)
      )
    )
    .limit(1);
  return group ?? null;
}
