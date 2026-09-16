import { Hono } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { authMiddleware, type AuthUser } from "../middleware/auth";
import { resolveModelIconKey, resolveProviderIconKey } from "../services/brand-icons";
import { invalidateModelResolutionCache } from "../services/model-resolution";
import {
  isReservedModelAlias,
  normalizeManualModelAlias,
  normalizeModelLookupKey,
  POSITIONAL_MODEL_ALIASES,
  reservedModelAliasMessage,
} from "../services/model-aliases";

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.use("*", authMiddleware);
app.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "GET"
    && !c.req.path.endsWith("/set-default")
    && c.res.status < 400) invalidateModelResolutionCache();
});

type GroupEntry = typeof schema.modelGroupEntries.$inferSelect;

function entryOrder() {
  return [
    asc(schema.modelGroupEntries.position),
    asc(schema.modelGroupEntries.createdAt),
    asc(schema.modelGroupEntries.id),
  ] as const;
}

async function lockUserGroups(tx: any, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"model-groups:" + userId}))`);
}

async function lockOwnedGroup(tx: any, groupId: string, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"model-group:" + groupId}))`);
  const [group] = await tx
    .select()
    .from(schema.modelGroups)
    .where(and(eq(schema.modelGroups.id, groupId), eq(schema.modelGroups.userId, userId)))
    .limit(1);
  return group ?? null;
}

async function ownedGroup(groupId: string, userId: string) {
  const [group] = await db
    .select()
    .from(schema.modelGroups)
    .where(and(eq(schema.modelGroups.id, groupId), eq(schema.modelGroups.userId, userId)))
    .limit(1);
  return group ?? null;
}

async function orderedEntryIds(tx: any, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.modelGroupEntries.id })
    .from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, groupId))
    .orderBy(...entryOrder());
  return rows.map((row: { id: string }) => row.id);
}

async function writeContiguousOrder(tx: any, groupId: string, entryIds: string[]) {
  if (entryIds.length === 0) return;
  const [maxPosition] = await tx
    .select({ value: sql<number>`COALESCE(MAX(${schema.modelGroupEntries.position}), -1)` })
    .from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, groupId));
  const offset = Math.max(Number(maxPosition?.value ?? -1) + 1, entryIds.length) + entryIds.length;
  await tx
    .update(schema.modelGroupEntries)
    .set({ position: sql`${schema.modelGroupEntries.position} + ${offset}` })
    .where(eq(schema.modelGroupEntries.groupId, groupId));
  for (const [position, entryId] of entryIds.entries()) {
    await tx
      .update(schema.modelGroupEntries)
      .set({ position })
      .where(and(eq(schema.modelGroupEntries.groupId, groupId), eq(schema.modelGroupEntries.id, entryId)));
  }
}

function normalizedAliasOrError(alias: string | null | undefined) {
  const normalized = normalizeManualModelAlias(alias);
  return isReservedModelAlias(normalized)
    ? { error: reservedModelAliasMessage(), code: "reserved_model_alias" as const }
    : { value: normalized };
}

function groupEntryConstraint(error: unknown) {
  const databaseError = error as any;
  const value = [
    databaseError?.code,
    databaseError?.constraint,
    databaseError?.constraint_name,
    databaseError?.detail,
    databaseError?.cause?.code,
    databaseError?.cause?.constraint,
    databaseError?.cause?.constraint_name,
    databaseError?.cause?.detail,
    String(error),
  ].filter(Boolean).join(" ");
  if (value.includes("idx_group_entry_route_unique")) return "model_route_already_in_group" as const;
  if (value.includes("idx_group_entry_alias_unique")) return "model_name_conflict" as const;
  return value.includes("23505") ? "model_group_conflict" as const : null;
}

