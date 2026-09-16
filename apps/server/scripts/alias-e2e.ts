import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { signJwt } from "../src/middleware/auth";
import {
  invalidateModelResolutionCache,
  listModelsForApiKey,
  resolveModel,
} from "../src/services/model-resolution";
import { drainUsageWrites } from "../src/services/usage-telemetry";

type JsonRecord = Record<string, any>;
type Candidate = {
  providerId: string;
  providerName: string;
  providerModelKey: string;
  catalogEntityId: string;
  modelId: string;
  providerModelId: string;
  supportsTools: boolean;
  supportsVision: boolean;
};
type CallResult = {
  name: string;
  providerId: string;
  model: string;
  status: number;
  gatewayEngine: string | null;
  shapeOk: boolean;
};

const baseUrl = (process.env.POINTER_E2E_BASE_URL || "http://127.0.0.1:4101").replace(/\/$/, "");
const userEmail = process.env.POINTER_E2E_USER_EMAIL || "admin@example.test";
const runProviderCalls = process.env.POINTER_E2E_PROVIDER_CALLS === "true";
const expectedProviderIds = (process.env.POINTER_E2E_PROVIDER_IDS
  || "openai-codex,openai,xai,deepinfra,fireworks,openrouter")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const modelOverrides: Record<string, string | undefined> = {
  "openai-codex": process.env.POINTER_E2E_CODEX_MODEL,
  fireworks: process.env.POINTER_E2E_FIREWORKS_MODEL,
  openrouter: process.env.POINTER_E2E_OPENROUTER_MODEL,
};

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");

const preferredModels: Record<string, string[]> = {
  "openai-codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
  openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-nano"],
  xai: ["grok-4.20-0309-non-reasoning", "grok-4.5", "grok-4.3"],
  deepinfra: [
    "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    "google/gemini-3.1-flash-lite",
    "ByteDance/Seed-2.0-mini",
  ],
  fireworks: [
    "accounts/fireworks/models/gpt-oss-120b",
    "accounts/fireworks/models/deepseek-v4-pro",
    "accounts/fireworks/models/glm-5p2",
  ],
  openrouter: [
    "meta-llama/llama-3.1-8b-instruct",
    "anthropic/claude-3-haiku",
    "google/gemini-2.5-flash",
  ],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

async function requestJson(
  path: string,
  init: RequestInit,
  expectedStatus: number | number[],
): Promise<{ response: Response; body: JsonRecord }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const accepted = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const text = await response.text();
  let body: JsonRecord = {};
  if (text) {
    try {
      body = safeRecord(JSON.parse(text));
    } catch {
      body = {};
    }
  }
  if (!accepted.includes(response.status)) {
    throw new Error(`${init.method || "GET"} ${path} returned HTTP ${response.status}`);
  }
  return { response, body };
}

function jwtHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function keyHeaders(apiKey: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function chooseCandidate(rows: Candidate[], providerId: string): Candidate | null {
  const available = rows.filter((row) => row.providerId === providerId);
  if (available.length === 0) return null;
  const override = modelOverrides[providerId]?.trim();
  if (override) {
    const exact = available.find((row) => row.modelId === override);
    if (!exact) throw new Error(`Requested E2E model override is unavailable for ${providerId}`);
    return exact;
  }
  for (const preferred of preferredModels[providerId] || []) {
    const exact = available.find((row) => row.modelId === preferred);
    if (exact) return exact;
  }
  return available.find((row) => !/(audio|embedding|image|moderation|realtime|transcri|tts|video)/i.test(row.modelId))
    || available[0]
    || null;
}

function aliasFor(providerId: string) {
  return `e2e-${providerId}`;
}

async function callGateway(
  name: string,
  providerId: string,
  model: string,
  path: string,
  apiKey: string,
  body: JsonRecord,
  extraHeaders: Record<string, string> = {},
  validate: (body: JsonRecord, response: Response) => boolean = () => true,
): Promise<CallResult> {
  const { response, body: responseBody } = await requestJson(path, {
    method: "POST",
    headers: keyHeaders(apiKey, extraHeaders),
    body: JSON.stringify(body),
  }, 200);
  return {
    name,
    providerId,
    model,
    status: response.status,
    gatewayEngine: response.headers.get("x-pointer-gateway-engine"),
    shapeOk: validate(responseBody, response),
  };
}

async function callGatewayStream(
  name: string,
  providerId: string,
  model: string,
  path: string,
  apiKey: string,
  body: JsonRecord,
  extraHeaders: Record<string, string>,
  validate: (events: JsonRecord[], raw: string) => boolean,
): Promise<CallResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: keyHeaders(apiKey, extraHeaders),
    body: JSON.stringify({ ...body, stream: true }),
  });
  const raw = await response.text();
  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => {
      const value = line.slice(6);
      if (value === "[DONE]") return [];
      try {
        return [safeRecord(JSON.parse(value))];
      } catch {
        return [];
      }
    });
  return {
    name,
    providerId,
    model,
    status: response.status,
    gatewayEngine: response.headers.get("x-pointer-gateway-engine"),
    shapeOk: response.ok && validate(events, raw),
  };
}

