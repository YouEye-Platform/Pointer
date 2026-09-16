# HTTP API reference

Four auth schemes:

- **standalone `/api/*`** management endpoints → `Authorization: Bearer <JWT>` (from register/login).
- **managed `/api/*`** management endpoints → short-lived host platform assertion with route permission.
- **`/v1/*`** proxy endpoints → `Authorization: Bearer ptr_…` (an API key). Anthropic-style clients
  may send the same key as `x-api-key`.
- **`/v1beta/*`** Google inference endpoints → `x-goog-api-key: ptr_…`. Query-string keys are not
  accepted.

`/api/*` responses are gzip-compressed (unless `DISABLE_COMPRESSION=true`); `/v1/*` never is.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Process, surface and build identity — no auth |
| GET | `/readyz` | Dependency/readiness report — no auth, no secrets or billable provider request |
| GET | `/.well-known/pointer` | Deployment mode, local-auth availability, listener surface and contract versions — no auth |

## Managed platform — `/api/platform/v1`

These routes exist only on the managed management listener and require the
host platform assertion described in
[managed-platform.md](./managed-platform.md). Every mutation requires
`Idempotency-Key`; request bodies are limited to 65,536 bytes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/capabilities` | Contract, protocol, listener and build capabilities |
| GET | `/groups?owner=service\|actor` | Service-principal or exact assertion-actor groups with availability and linkage summaries |
| GET | `/installations` | Cursor-paginated installations with optional state filter |
| PUT | `/installations/:externalInstallationId` | Ensure/reconcile one installation; may deliver its initial credential |
| GET | `/installations/:externalInstallationId` | Safe current state, previews, group health and drift |
| PATCH | `/installations/:externalInstallationId/group` | Reassign the live group without replacing instance/key |
| POST | `/installations/:externalInstallationId/routing-owner/takeover` | Explicitly transfer actor routing and select one of the new owner's groups |
| POST | `/installations/:externalInstallationId/disable` | Stop inference without destroying attribution |
| POST | `/installations/:externalInstallationId/enable` | Resume a consistent disabled installation |
| PUT | `/actors/current/state` | Disable or restore the exact assertion actor and report affected installations |
| PUT | `/actors/state` | Service-authority lifecycle hook for an exact external actor subject, including idempotent absence |
| POST | `/installations/:externalInstallationId/credential-deliveries/:deliveryId/ack` | Purge a securely stored delivery |
| POST | `/installations/:externalInstallationId/rotations` | Prepare an overlapping replacement credential |
| POST | `/installations/:externalInstallationId/rotations/:rotationId/commit` | Activate an acknowledged replacement and retire the old key |
| POST | `/installations/:externalInstallationId/rotations/:rotationId/abort` | Revoke the pending key and preserve the old key |
| DELETE | `/installations/:externalInstallationId` | Archive and revoke while preserving history |

The normative paths, schemas, security scheme, and stable error envelope are in
[platform-api.v1.openapi.yaml](./contracts/platform-api.v1.openapi.yaml).
Generated TypeScript types live in
`apps/server/src/generated/platform-api-v1.ts`.

## Auth — `/api/auth`

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/register` | `{ email, password, name }` | `{ token, user }` — first user becomes `admin`; auto-creates a default group |
| POST | `/login` | `{ email, password }` | `{ token, user }` |
| GET | `/me` | — (JWT) | `{ id, email, name, role }` |

## Providers — `/api/providers` (JWT)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/` | List active providers (`+ hasOwnKey, modelCount`); the count includes only routes linked to the active catalog generation |
| GET | `/manifests` | Available manifest catalog |
| POST | `/from-manifest` | `{ manifestId, apiKey?, label?, baseUrl? }` — creates another account; OAuth manifests omit the key; custom endpoints are public HTTPS only |
| POST | `/import` | `{ yaml }` — import a custom manifest |
| GET | `/:id` | Provider detail incl. current active-generation models |
| DELETE | `/:id` | Remove provider (cascades keys) |
| POST | `/:id/keys` | `{ apiKey, label }` — add/update key |
| PUT | `/:id/keys/label` | `{ label }` — rename key |
| DELETE | `/:id/keys` | Remove key |
| POST | `/:id/oauth/device/start` | `{ providerAccountId? }` — start device authorization; account is required when several exist |
| POST | `/:id/oauth/device/:flowId/poll` | Poll once, respecting the provider interval; stores encrypted OAuth credentials on success |
| DELETE | `/:id/oauth/device/:flowId` | Cancel the authenticated user's pending flow |
| GET | `/:id/models` | Current active-generation models for the provider |
| POST | `/:id/sync` | Re-sync the provider's complete metadata-only model inventory; returns `{ synced }` |
| POST | `/:id/test` | Test the stored key against the same metadata-only inventory contract used by refresh |