async function validatePublicModelName(
  tx: any,
  groupId: string,
  catalogEntityId: string,
  alias: string | null,
  excludeEntryId?: string,
) {
  const entries = await tx
    .select({
      id: schema.modelGroupEntries.id,
      catalogEntityId: schema.modelGroupEntries.catalogEntityId,
      modelId: schema.modelGroupEntries.modelId,
      alias: schema.modelGroupEntries.alias,
    })
    .from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, groupId));
  const existing = entries.filter((entry: { id: string }) => entry.id !== excludeEntryId);
  if (!alias && existing.some((entry: { catalogEntityId: string | null }) => entry.catalogEntityId === catalogEntityId)) {
    return {
      error: "Add a unique public alias for another route to this model",
      code: "duplicate_model_alias_required" as const,
    };
  }

  const entityIds = [...new Set([
    catalogEntityId,
    ...existing.map((entry: { catalogEntityId: string | null }) => entry.catalogEntityId),
  ].filter((value): value is string => Boolean(value)))];
  const [active] = await tx.select({ id: schema.catalogGenerations.id })
    .from(schema.catalogGenerations)
    .where(eq(schema.catalogGenerations.state, "active"))
    .limit(1);
  const entities = active && entityIds.length
    ? await tx.select({
      entityId: schema.catalogGenerationEntities.entityId,
      preferredName: schema.catalogGenerationEntities.preferredName,
    }).from(schema.catalogGenerationEntities).where(and(
      eq(schema.catalogGenerationEntities.generationId, active.id),
      inArray(schema.catalogGenerationEntities.entityId, entityIds),
    ))
    : [];
  const names = new Map<string, string>(entities.map((entity: { entityId: string; preferredName: string }) => [entity.entityId, entity.preferredName]));
  const publicName = alias || names.get(catalogEntityId) || catalogEntityId;
  const publicKey = normalizeModelLookupKey(publicName);
  if (isReservedModelAlias(publicName)) {
    return {
      error: reservedModelAliasMessage(),
      code: "reserved_model_alias" as const,
    };
  }
  const conflict = existing.find((entry: { catalogEntityId: string | null; modelId: string; alias: string | null }) => {
    const existingName = entry.alias || (entry.catalogEntityId ? names.get(entry.catalogEntityId) : null) || entry.modelId;
    return normalizeModelLookupKey(existingName) === publicKey;
  });
  if (conflict) {
    return {
      error: `Public model name “${publicName}” is already used in this group`,
      code: "model_name_conflict" as const,
    };
  }
  return { value: publicName };
}

async function resolveSelectableRoute(
  tx: any,
  userId: string,
  catalogEntityId: string,
  providerModelKey: string,
  requestedAccountId?: string,
) {
  const [active] = await tx
    .select({ id: schema.catalogGenerations.id })
    .from(schema.catalogGenerations)
    .where(eq(schema.catalogGenerations.state, "active"))
    .limit(1);
  if (!active) return { error: "catalog_model_not_found" as const };

  const [route] = await tx
    .select({
      providerModelKey: schema.providerModels.id,
      providerId: schema.providerModels.providerId,
      modelId: schema.providerModels.modelId,
      rawModelId: schema.providerModels.providerModelId,
    })
    .from(schema.providerModels)
    .innerJoin(
      schema.catalogGenerationProviderRoutes,
      and(
        eq(schema.catalogGenerationProviderRoutes.providerModelId, schema.providerModels.id),
        eq(schema.catalogGenerationProviderRoutes.generationId, active.id),
        eq(schema.catalogGenerationProviderRoutes.entityId, catalogEntityId),
      ),
    )
    .where(eq(schema.providerModels.id, providerModelKey))
    .limit(1);
  if (!route) return { error: "provider_route_not_found" as const };

  const accounts = await tx
    .select({ id: schema.providerAccounts.id })
    .from(schema.providerAccounts)
    .innerJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
    .innerJoin(schema.providerAccountModels, and(
      eq(schema.providerAccountModels.providerAccountId, schema.providerAccounts.id),
      eq(schema.providerAccountModels.providerModelId, route.providerModelKey),
    ))
    .where(and(
      eq(schema.providerAccounts.userId, userId),
      eq(schema.providerAccounts.providerId, route.providerId),
      eq(schema.providerAccounts.status, "active"),
      ...(requestedAccountId ? [eq(schema.providerAccounts.id, requestedAccountId)] : []),
    ))
    .orderBy(asc(schema.providerAccounts.createdAt), asc(schema.providerAccounts.id))
    .limit(requestedAccountId ? 1 : 2);
  if (accounts.length === 0) return { error: "provider_not_added" as const };
  if (!requestedAccountId && accounts.length > 1) return { error: "provider_account_required" as const };
  return { route, providerAccountId: accounts[0]!.id };
}

