import { db, schema } from "../db";
import { eq, and, sql } from "drizzle-orm";
import { renewOAuth } from "../services/oauth-lifecycle";
import { loadManifests, loadHandler } from "./manifest-loader";
import { decrypt, encrypt } from "../services/encryption";
import {
  parseProviderCredential,
  serializeOAuthCredential,
  type StoredOAuthCredential,
} from "../services/provider-credentials";
import {
  OAuthCredentialRefreshError,
  type ProviderManifest,
  type IProviderHandler,
  type OAuthCredential,
  type ProxyRequest,
  type RequestContext,
} from "./types";
import type { JsonObject } from "../gateway/protocol/v1/schemas";
import {
  buildProviderGatewayOperationUrl,
  resolveProviderGatewayOperation,
  type GatewayProviderOperationId,
} from "../gateway/provider-operation";
import { providerAuthHeaders } from "./auth-headers";
import { z } from "zod";
import { validatePublicHttpsEndpoint } from "../services/custom-endpoint";

export interface ResolvedProvider {
  manifest: ProviderManifest;
  handler: IProviderHandler | null;
  dbRecord: typeof schema.providers.$inferSelect;
}

const providerTypeSchema = z.enum(["openai-compatible", "anthropic-compatible", "custom"]);
const authTypeSchema = z.enum([
  "bearer",
  "header",
  "query",
  "oauth-device-flow",
  "oauth-pkce",
  "none",
]);
const stringRecordSchema = z.record(z.string());
const unknownRecordSchema = z.record(z.unknown());
const balanceParserSchema = z
  .object({
    path: z.string(),
    subtractPath: z.string().optional(),
    currency: z.string().optional(),
  })
  .strict();

function parseProviderType(value: unknown): ProviderManifest["type"] {
  const result = providerTypeSchema.safeParse(value);
  if (!result.success) throw new Error("Custom provider has an invalid provider type");
  return result.data;
}

function parseAuthType(value: unknown): ProviderManifest["auth"]["type"] {
  if (value == null) return "bearer";

  const result = authTypeSchema.safeParse(value);
  if (!result.success) throw new Error("Custom provider has an invalid authentication type");
  return result.data;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  const result = stringRecordSchema.safeParse(value);
  if (!result.success) throw new Error(`Custom provider has invalid ${field}`);
  return result.data;
}

function parseUnknownRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const result = unknownRecordSchema.safeParse(value);
  if (!result.success) throw new Error(`Custom provider has invalid ${field}`);
  return result.data;
}

function parseBalanceParser(value: unknown): NonNullable<ProviderManifest["balance"]>["parser"] | undefined {
  if (value == null) return undefined;
  const result = balanceParserSchema.safeParse(value);
  if (!result.success) throw new Error("Custom provider has an invalid balance parser");
  return result.data;
}

class ProviderRegistry {
  private providers = new Map<string, ResolvedProvider>();
  private manifestCatalog: ProviderManifest[] = [];
  private credentialRefreshes = new Map<string, Promise<string | null>>();

  private initialized = false;