Provider detail returns a safe `auth` capability object and credential presence/type, never a raw
API key, access token, refresh token, or device code. See
[subscription-providers.md](./subscription-providers.md).

Model sync and generic provider connection testing make GET model-list requests only. They never
send a prompt or call a generation endpoint. Paginated providers must complete every page before
the inventory can replace last-known-good reconciliation input. Provider-specific endpoints and
eligibility rules are documented in [model-discovery.md](./model-discovery.md).
Historical provider rows remain stored for reconciliation and audit, but
provider counts, detail/list results, test targets, and runtime routing exclude
rows not linked to the active catalog generation.

## Provider accounts — `/api/provider-accounts` (JWT or actor-scoped managed assertion)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/` | List only the caller's accounts with safe provider metadata and `credentialConfigured`; never returns credentials |
| POST | `/` | `{ providerId, nickname, apiKey, baseUrl? }` |
| PUT | `/:id` | `{ nickname?, apiKey?, baseUrl?, status? }` |
| DELETE | `/:id` | Delete an owned account; returns 409 while a group route references it |
| POST | `/:id/test` | Metadata-only connection test for this exact account |
| POST | `/:id/sync` | Synchronize models through this exact account |

Nicknames are unique per user but not globally. A user may create any number
of accounts for one provider. Custom endpoint URLs reject credentials, query
strings, fragments, loopback, private, link-local, carrier-grade NAT,
documentation, metadata, multicast, and other non-global addresses. Stored
custom endpoints are revalidated before provider use.

## Instances — `/api/instances` (JWT)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/` | List the user's instances |
| POST | `/` | `{ name, icon?, color?, modelGroupId? }` (defaults to your default group) |
| GET | `/:id` | Instance + models + keys + linked group entries |
| PUT | `/:id` | `{ name?, icon?, color?, modelGroupId? }` |
| DELETE | `/:id` | Delete (cascades its keys) |
| POST | `/:id/models` | `{ modelId, providerId, alias?, enabled?, isDefault?, source? }` |
| PUT | `/:id/models/:mid` | `{ alias?, priority?, enabled? }` |
| DELETE | `/:id/models/:mid` | Remove a model |
| POST | `/:id/provider-models` | `{ providerId, models: string[] }` — batch add provider-toggled |
| DELETE | `/:id/provider-models` | `{ providerId, models?: string[] }` — batch remove |

> Instance-model sub-routes verify instance ownership (a hardening over v05).
> Manual instance-model aliases are trimmed, limited to 200 characters, and cannot claim a hidden
> positional alias.

## API keys — `/api/keys` (JWT)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/` | List keys (previews only — never the raw key or hash) |
| POST | `/` | `{ instanceId, name?, allowedModels?, fallbackProviderId? }` → `{ id, key, keyPreview }` (raw key shown **once**) |
| DELETE | `/:id` | Revoke (soft delete) |

## Model groups — `/api/groups` (JWT)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/` | List groups (ordered by position) |
| POST | `/` | `{ name, isDefault? }` |
| GET | `/default` | The default group + entries (auto-creates if missing) |
| GET | `/:id` | Group + entries |
| PUT | `/:id` | `{ name?, position? }` |
| PUT | `/:id/set-default` | Make this the default group |
| DELETE | `/:id` | Delete (blocked for the default group) |
| GET | `/:id/entries` | List entries |
| POST | `/:id/entries` | `{ catalogEntityId, providerModelKey, providerAccountId?, alias? }`; account is required when several owned accounts can serve the route |
| PUT | `/:id/entries/reorder` | `{ entryIds: string[] }`; complete permutation only (409 if stale) |
| PUT | `/:id/entries/:eid` | `{ alias?, enabled?, providerModelKey?, providerAccountId? }`; route changes preserve entry identity, position, alias, and enabled state |
| DELETE | `/:id/entries/:eid` | Remove an entry and compact positions |