async function enrichEntries(entries: GroupEntry[], userId: string) {
  if (entries.length === 0) return [];
  const providerIds = [...new Set(entries.map((entry) => entry.providerId))];
  const entityIds = entries.map((entry) => entry.catalogEntityId).filter((value): value is string => Boolean(value));

  const [providerModels, providers, ownAccounts, availableAccountModels, activeRows] = await Promise.all([
    db.select().from(schema.providerModels).where(inArray(schema.providerModels.providerId, providerIds)),
    db.select().from(schema.providers).where(inArray(schema.providers.id, providerIds)),
    db.select({ id: schema.providerAccounts.id, providerId: schema.providerAccounts.providerId, nickname: schema.providerAccounts.nickname })
      .from(schema.providerAccounts)
      .innerJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
      .where(and(
        eq(schema.providerAccounts.userId, userId),
        eq(schema.providerAccounts.status, "active"),
        inArray(schema.providerAccounts.providerId, providerIds),
      )),
    db.select({
      providerAccountId: schema.providerAccountModels.providerAccountId,
      providerModelId: schema.providerAccountModels.providerModelId,
    }).from(schema.providerAccountModels)
      .innerJoin(schema.providerAccounts, eq(schema.providerAccounts.id, schema.providerAccountModels.providerAccountId))
      .innerJoin(schema.providerKeys, eq(schema.providerKeys.providerAccountId, schema.providerAccounts.id))
      .where(and(
        eq(schema.providerAccounts.userId, userId),
        eq(schema.providerAccounts.status, "active"),
        inArray(schema.providerAccounts.providerId, providerIds),
      )),
    db.select({ id: schema.catalogGenerations.id }).from(schema.catalogGenerations)
      .where(eq(schema.catalogGenerations.state, "active")).limit(1),
  ]);
  const activeId = activeRows[0]?.id;
  const entities = activeId && entityIds.length
    ? await db.select().from(schema.catalogGenerationEntities)
      .where(and(
        eq(schema.catalogGenerationEntities.generationId, activeId),
        inArray(schema.catalogGenerationEntities.entityId, entityIds),
      ))
    : [];
  const organizationIds = entities.map((entity) => entity.organizationId).filter((value): value is string => Boolean(value));
  const organizations = activeId && organizationIds.length
    ? await db.select().from(schema.catalogGenerationOrganizations)
      .where(and(
        eq(schema.catalogGenerationOrganizations.generationId, activeId),
        inArray(schema.catalogGenerationOrganizations.organizationId, organizationIds),
      ))
    : [];

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const modelByKey = new Map(providerModels.map((model) => [model.id, model]));
  const entityById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const organizationById = new Map(organizations.map((organization) => [organization.organizationId, organization]));
  const accountById = new Map(ownAccounts.map((row) => [row.id, row]));
  const availableAccountModelKeys = new Set(
    availableAccountModels.map((row) => `${row.providerAccountId}\u0000${row.providerModelId}`),
  );
  const roleByEntry = new Map(
    entries.filter((entry) => entry.enabled).slice(0, POSITIONAL_MODEL_ALIASES.length)
      .map((entry, index) => [entry.id, [...POSITIONAL_MODEL_ALIASES[index]]] as const),
  );

  return entries.map((entry) => {
    const exact = entry.providerModelKey ? modelByKey.get(entry.providerModelKey) : null;
    const legacyCandidates = exact ? [] : providerModels.filter((model) =>
      model.providerId === entry.providerId
      && [
        model.id,
        model.modelId,
        model.providerModelId,
        model.canonicalModelId,
        model.catalogEntityId,
      ].some((value) => value === entry.modelId)
    );
    const providerModel = exact ?? (legacyCandidates.length === 1 ? legacyCandidates[0] : null);
    const catalogEntityId = entry.catalogEntityId ?? providerModel?.catalogEntityId ?? null;
    const entity = catalogEntityId ? entityById.get(catalogEntityId) : null;
    const provider = providerById.get(entry.providerId);
    const creator = entity?.organizationId
      ? organizationById.get(entity.organizationId)?.canonicalName ?? null
      : null;
    const modelName = entity?.preferredName
      ?? providerModel?.displayName
      ?? providerModel?.modelId
      ?? entry.modelId;
    return {
      ...entry,
      catalogEntityId,
      providerModelKey: providerModel?.id ?? entry.providerModelKey,
      modelName,
      displayName: modelName,
      modelSlug: entity?.stableSlug ?? null,
      canonicalSlug: entity?.stableSlug ?? null,
      modelIconKey: resolveModelIconKey({ id: catalogEntityId ?? entry.modelId, name: modelName, creator }),
      creator,
      providerName: provider?.name ?? entry.providerId,
      providerAccountNickname: entry.providerAccountId ? accountById.get(entry.providerAccountId)?.nickname ?? null : null,
      providerIconKey: resolveProviderIconKey(provider ?? { id: entry.providerId }),
      rawModelId: providerModel?.providerModelId ?? entry.modelId,
      inputPrice: providerModel?.inputPrice ?? null,
      outputPrice: providerModel?.outputPrice ?? null,
      contextWindow: providerModel?.contextWindow ?? entity?.contextWindow ?? null,
      maxOutput: providerModel?.maxOutput ?? entity?.maxOutput ?? null,
      hiddenAliases: roleByEntry.get(entry.id) ?? [],
      providerAvailable: Boolean(
        entry.providerAccountId
        && providerModel
        && availableAccountModelKeys.has(`${entry.providerAccountId}\u0000${providerModel.id}`)
      ),
      needsReview: !providerModel || !catalogEntityId,
    };
  });
}