  async initialize() {
    this.initialized = false;
    this.providers.clear();

    // Load manifests from YAML files as catalog (available providers)
    this.manifestCatalog = await loadManifests();
    const manifestMap = new Map(this.manifestCatalog.map((m) => [m.id, m]));

    // Load all DB providers (only these are "active")
    const dbProviders = await db.select().from(schema.providers);

    for (const dbProv of dbProviders) {
      // Find matching manifest by extracting ID from manifestPath
      const manifestId = dbProv.manifestPath
        ?.replace("providers.d/", "")
        .replace(".yaml", "")
        .replace(".yml", "");
      const manifest = manifestId ? manifestMap.get(manifestId) : null;

      let resolvedManifest: ProviderManifest;
      let dbRecord = dbProv;

      if (manifest) {
        // Update DB record from manifest to keep in sync
        [dbRecord] = await db
          .update(schema.providers)
          .set({
            name: manifest.name,
            type: manifest.type,
            baseUrl: manifest.baseUrl,
            authType: manifest.auth?.type || "bearer",
            authHeader: manifest.auth?.header,
            modelsEndpoint: manifest.endpoints?.models,
            extraHeaders: manifest.headers,
            handlerId: manifest.handler,
            handlerConfig: manifest.handlerConfig,
            balanceEndpoint: manifest.balance?.url,
            balanceParser: manifest.balance?.parser,
            balancePollInterval: manifest.balance?.pollInterval,
            updatedAt: new Date(),
          })
          .where(eq(schema.providers.id, dbProv.id))
          .returning();
        resolvedManifest = manifest;
      } else {
        // Custom/imported provider — reconstruct manifest from DB
        const balanceParser = parseBalanceParser(dbProv.balanceParser);
        resolvedManifest = {
          id: dbProv.id,
          name: dbProv.name,
          type: parseProviderType(dbProv.type),
          baseUrl: dbProv.baseUrl,
          auth: {
            type: parseAuthType(dbProv.authType),
            header: dbProv.authHeader || undefined,
          },
          endpoints: { models: dbProv.modelsEndpoint || undefined },
          headers: parseStringRecord(dbProv.extraHeaders, "extra headers"),
          handler: dbProv.handlerId || undefined,
          handlerConfig: parseUnknownRecord(dbProv.handlerConfig, "handler config"),
          balance:
            dbProv.balanceEndpoint && balanceParser
              ? {
                  url: dbProv.balanceEndpoint,
                  parser: balanceParser,
                  pollInterval: dbProv.balancePollInterval || undefined,
                }
              : undefined,
        };
      }

      // Load handler if specified
      let handler: IProviderHandler | null = null;
      if (resolvedManifest.handler) {
        handler = await loadHandler(resolvedManifest.handler);
      }

      this.providers.set(dbProv.id, { manifest: resolvedManifest, handler, dbRecord });
    }

    console.log(
      `[registry] ${this.providers.size} providers active, ${this.manifestCatalog.length} manifests available`
    );
    this.initialized = true;
  }

  isInitialized() {
    return this.initialized;
  }

  getProvider(id: string): ResolvedProvider | undefined {
    return this.providers.get(id);
  }

  async getProviderForAccount(
    providerId: string,
    accountId: string,
    userId: string
  ): Promise<ResolvedProvider | null> {
    const resolved = this.providers.get(providerId);
    if (!resolved) return null;
    const [account] = await db.select().from(schema.providerAccounts).where(and(
      eq(schema.providerAccounts.id, accountId),
      eq(schema.providerAccounts.userId, userId),
      eq(schema.providerAccounts.providerId, providerId),
      eq(schema.providerAccounts.status, "active")
    )).limit(1);
    if (!account) return null;
    const endpointMode = resolved.manifest.endpoint?.mode ?? "fixed";
    if (endpointMode === "fixed") return resolved;
    if (!account.baseUrl) return null;
    const baseUrl = await validatePublicHttpsEndpoint(account.baseUrl).catch(() => null);
    if (!baseUrl) return null;
    const discovery = resolved.manifest.models?.discovery;
    return {
      ...resolved,
      manifest: {
        ...resolved.manifest,
        baseUrl,
        models: resolved.manifest.models ? {
          ...resolved.manifest.models,
          discovery: discovery ? { ...discovery, url: undefined } : discovery,
        } : resolved.manifest.models,
      },
      dbRecord: { ...resolved.dbRecord, baseUrl },
    };
  }

  getAllProviders(): ResolvedProvider[] {
    return Array.from(this.providers.values());
  }

  getAvailableManifests(): ProviderManifest[] {
    return this.manifestCatalog;
  }

  async getProviderApiKey(providerId: string, userId: string, accountId?: string | null): Promise<string | null> {
    // 1. Check user's own key
    const [ownKey] = await db
      .select()
      .from(schema.providerKeys)
      .where(and(
        eq(schema.providerKeys.userId, userId),
        eq(schema.providerKeys.providerId, providerId),
        ...(accountId ? [eq(schema.providerKeys.providerAccountId, accountId)] : [])
      ))
      .limit(1);

    if (ownKey) {
      const parsed = parseProviderCredential(decrypt(ownKey.apiKeyEncrypted));
      if (parsed.kind === "api-key") return parsed.value;
      if (parsed.kind === "invalid-oauth2") {
        console.warn(
          `[credentials] Invalid OAuth credential envelope for provider ${providerId}`
        );
        return null;
      }

      const refreshKey = `${userId}:${providerId}:${accountId ?? ownKey.id}`;
      const existingRefresh = this.credentialRefreshes.get(refreshKey);
      if (existingRefresh) return existingRefresh;

      const refresh = this.resolveOAuthAccessToken(
        ownKey.id,
        providerId,
        parsed.value
      ).finally(() => {
        this.credentialRefreshes.delete(refreshKey);
      });
      this.credentialRefreshes.set(refreshKey, refresh);
      return refresh;
    }

    // Cross-user credential sharing is intentionally disabled until explicitly approved.
    return null;
  }

