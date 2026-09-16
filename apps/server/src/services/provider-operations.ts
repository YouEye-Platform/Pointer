import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db";
import { registry } from "../providers/registry";

export async function refreshProviderBalance(userId: string, providerId: string) {
  const [[provider], [key], [previous]] = await Promise.all([
    db.select().from(schema.providers).where(eq(schema.providers.id, providerId)).limit(1),
    db.select().from(schema.providerKeys).where(and(eq(schema.providerKeys.userId, userId), eq(schema.providerKeys.providerId, providerId))).limit(1),
    db.select().from(schema.providerOperationalStates).where(and(eq(schema.providerOperationalStates.userId, userId), eq(schema.providerOperationalStates.providerId, providerId))).limit(1),
  ]);
  if (!provider) return { httpStatus: 404, body: { error: "Provider not found" } };
  if (!provider.balanceEndpoint || !provider.balanceParser) return { httpStatus: 200, body: { supported: false, reason: "not_supported" } };
  if (!key) return { httpStatus: 400, body: { supported: true, status: "unavailable", reason: "credential_missing" } };
  const resolved = registry.getProvider(providerId);
  const apiKey = await registry.getProviderApiKey(providerId, userId);
  if (!apiKey) {
    return {
      httpStatus: 400,
      body: {
        supported: true,
        status: "unavailable",
        reason: "credential_expired",
      },
    };
  }
  const headers: Record<string, string> = { ...(resolved?.manifest.headers || {}) };
  if (provider.type === "anthropic-compatible") {
    headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01";
  } else headers[provider.authHeader || "Authorization"] = `Bearer ${apiKey}`;
  const id = `${userId}:${providerId}`;
  const fail = async (reason: string, upstreamStatus?: number) => {
    await db.insert(schema.providerOperationalStates).values({ id, userId, providerId, balanceStatus: "error", balanceError: reason }).onConflictDoUpdate({ target: [schema.providerOperationalStates.userId, schema.providerOperationalStates.providerId], set: { balanceStatus: "error", balanceError: reason } });
    return { httpStatus: 502, body: { supported: true, status: "error", reason, upstreamStatus, previousValue: previous?.balance == null ? null : Number(previous.balance), updatedAt: previous?.balanceUpdatedAt ?? null } };
  };
  try {
    const response = await fetch(provider.balanceEndpoint, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return fail(`upstream_${response.status}`, response.status);
    const data: any = await response.json();
    const parser = provider.balanceParser as { path?: string; subtractPath?: string; currency?: string };
    const read = (path?: string) => path?.split(".").reduce((value: any, part) => value?.[part], data);
    const value = Number(read(parser.path)) - (parser.subtractPath ? Number(read(parser.subtractPath)) : 0);
    if (!Number.isFinite(value)) return fail("invalid_upstream_payload");
    const updatedAt = new Date(); const currency = parser.currency || "USD";
    await db.insert(schema.providerOperationalStates).values({ id, userId, providerId, balance: String(value), balanceCurrency: currency, balanceStatus: "fresh", balanceError: null, balanceUpdatedAt: updatedAt }).onConflictDoUpdate({ target: [schema.providerOperationalStates.userId, schema.providerOperationalStates.providerId], set: { balance: String(value), balanceCurrency: currency, balanceStatus: "fresh", balanceError: null, balanceUpdatedAt: updatedAt } });
    return { httpStatus: 200, body: { supported: true, status: "fresh", value, currency, updatedAt } };
  } catch (error) { return fail(error instanceof Error ? error.name : "unknown"); }
}

export async function refreshSupportedBalances() {
  const rows = await db.select({ userId: schema.providerKeys.userId, providerId: schema.providerKeys.providerId, pollInterval: schema.providers.balancePollInterval })
    .from(schema.providerKeys).innerJoin(schema.providers, eq(schema.providers.id, schema.providerKeys.providerId))
    .where(isNotNull(schema.providers.balanceEndpoint));
  const results = await Promise.allSettled(rows.map((row) => refreshProviderBalance(row.userId, row.providerId)));
  return { attempted: rows.length, failed: results.filter((result) => result.status === "rejected").length };
}

export async function refreshProviderAccount(userId: string, providerId: string, providerAccountId?: string | null) {
  const resolved = registry.getProvider(providerId);
  if (!resolved) return { httpStatus: 404, body: { error: "Provider not found" } };
  if (!resolved.handler?.getAccountInfo) return { httpStatus: 200, body: { supported: false, reason: "not_supported" } };
  const apiKey = await registry.getProviderApiKey(providerId, userId, providerAccountId);
  if (!apiKey) return { httpStatus: 400, body: { supported: true, status: "unavailable", reason: "credential_missing" } };
  const id = `${userId}:${providerId}`;
  const [previous] = await db.select().from(schema.providerOperationalStates).where(and(eq(schema.providerOperationalStates.userId, userId), eq(schema.providerOperationalStates.providerId, providerId))).limit(1);
  try {
    const oauthCredential = await registry.getProviderOAuthCredential(
      providerId,
      userId,
      providerAccountId
    );
    const data = await resolved.handler.getAccountInfo(
      apiKey,
      resolved.manifest,
      oauthCredential ?? undefined
    );
    const updatedAt = new Date();
    await db.insert(schema.providerOperationalStates).values({ id, userId, providerId, accountData: data, accountStatus: "fresh", accountError: null, accountUpdatedAt: updatedAt }).onConflictDoUpdate({ target: [schema.providerOperationalStates.userId, schema.providerOperationalStates.providerId], set: { accountData: data, accountStatus: "fresh", accountError: null, accountUpdatedAt: updatedAt } });
    return { httpStatus: 200, body: { supported: true, status: "fresh", data, updatedAt } };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    await db.insert(schema.providerOperationalStates).values({ id, userId, providerId, accountStatus: "error", accountError: reason }).onConflictDoUpdate({ target: [schema.providerOperationalStates.userId, schema.providerOperationalStates.providerId], set: { accountStatus: "error", accountError: reason } });
    return { httpStatus: 502, body: { supported: true, status: "error", reason, previousValue: previous?.accountData ?? null, updatedAt: previous?.accountUpdatedAt ?? null } };
  }
}

export async function refreshSupportedAccounts() {
  const rows = await db.select({ userId: schema.providerKeys.userId, providerId: schema.providerKeys.providerId }).from(schema.providerKeys);
  const supported = rows.filter((row) => registry.getProvider(row.providerId)?.handler?.getAccountInfo);
  const results = await Promise.allSettled(supported.map((row) => refreshProviderAccount(row.userId, row.providerId)));
  return { attempted: supported.length, failed: results.filter((result) => result.status === "rejected").length };
}