async function groupSummaries(userId: string) {
  const [groups, counts, previewRows] = await Promise.all([
    db.select().from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, userId))
      .orderBy(asc(schema.modelGroups.position), asc(schema.modelGroups.createdAt), asc(schema.modelGroups.id)),
    db.select({
      groupId: schema.modelGroupEntries.groupId,
      entryCount: sql<number>`count(*)::int`,
      enabledEntryCount: sql<number>`count(*) filter (where ${schema.modelGroupEntries.enabled} = true)::int`,
    }).from(schema.modelGroupEntries)
      .innerJoin(schema.modelGroups, eq(schema.modelGroups.id, schema.modelGroupEntries.groupId))
      .where(eq(schema.modelGroups.userId, userId))
      .groupBy(schema.modelGroupEntries.groupId),
    db.select({ entry: schema.modelGroupEntries })
      .from(schema.modelGroupEntries)
      .innerJoin(schema.modelGroups, eq(schema.modelGroups.id, schema.modelGroupEntries.groupId))
      .where(and(
        eq(schema.modelGroups.userId, userId),
        eq(schema.modelGroupEntries.enabled, true),
      ))
      .orderBy(
        asc(schema.modelGroupEntries.groupId),
        asc(schema.modelGroupEntries.position),
        asc(schema.modelGroupEntries.createdAt),
        asc(schema.modelGroupEntries.id),
      ),
  ]);
  const countByGroup = new Map(counts.map((row) => [row.groupId, row]));
  const enrichedPreviews = await enrichEntries(previewRows.map((row) => row.entry), userId);
  const previewsByGroup = new Map<string, Awaited<ReturnType<typeof enrichEntries>>>();
  for (const entry of enrichedPreviews) {
    const rows = previewsByGroup.get(entry.groupId) ?? [];
    if (rows.length < 3) rows.push(entry);
    previewsByGroup.set(entry.groupId, rows);
  }
  return groups.map((group) => ({
    ...group,
    entryCount: countByGroup.get(group.id)?.entryCount ?? 0,
    enabledEntryCount: countByGroup.get(group.id)?.enabledEntryCount ?? 0,
    previewEntries: previewsByGroup.get(group.id) ?? [],
  }));
}

app.get("/", async (c) => c.json(await groupSummaries(c.get("user").id)));

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isDefault: z.boolean().optional(),
});