async function disposableInstanceExists(instanceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.instances.id })
    .from(schema.instances)
    .where(eq(schema.instances.id, instanceId))
    .limit(1);
  return rows.length > 0;
}

async function disposableGroupExists(groupId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.modelGroups.id })
    .from(schema.modelGroups)
    .where(eq(schema.modelGroups.id, groupId))
    .limit(1);
  return rows.length > 0;
}

async function forceCleanupDisposable(instanceId: string, apiKeyId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const keyRows = await tx
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.instanceId, instanceId));
    const keyIds = keyRows.map((row) => row.id);
    if (apiKeyId && !keyIds.includes(apiKeyId)) keyIds.push(apiKeyId);
    for (const keyId of keyIds) {
      await tx
        .update(schema.usageLogs)
        .set({ apiKeyId: null })
        .where(eq(schema.usageLogs.apiKeyId, keyId));
    }
    await tx
      .delete(schema.instances)
      .where(eq(schema.instances.id, instanceId));
  });
}

async function main() {
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(eq(schema.users.email, userEmail))
    .limit(1);
  assert(user, "E2E user not found");

  const providerRows = await db
    .select({
      providerId: schema.providers.id,
      providerName: schema.providers.name,
      providerModelKey: schema.providerModels.id,
      catalogEntityId: schema.providerModels.catalogEntityId,
      modelId: schema.providerModels.modelId,
      providerModelId: schema.providerModels.providerModelId,
      supportsTools: schema.providerModels.supportsTools,
      supportsVision: schema.providerModels.supportsVision,
    })
    .from(schema.providers)
    .innerJoin(schema.providerKeys, and(
      eq(schema.providerKeys.providerId, schema.providers.id),
      eq(schema.providerKeys.userId, user.id),
    ))
    .innerJoin(schema.providerModels, eq(schema.providerModels.providerId, schema.providers.id))
    .where(eq(schema.providers.status, "active"));

  const candidates = expectedProviderIds
    .map((providerId) => chooseCandidate(providerRows
      .filter((row): row is typeof row & { catalogEntityId: string } => Boolean(row.catalogEntityId))
      .map((row) => ({
        ...row,
        supportsTools: row.supportsTools === true,
        supportsVision: row.supportsVision === true,
      })), providerId))
    .filter((candidate): candidate is Candidate => candidate !== null);
  assert(candidates.length >= 3, "At least three configured active providers with models are required");
  assert(candidates[0]?.providerId === "openai-codex", "Codex must be the first E2E group route");

  const token = await signJwt(user);
  let groupId: string | null = null;
  let instanceId: string | null = null;
  let apiKeyId: string | null = null;
  let rawApiKey: string | null = null;
  const callResults: CallResult[] = [];
  const callFailures: Array<{ name: string; providerId: string; model: string; error: string }> = [];

  try {
    const createdGroup = await requestJson("/api/groups", {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({ name: `Alias E2E ${Date.now()}` }),
    }, 201);
    groupId = String(createdGroup.body.id);

    await requestJson(`/api/groups/${groupId}/entries`, {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({
        catalogEntityId: candidates[0]!.catalogEntityId,
        providerModelKey: candidates[0]!.providerModelKey,
        alias: "opus",
      }),
    }, 400);

    for (const candidate of candidates) {
      await requestJson(`/api/groups/${groupId}/entries`, {
        method: "POST",
        headers: jwtHeaders(token),
        body: JSON.stringify({
          catalogEntityId: candidate.catalogEntityId,
          providerModelKey: candidate.providerModelKey,
          alias: aliasFor(candidate.providerId),
        }),
      }, 201);
    }

    await requestJson(`/api/groups/${groupId}/entries`, {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({
        catalogEntityId: candidates[0]!.catalogEntityId,
        providerModelKey: candidates[0]!.providerModelKey,
      }),
    }, 409);

    const initialGroup = await requestJson(`/api/groups/${groupId}`, {
      headers: jwtHeaders(token),
    }, 200);
    const initialEntries = initialGroup.body.entries as JsonRecord[];
    assert(initialEntries.length === candidates.length, "Group entry count mismatch");
    assert(initialEntries.every((entry, index) => entry.position === index), "Initial positions are not contiguous");

    const reversedIds = initialEntries.map((entry) => String(entry.id)).reverse();
    await requestJson(`/api/groups/${groupId}/entries/reorder`, {
      method: "PUT",
      headers: jwtHeaders(token),
      body: JSON.stringify({ entryIds: reversedIds }),
    }, 200);
    const reversedGroup = await requestJson(`/api/groups/${groupId}`, {
      headers: jwtHeaders(token),
    }, 200);
    assert(
      (reversedGroup.body.entries as JsonRecord[]).every(
        (entry, index) => entry.id === reversedIds[index] && entry.position === index,
      ),
      "Atomic reverse order was not persisted",
    );

    await requestJson(`/api/groups/${groupId}/entries/reorder`, {
      method: "PUT",
      headers: jwtHeaders(token),
      body: JSON.stringify({ entryIds: reversedIds.slice(1) }),
    }, 409);

    const finalIds = candidates.map((candidate) => {
      const entry = initialEntries.find((row) => row.providerId === candidate.providerId);
      assert(entry, `Missing entry for ${candidate.providerId}`);
      return String(entry.id);
    });
    await requestJson(`/api/groups/${groupId}/entries/reorder`, {
      method: "PUT",
      headers: jwtHeaders(token),
      body: JSON.stringify({ entryIds: finalIds }),
    }, 200);

    const secondEntryId = finalIds[1]!;
    await requestJson(`/api/groups/${groupId}/entries/${secondEntryId}`, {
      method: "PUT",
      headers: jwtHeaders(token),
      body: JSON.stringify({ enabled: false }),
    }, 200);
    const disabledGroup = await requestJson(`/api/groups/${groupId}`, {
      headers: jwtHeaders(token),
    }, 200);
    assert(
      (disabledGroup.body.entries as JsonRecord[]).every((entry, index) => entry.position === index),
      "Disabling an entry changed stored positions",
    );
    await requestJson(`/api/groups/${groupId}/entries/${secondEntryId}`, {
      method: "PUT",
      headers: jwtHeaders(token),
      body: JSON.stringify({ enabled: true }),
    }, 200);

    const createdInstance = await requestJson("/api/instances", {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({ name: `Alias E2E ${Date.now()}`, modelGroupId: groupId }),
    }, 201);
    instanceId = String(createdInstance.body.id);

    await requestJson(`/api/instances/${instanceId}/models`, {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({
        modelId: candidates[0]!.modelId,
        providerId: candidates[0]!.providerId,
        alias: "haiku",
      }),
    }, 400);

    const createdKey = await requestJson("/api/keys", {
      method: "POST",
      headers: jwtHeaders(token),
      body: JSON.stringify({ instanceId, name: "Alias E2E disposable", allowedModels: ["*"] }),
    }, 201);
    apiKeyId = String(createdKey.body.id);
    rawApiKey = String(createdKey.body.key);
    assert(rawApiKey.startsWith("ptr_"), "Disposable Pointer key was not returned");

    const modelList = await requestJson("/v1/models", {
      headers: keyHeaders(rawApiKey),
    }, 200);
    const advertised = (modelList.body.data as JsonRecord[]).map((entry) => String(entry.id).toLowerCase());
    const hidden = ["big", "opus", "default", "medium", "sonnet", "secondary", "small", "haiku", "utility"];
    assert(hidden.every((name) => !advertised.includes(name)), "A hidden role alias was advertised");
    assert(candidates.every((candidate) => advertised.includes(aliasFor(candidate.providerId))), "A visible manual alias was not advertised");

    invalidateModelResolutionCache(instanceId);
    const apiKeyContext = {
      id: apiKeyId,
      userId: user.id,
      instanceId,
      allowedModels: ["*"],
      fallbackProviderId: null,
    };
    const roles = [
      ["big", "opus", "default"],
      ["medium", "sonnet", "secondary"],
      ["small", "haiku", "utility"],
    ];
    for (const [slot, aliases] of roles.entries()) {
      for (const hiddenAlias of aliases!) {
        const resolved = await resolveModel(hiddenAlias, apiKeyContext);
        assert(resolved?.providerId === candidates[slot]?.providerId, `${hiddenAlias} resolved to the wrong provider`);
        assert(resolved?.modelId === candidates[slot]?.modelId, `${hiddenAlias} resolved to the wrong model`);
      }
    }
    const internalAdvertised = await listModelsForApiKey(apiKeyContext);
    assert(
      internalAdvertised.every((entry) => !hidden.includes(entry.displayName.toLowerCase())),
      "Internal discovery included a hidden role alias",
    );

    if (runProviderCalls) {
      for (const candidate of candidates) {
        const name = `chat:${candidate.providerId}`;
        try {
          const result = await callGateway(
            name,
            candidate.providerId,
            aliasFor(candidate.providerId),
            "/v1/chat/completions",
            rawApiKey,
            {
              model: aliasFor(candidate.providerId),
              messages: [{ role: "user", content: "Reply with OK." }],
              max_tokens: 16,
            },
            {},
            (body) => Array.isArray(body.choices),
          );
          callResults.push(result);
          if (!result.shapeOk) throw new Error("unexpected response shape");
        } catch (error) {
          callFailures.push({
            name,
            providerId: candidate.providerId,
            model: aliasFor(candidate.providerId),
            error: error instanceof Error ? error.message : "unknown failure",
          });
        }
      }

      const codex = candidates[0]!;
      const translatedTargets = [
        {
          name: "responses:opus-to-codex",
          providerId: codex.providerId,
          model: "opus",
          path: "/v1/responses",
          body: { model: "opus", input: "Reply with OK.", max_output_tokens: 16 },
          headers: {},
          validate: (body: JsonRecord) => Array.isArray(body.output),
        },
        {
          name: "messages:opus-to-codex",
          providerId: codex.providerId,
          model: "opus",
          path: "/v1/messages",
          body: {
            model: "opus",
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK." }],
          },
          headers: {
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "context-management-2025-06-27",
          },
          validate: (body: JsonRecord) => Array.isArray(body.content),
        },
        {
          name: "messages:sonnet-to-second-provider",
          providerId: candidates[1]!.providerId,
          model: "sonnet",
          path: "/v1/messages",
          body: {
            model: "sonnet",
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK." }],
          },
          headers: {
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "context-management-2025-06-27",
          },
          validate: (body: JsonRecord) => Array.isArray(body.content),
        },
        {
          name: "messages:haiku-to-third-provider",
          providerId: candidates[2]!.providerId,
          model: "haiku",
          path: "/v1/messages",
          body: {
            model: "haiku",
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK." }],
          },
          headers: { "anthropic-version": "2023-06-01" },
          validate: (body: JsonRecord) => Array.isArray(body.content),
        },
        {
          name: "responses:utility-to-third-provider",
          providerId: candidates[2]!.providerId,
          model: "utility",
          path: "/v1/responses",
          body: { model: "utility", input: "Reply with OK.", max_output_tokens: 16 },
          headers: {},
          validate: (body: JsonRecord) => Array.isArray(body.output),
        },
      ];
      for (const target of translatedTargets) {
        try {
          const result = await callGateway(
            target.name,
            target.providerId,
            target.model,
            target.path,
            rawApiKey,
            target.body,
            target.headers,
            target.validate,
          );
          callResults.push(result);
          if (!result.shapeOk) throw new Error("unexpected response shape");
        } catch (error) {
          callFailures.push({
            name: target.name,
            providerId: target.providerId,
            model: target.model,
            error: error instanceof Error ? error.message : "unknown failure",
          });
        }
      }

      try {
        const result = await callGateway(
          "tool:big-to-codex",
          codex.providerId,
          "big",
          "/v1/chat/completions",
          rawApiKey,
          {
            model: "big",
            messages: [{ role: "user", content: "Call the echo_value tool with value 7." }],
            max_tokens: 64,
            tools: [{
              type: "function",
              function: {
                name: "echo_value",
                description: "Echo an integer",
                parameters: {
                  type: "object",
                  properties: { value: { type: "integer" } },
                  required: ["value"],
                  additionalProperties: false,
                },
              },
            }],
            tool_choice: { type: "function", function: { name: "echo_value" } },
          },
          {},
          (body) => Array.isArray(body.choices?.[0]?.message?.tool_calls)
            && body.choices[0].message.tool_calls.length > 0,
        );
        callResults.push(result);
        if (!result.shapeOk) throw new Error("tool call was not returned");
      } catch (error) {
        callFailures.push({
          name: "tool:big-to-codex",
          providerId: codex.providerId,
          model: "big",
          error: error instanceof Error ? error.message : "unknown failure",
        });
      }

      try {
        const result = await callGateway(
          "image:default-to-codex",
          codex.providerId,
          "default",
          "/v1/chat/completions",
          rawApiKey,
          {
            model: "default",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Name the dominant color in one word." },
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAA1BMVEX/AAAZ4gk3AAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGMxat3AAAAAElFTkSuQmCC",
                  },
                },
              ],
            }],
            max_tokens: 16,
          },
          {},
          (body) => Array.isArray(body.choices),
        );
        callResults.push(result);
        if (!result.shapeOk) throw new Error("image response shape was invalid");
      } catch (error) {
        callFailures.push({
          name: "image:default-to-codex",
          providerId: codex.providerId,
          model: "default",
          error: error instanceof Error ? error.message : "unknown failure",
        });
      }

      const streamTargets = [
        {
          name: "stream-chat:opus-to-codex",
          path: "/v1/chat/completions",
          body: {
            model: "opus",
            messages: [{ role: "user", content: "Reply with OK." }],
            max_tokens: 16,
          },
          headers: {},
          validate: (events: JsonRecord[], raw: string) =>
            raw.includes("[DONE]")
            && events.some((event) => Array.isArray(event.choices))
            && events.every((event) => event.error === undefined),
        },
        {
          name: "stream-responses:opus-to-codex",
          path: "/v1/responses",
          body: { model: "opus", input: "Reply with OK.", max_output_tokens: 16 },
          headers: {},
          validate: (events: JsonRecord[]) =>
            events.some((event) => event.type === "response.completed")
            && events.every((event) => event.type !== "error"),
        },
        {
          name: "stream-messages:opus-to-codex",
          path: "/v1/messages",
          body: {
            model: "opus",
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with OK." }],
          },
          headers: {
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "context-management-2025-06-27",
          },
          validate: (events: JsonRecord[]) =>
            events.some((event) => event.type === "message_start")
            && events.some((event) => event.type === "message_stop")
            && events.every((event) => event.type !== "error"),
        },
      ];
      for (const target of streamTargets) {
        try {
          const result = await callGatewayStream(
            target.name,
            codex.providerId,
            "opus",
            target.path,
            rawApiKey,
            target.body,
            target.headers,
            target.validate,
          );
          callResults.push(result);
          if (!result.shapeOk) throw new Error(`stream returned HTTP ${result.status} or invalid SSE`);
        } catch (error) {
          callFailures.push({
            name: target.name,
            providerId: codex.providerId,
            model: "opus",
            error: error instanceof Error ? error.message : "unknown failure",
          });
        }
      }
    }

    console.log(JSON.stringify({
      management: {
        reservedAliasRejected: true,
        reservedInstanceAliasRejected: true,
        duplicateRejected: true,
        staleReorderRejected: true,
        contiguousPositions: true,
        hiddenAliasesResolved: true,
        hiddenAliasesAdvertised: false,
      },
      selectedProviders: candidates.map((candidate, index) => ({
        position: index + 1,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        supportsTools: candidate.supportsTools,
        supportsVision: candidate.supportsVision,
      })),
      providerCallsEnabled: runProviderCalls,
      calls: callResults,
      failures: callFailures,
    }, null, 2));

    assert(callFailures.length === 0, `${callFailures.length} provider E2E call(s) failed`);
  } finally {
    await drainUsageWrites();
    if (instanceId) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await requestJson(`/api/instances/${instanceId}`, {
          method: "DELETE",
          headers: jwtHeaders(token),
        }, [200, 404]).catch(() => undefined);
        if (!(await disposableInstanceExists(instanceId))) break;
        await Bun.sleep(250);
      }
      if (await disposableInstanceExists(instanceId)) {
        await forceCleanupDisposable(instanceId, apiKeyId);
      }
      await db
        .delete(schema.usageLogs)
        .where(eq(schema.usageLogs.instanceId, instanceId));
    }
    if (groupId) {
      await requestJson(`/api/groups/${groupId}`, {
        method: "DELETE",
        headers: jwtHeaders(token),
      }, [200, 404]).catch(() => undefined);
      if (await disposableGroupExists(groupId)) {
        await db
          .delete(schema.modelGroups)
          .where(eq(schema.modelGroups.id, groupId));
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Alias E2E failed");
    process.exit(1);
  });