  async getProviderOAuthCredential(
    providerId: string,
    userId: string,
    accountId?: string | null
  ): Promise<StoredOAuthCredential | null> {
    const [ownKey] = await db
      .select()
      .from(schema.providerKeys)
      .where(and(
        eq(schema.providerKeys.userId, userId),
        eq(schema.providerKeys.providerId, providerId),
        ...(accountId ? [eq(schema.providerKeys.providerAccountId, accountId)] : [])
      ))
      .limit(1);
    if (!ownKey) return null;
    const parsed = parseProviderCredential(decrypt(ownKey.apiKeyEncrypted));
    return parsed.kind === "oauth2" ? parsed.value : null;
  }

  private async resolveOAuthAccessToken(
    keyId: string,
    providerId: string,
    _credential: StoredOAuthCredential
  ): Promise<string | null> {
    // Row locking serializes refresh across processes and reconnect/delete.
    // Re-read under the lock: the caller's pre-lock token may already be rotated.
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '20s'`);
      const [key] = await tx.select().from(schema.providerKeys)
        .where(eq(schema.providerKeys.id, keyId)).for("update").limit(1);
      if (!key) return null;
      const parsed = parseProviderCredential(decrypt(key.apiKeyEncrypted));
      if (parsed.kind !== "oauth2") return parsed.kind === "api-key" ? parsed.value : null;
      const resolved = this.providers.get(providerId);
      const refresh = resolved?.handler?.refreshOAuthCredential;
      const result = await renewOAuth(parsed.value, refresh && resolved
        ? (credential) => refresh.call(resolved.handler, resolved.manifest, credential)
        : undefined);
      if (result.updated) await tx.update(schema.providerKeys)
        .set({ apiKeyEncrypted: encrypt(JSON.stringify(result.updated)) })
        .where(eq(schema.providerKeys.id, keyId));
      return result.accessToken;
    });
  }

  async buildProxyRequest(
    req: ProxyRequest,
    ctx: RequestContext,
    providerApiKey: string,
    endpointOverride?: string,
    requestedOperation: GatewayProviderOperationId = "generate",
  ): Promise<{ url: string; headers: Record<string, string>; body: JsonObject }> {
    const resolved = this.providers.get(ctx.providerId);
    if (!resolved) throw new Error(`Provider ${ctx.providerId} not found`);

    const manifest = ctx.providerBaseUrl
      ? { ...resolved.manifest, baseUrl: ctx.providerBaseUrl }
      : resolved.manifest;
    const { handler } = resolved;

    // If handler has custom transform, use it
    if (handler?.transformRequest) {
      return handler.transformRequest(req, ctx, manifest);
    }

    const operation = requestedOperation === "generate"
      && req.stream === true
      && manifest.gateway?.operations.streamGenerate
      ? "streamGenerate"
      : requestedOperation;
    const declaration = resolveProviderGatewayOperation(manifest, operation);
    const explicitEndpoint = operation === "generate"
      ? endpointOverride ?? ctx.providerNativeEndpoint
      : undefined;
    const renderedExplicitEndpoint = explicitEndpoint?.replace(
      "{model}",
      encodeURIComponent((ctx.providerModelId || req.model).replace(/^models\//, "")),
    );
    if (renderedExplicitEndpoint?.includes("{model}")) {
      throw new Error(`Provider ${operation} endpoint requires a model`);
    }
    const url = renderedExplicitEndpoint
      ? `${manifest.baseUrl.replace(/\/$/, "")}${renderedExplicitEndpoint}`
      : buildProviderGatewayOperationUrl(
          manifest.baseUrl,
          manifest,
          operation,
          ctx.providerModelId || req.model,
        );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    Object.assign(headers, providerAuthHeaders(manifest, providerApiKey));

    // Apply extra headers
    if (manifest.headers) {
      Object.assign(headers, manifest.headers);
    }

    // Apply handler headers
    if (handler?.buildHeaders) {
      Object.assign(headers, handler.buildHeaders(ctx, manifest));
    }

    // Build body — use provider's model ID
    const body: JsonObject = declaration.format === "google-generate-content"
      ? Object.fromEntries(
          Object.entries(req).filter(([key]) => key !== "model" && key !== "stream"),
        ) as JsonObject
      : {
          ...req,
          model: ctx.providerModelId || req.model,
        };

    return { url, headers, body };
  }
}

export const registry = new ProviderRegistry();