app.post("/", async (c) => {
  const user = c.get("user");
  const body = createGroupSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const group = await db.transaction(async (tx) => {
    await lockUserGroups(tx, user.id);
    const groups = await tx.select().from(schema.modelGroups)
      .where(eq(schema.modelGroups.userId, user.id))
      .orderBy(asc(schema.modelGroups.position), asc(schema.modelGroups.createdAt), asc(schema.modelGroups.id));
    const makeDefault = body.data.isDefault === true || groups.length === 0;
    if (makeDefault && groups.some((item: any) => item.isDefault)) {
      await tx.update(schema.modelGroups).set({ isDefault: false })
        .where(eq(schema.modelGroups.userId, user.id));
    }
    const id = `grp_${nanoid(12)}`;
    const [created] = await tx.insert(schema.modelGroups).values({
      id,
      userId: user.id,
      name: body.data.name,
      isDefault: makeDefault,
      position: groups.length ? Math.max(...groups.map((item: any) => item.position ?? 0)) + 1 : 0,
    }).returning();
    return created;
  });
  return c.json(group, 201);
});

app.get("/default", async (c) => {
  const user = c.get("user");
  const group = await db.transaction(async (tx) => {
    await lockUserGroups(tx, user.id);
    let [current] = await tx.select().from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.userId, user.id), eq(schema.modelGroups.isDefault, true)))
      .limit(1);
    if (!current) {
      const [first] = await tx.select().from(schema.modelGroups)
        .where(eq(schema.modelGroups.userId, user.id))
        .orderBy(asc(schema.modelGroups.position), asc(schema.modelGroups.createdAt), asc(schema.modelGroups.id))
        .limit(1);
      if (first) {
        [current] = await tx.update(schema.modelGroups).set({ isDefault: true })
          .where(eq(schema.modelGroups.id, first.id)).returning();
      } else {
        [current] = await tx.insert(schema.modelGroups).values({
          id: `grp_${nanoid(12)}`,
          userId: user.id,
          name: "My Favourites",
          isDefault: true,
          position: 0,
        }).returning();
      }
    }
    return current;
  });
  const entries = await db.select().from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, group.id)).orderBy(...entryOrder());
  return c.json({ ...group, entries: await enrichEntries(entries, user.id) });
});

app.get("/:id", async (c) => {
  const user = c.get("user");
  const group = await ownedGroup(c.req.param("id"), user.id);
  if (!group) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  const entries = await db.select().from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, group.id)).orderBy(...entryOrder());
  return c.json({ ...group, entries: await enrichEntries(entries, user.id) });
});

const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  position: z.number().int().min(0).optional(),
});

app.put("/:id", async (c) => {
  const user = c.get("user");
  const body = updateGroupSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const rows = await db.update(schema.modelGroups).set(body.data)
    .where(and(eq(schema.modelGroups.id, c.req.param("id")), eq(schema.modelGroups.userId, user.id)))
    .returning();
  if (!rows.length) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  return c.json(rows[0]);
});

app.put("/:id/set-default", async (c) => {
  const user = c.get("user");
  const result = await db.transaction(async (tx) => {
    await lockUserGroups(tx, user.id);
    const [target] = await tx.select().from(schema.modelGroups)
      .where(and(eq(schema.modelGroups.id, c.req.param("id")), eq(schema.modelGroups.userId, user.id)))
      .limit(1);
    if (!target) return null;
    if (!target.isDefault) {
      await tx.update(schema.modelGroups).set({ isDefault: false })
        .where(eq(schema.modelGroups.userId, user.id));
      const [updated] = await tx.update(schema.modelGroups).set({ isDefault: true })
        .where(eq(schema.modelGroups.id, target.id)).returning();
      return updated;
    }
    return target;
  });
  if (!result) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  return c.json(result);
});