Entry positions are zero-based, unique, contiguous, and server-owned. The first three enabled
entries route the hidden role aliases `big`/`opus`/`default`,
`medium`/`sonnet`/`secondary`, and `small`/`haiku`/`utility`. Reserved role names are rejected as
manual aliases with `reserved_model_alias`.

Group detail returns canonical human-readable model identity, exact selected provider identity,
provider availability, and Pointer server-computed `hiddenAliases`. One canonical entity may appear at most
once in a group, even when several providers offer it. Exactly one owned group is the user's
default; changing it does not relink existing instances.

Group detail may return the selected `providerAccountNickname` on authenticated
management responses. That presentation field is private and is never placed
in `/v1/models`, `/v1beta/models`, usage keys, or provider requests. Resolution
uses the recorded account and does not silently fail over to a different
credential for the same provider.

## Direct model testing — `/api/test-model` (JWT)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/targets` | Canonical models grouped with the active providers and exact raw model IDs the current user can test. Returns metadata only, never credentials. |
| POST | `/` | `{ providerId, modelId, prompt, stream?, maxTokens? }` — directly test one listed provider target and record usage with `source='test'`. Streamed responses preserve provider reasoning in `delta.reasoning_content`, final content, finish reason, final usage and `[DONE]`. |

## Proxy — `/v1` and `/v1beta` (ptr_ key)

| Method | Path | Notes |
|---|---|---|
| GET | `/models` | Display names + `context_window`, `max_output`, `pricing`, `capabilities`. Filtered by the key's allowlist. |
| POST | `/chat/completions` | OpenAI Chat Completions. `stream: true` for SSE. |
| POST | `/messages` | Anthropic Messages. Send `anthropic-version: 2023-06-01`. |
| POST | `/responses` | OpenAI Responses. |
| GET | `/v1beta/models` | Google model resources using Pointer display names and route-supported methods. |
| GET | `/v1beta/models/{model}` | One Google model resource. |
| POST | `/v1beta/models/{model}:generateContent` | Google GenerateContent JSON. |
| POST | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Google GenerateContent SSE. |
| POST | `/v1beta/models/{model}:countTokens` | Exact native count or labeled estimate. |
| POST | `/v1beta/models/{model}:embedContent` | Native Google embedding operation. |
| POST | `/v1beta/models/{model}:batchEmbedContents` | Native Google batch embedding operation. |

The `model` field normally uses a **display name** from `GET /v1/models` (case-insensitive and
trimmed). The hidden group role aliases documented above are also valid even though discovery never
lists them. Unknown model → 404. No configured provider key for the resolved provider → 401.

All four formats use the same typed V1 intermediate representation. Pointer parses the public
request, replaces the display model with the exact provider raw ID, validates requested model
capabilities before decrypting provider credentials, and translates directly to the provider's
declared native format. Responses, provider errors, and SSE events are translated directly back to
the caller's public format. Every proxy response includes `x-pointer-gateway-engine: v1` and
`x-pointer-request-id`; the request ID is also used for generated wire IDs and safe diagnostics.

See [gateway-ir-v1.md](./gateway-ir-v1.md),
[gateway-v1-compatibility.md](./gateway-v1-compatibility.md), and
[gateway-v1-translation-inventory.md](./gateway-v1-translation-inventory.md) for the normative
contract, compatibility policy, and field coverage.

See [google-gemini-cli.md](./google-gemini-cli.md) for the Gemini CLI environment,
utility-alias profile, exact/native/mapped/rejected feature policy, and troubleshooting.

### Claude Code role routing

Point Claude Code at Pointer and make its three family selections stable while the backing models
remain controlled by the group:

```bash
export ANTHROPIC_BASE_URL=https://pointer.example.com
export ANTHROPIC_AUTH_TOKEN='<Pointer ptr_ API key>'
export ANTHROPIC_DEFAULT_OPUS_MODEL=opus
export ANTHROPIC_DEFAULT_SONNET_MODEL=sonnet
export ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku
```