app.delete("/:id", async (c) => {
  const user = c.get("user");
  const result = await db.transaction(async (tx) => {
    await lockUserGroups(tx, user.id);
    const group = await lockOwnedGroup(tx, c.req.param("id"), user.id);
    if (!group) return "group_not_found" as const;
    if (group.isDefault) return "default_group" as const;
    const linked = await tx
      .select({
        externalInstallationId: schema.managedAppInstallations.externalInstallationId,
      })
      .from(schema.managedAppInstallations)
      .innerJoin(
        schema.instances,
        eq(schema.instances.id, schema.managedAppInstallations.instanceId)
      )
      .where(and(
        eq(schema.instances.modelGroupId, group.id),
        ne(schema.managedAppInstallations.state, "archived"),
      ));
    if (linked.length > 0) {
      return {
        kind: "group_linked" as const,
        applications: linked.map((item: { externalInstallationId: string }) => item.externalInstallationId),
      };
    }
    await tx.delete(schema.modelGroups).where(eq(schema.modelGroups.id, group.id));
    return "deleted" as const;
  });
  if (result === "group_not_found") return c.json({ error: "Group not found", code: result }, 404);
  if (result === "default_group") return c.json({ error: "Cannot delete the default group", code: result }, 400);
  if (typeof result === "object" && result.kind === "group_linked") {
    return c.json({
      error: "Group is linked to active managed applications",
      code: "group_linked",
      linkedApplicationCount: result.applications.length,
      linkedApplications: result.applications,
    }, 409);
  }
  return c.json({ deleted: true });
});

app.get("/:id/entries", async (c) => {
  const user = c.get("user");
  const group = await ownedGroup(c.req.param("id"), user.id);
  if (!group) return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  const entries = await db.select().from(schema.modelGroupEntries)
    .where(eq(schema.modelGroupEntries.groupId, group.id)).orderBy(...entryOrder());
  return c.json(await enrichEntries(entries, user.id));
});

const addEntrySchema = z.object({
  catalogEntityId: z.string().min(1),
  providerModelKey: z.string().min(1),
  providerAccountId: z.string().min(1).optional(),
  alias: z.string().max(200).optional(),
});

app.post("/:id/entries", async (c) => {
  const user = c.get("user");
  const body = addEntrySchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const alias = normalizedAliasOrError(body.data.alias);
  if ("error" in alias) return c.json(alias, 400);

  const result = await db.transaction(async (tx) => {
    const group = await lockOwnedGroup(tx, c.req.param("id"), user.id);
    if (!group) return { error: "group_not_found" as const };
    const selected = await resolveSelectableRoute(tx, user.id, body.data.catalogEntityId, body.data.providerModelKey, body.data.providerAccountId);
    if (!selected.route) return { error: selected.error! };
    const publicName = await validatePublicModelName(tx, group.id, body.data.catalogEntityId, alias.value);
    if ("error" in publicName) return publicName;
    const ids = await orderedEntryIds(tx, group.id);
    const [entry] = await tx.insert(schema.modelGroupEntries).values({
      id: nanoid(),
      groupId: group.id,
      modelId: selected.route.modelId,
      providerId: selected.route.providerId,
      catalogEntityId: body.data.catalogEntityId,
      providerModelKey: selected.route.providerModelKey,
      providerAccountId: selected.providerAccountId,
      alias: alias.value,
      enabled: true,
      position: ids.length,
    }).returning();
    return { entry };
  }).catch((error) => {
    const constraint = groupEntryConstraint(error);
    if (constraint) return { error: constraint };
    throw error;
  });
  if (!("entry" in result)) {
    const code = String("code" in result ? (result.code ?? "model_group_conflict") : (result.error ?? "model_group_conflict"));
    const message = "code" in result ? (result.error ?? code.replaceAll("_", " ")) : code.replaceAll("_", " ");
    const status = code === "group_not_found" || code === "catalog_model_not_found"
      || code === "provider_route_not_found" ? 404 : 409;
    return c.json({ error: message, code }, status);
  }
  return c.json(result.entry, 201);
});

const reorderEntriesSchema = z.object({ entryIds: z.array(z.string().min(1)).max(1_000) });
app.put("/:id/entries/reorder", async (c) => {
  const user = c.get("user");
  const body = reorderEntriesSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  if (new Set(body.data.entryIds).size !== body.data.entryIds.length) {
    return c.json({ error: "entryIds must not contain duplicates", code: "invalid_group_order" }, 400);
  }
  const result = await db.transaction(async (tx) => {
    const group = await lockOwnedGroup(tx, c.req.param("id"), user.id);
    if (!group) return "not_found" as const;
    const currentIds = await orderedEntryIds(tx, group.id);
    if (currentIds.length !== body.data.entryIds.length
      || currentIds.some((id) => !body.data.entryIds.includes(id))) return "stale" as const;
    await writeContiguousOrder(tx, group.id, body.data.entryIds);
    return "updated" as const;
  });
  if (result === "not_found") return c.json({ error: "Group not found", code: "group_not_found" }, 404);
  if (result === "stale") return c.json({ error: "Group entries changed; reload before reordering", code: "stale_group_order" }, 409);
  return c.json({ updated: true, entryIds: body.data.entryIds });
});

const updateEntrySchema = z.object({
  providerModelKey: z.string().min(1).optional(),
  providerAccountId: z.string().min(1).optional(),
  alias: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

app.put("/:id/entries/:entryId", async (c) => {
  const user = c.get("user");
  const body = updateEntrySchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const alias = body.data.alias === undefined ? null : normalizedAliasOrError(body.data.alias);
  if (alias && "error" in alias) return c.json(alias, 400);

  const result = await db.transaction(async (tx) => {
    const group = await lockOwnedGroup(tx, c.req.param("id"), user.id);
    if (!group) return { error: "group_not_found" as const };
    const [entry] = await tx.select().from(schema.modelGroupEntries)
      .where(and(
        eq(schema.modelGroupEntries.id, c.req.param("entryId")),
        eq(schema.modelGroupEntries.groupId, group.id),
      )).limit(1);
    if (!entry) return { error: "entry_not_found" as const };
    const updates: Partial<GroupEntry> = {};
    if (alias && "value" in alias) {
      const publicName = await validatePublicModelName(
        tx,
        group.id,
        entry.catalogEntityId ?? entry.modelId,
        alias.value,
        entry.id,
      );
      if ("error" in publicName) return publicName;
      updates.alias = alias.value;
    }
    if (body.data.enabled !== undefined) updates.enabled = body.data.enabled;
    if (body.data.providerModelKey !== undefined || body.data.providerAccountId !== undefined) {
      if (!entry.catalogEntityId) return { error: "entry_needs_review" as const };
      const selected = await resolveSelectableRoute(
        tx,
        user.id,
        entry.catalogEntityId,
        body.data.providerModelKey ?? entry.providerModelKey ?? "",
        body.data.providerAccountId ?? entry.providerAccountId ?? undefined,
      );
      if (!selected.route) return { error: selected.error! };
      updates.providerModelKey = selected.route.providerModelKey;
      updates.providerAccountId = selected.providerAccountId;
      updates.providerId = selected.route.providerId;
      updates.modelId = selected.route.modelId;
    }
    const [updated] = await tx.update(schema.modelGroupEntries).set(updates)
      .where(eq(schema.modelGroupEntries.id, entry.id)).returning();
    return { entry: updated };
  }).catch((error) => {
    const constraint = groupEntryConstraint(error);
    if (constraint) return { error: constraint };
    throw error;
  });
  if (!("entry" in result)) {
    const code = String("code" in result ? (result.code ?? "model_group_conflict") : (result.error ?? "model_group_conflict"));
    const message = "code" in result ? (result.error ?? code.replaceAll("_", " ")) : code.replaceAll("_", " ");
    const status = code === "group_not_found" || code === "entry_not_found"
      || code === "provider_route_not_found" ? 404 : 409;
    return c.json({ error: message, code }, status);
  }
  return c.json(result.entry);
});

app.delete("/:id/entries/:entryId", async (c) => {
  const user = c.get("user");
  const result = await db.transaction(async (tx) => {
    const group = await lockOwnedGroup(tx, c.req.param("id"), user.id);
    if (!group) return "group_not_found" as const;
    const rows = await tx.delete(schema.modelGroupEntries)
      .where(and(
        eq(schema.modelGroupEntries.id, c.req.param("entryId")),
        eq(schema.modelGroupEntries.groupId, group.id),
      )).returning({ id: schema.modelGroupEntries.id });
    if (!rows.length) return "entry_not_found" as const;
    await writeContiguousOrder(tx, group.id, await orderedEntryIds(tx, group.id));
    return "deleted" as const;
  });
  if (result === "group_not_found") return c.json({ error: "Group not found", code: result }, 404);
  if (result === "entry_not_found") return c.json({ error: "Entry not found", code: result }, 404);
  return c.json({ deleted: true });
});

export default app;