Keep the real API key in a secret manager or local protected environment, never in repository files.
Pointer accepts either the Bearer token produced by `ANTHROPIC_AUTH_TOKEN` or an `x-api-key` header.
It forwards `anthropic-version` and `anthropic-beta` on native Messages routes and preserves current
beta body fields such as `context_management`, plus Claude Code's current adaptive-thinking control.
When the selected provider uses another native API, Pointer translates supported Messages semantics
through Gateway V1; adaptive thinking uses that provider's model-controlled reasoning default, while
source-specific extensions that have no cross-format representation remain subject to the documented
compatibility findings.

### Example

```bash
# 1. list models your key can use
curl https://pointer.example.com/v1/models -H "Authorization: Bearer ptr_…"

# 2. streaming chat completion
curl -N https://pointer.example.com/v1/chat/completions \
  -H "Authorization: Bearer ptr_…" -H 'Content-Type: application/json' \
  -d '{"model":"Llama 3.1 8B","messages":[{"role":"user","content":"hi"}],"stream":true}'

# 3. same model via the Anthropic format
curl https://pointer.example.com/v1/messages \
  -H "Authorization: Bearer ptr_…" -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"Llama 3.1 8B","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```
## Catalog (JWT)

`GET /api/catalog` returns the active V1 catalog generation. `GET /api/catalog/detail?slug=...`
accepts an active entity ID or slug and follows only unambiguous generation-scoped redirects created
when stronger identity evidence replaces an ID or slug. Before the first successful activation,
both endpoints return `503` with `catalog_unavailable`; they never assemble a mixed or partial
fallback catalog. Responses declare `contractVersion: "1"` and include live source health so stale
or failed source state remains visible even when the active semantic generation is unchanged.

The list response contains the shared `contractVersion`, `snapshotId`, `generatedAt`,
`benchmarkDescriptors`, `ranking`, and `sources`
envelope plus `items`, `page`, `pageSize`, `total`, and `facets`. Facets contain creator names and
provider `{id, name, available}` rows; there is no instance filter or facet. The detail response uses the same envelope and
flattens the selected catalog model fields into the response; it does not wrap the model in an
`item` property. The exact pre-release wire shapes are published in
`packages/contracts/specs/catalog.v1.schema.json`.

`ranking` declares `sort: "recommended"`, `method: "mean_percentile"`, and every active
general-purpose `sourceId`. A model's `recommendedRanking` includes the final rank, normalized
percentile, coverage, eligible-source count, and contributing source projections. Benchmark
presentations retain published score/rank and add effective rank, derived-rank flag, population,
and percentile. Clients may choose any descriptor-specific sort without hardcoding source IDs.

The list defaults at the API level to `availability=all`; clients may request
`availability=available` or diagnostic `availability=unavailable`. Search, creator, capability,
provider, source, sort, order, page, and page-size filters remain available. Every provider route
returns `providerModelKey`, provider identity, exact raw model ID, pricing/capabilities/limits, and
`available`. Availability means the authenticated user owns a connection for that provider.
Instances, linked groups, shared keys, and global provider status are not inputs.

Catalog items include Pointer server-owned semantic `modelIconKey` and `creatorIconKey` values, while provider
rows include `providerIconKey`. These are identity hints, not image URLs. Clients must resolve them
through a local allowlist and use a neutral fallback for null or unknown keys.

Admin-only catalog operations are `GET /api/admin/catalog/generations`, `POST /api/admin/catalog/reconcile`, `POST /api/admin/catalog/generations/:generationId/activate`, and the dry-run-only `GET /api/admin/catalog/gc`.

Admin-only benchmark configuration uses:

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/admin/benchmark-sources` | Descriptors, health, record counts and masked credential presence only |
| PUT | `/api/admin/benchmark-sources/artificial-analysis/credential` | `{ apiKey }`; validate, encrypt, refresh and reconcile |
| DELETE | `/api/admin/benchmark-sources/artificial-analysis/credential` | Delete the key, disable AA evidence and reconcile |

The plaintext key is never returned. See [benchmarks.md](./benchmarks.md) for consensus ordering,
source-specific ordering, pagination, terms, and operations.
