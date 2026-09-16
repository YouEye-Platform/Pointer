# Architecture

## Ownership boundary

Pointer server is the only backend authority. Pointer web calls Pointer server APIs and renders their results; it has no database, secrets, source adapters, provider clients, or independent model matching. Pointer-v05 is a behavior donor only. Pointer-Board is archival and never participates in runtime requests.

## Runtime components

```text
apps/server/src/
  index.ts                         Hono composition, startup, health, CORS
  middleware/auth.ts               JWT authentication and roles
  middleware/api-key.ts            ptr_ hashing, instance scope, allowlists
  routes/catalog.ts                active management catalog V1
  routes/model-groups.ts           exact canonical/provider membership and default authority
  routes/proxy.ts                  four public proxy formats and Google model operations
  routes/stats.ts                  entity-aware usage analytics
  http-runtime.ts                  Bun request-scoped streaming timeout control
  gateway/protocol/v1/             typed request/response/error/stream IR
  gateway/preflight.ts             route capability enforcement
  gateway/provider-operation.ts    declared provider format and endpoint
  providers/model-discovery.ts     GET-only inventory pagination, filtering, and declared identity extraction
  services/model-capabilities.ts   discovery metadata + exact manifest fallbacks
  services/model-resolution.ts     display name to exact provider route
  services/catalog-reconciliation.ts transactional generation builder
  services/catalog-telemetry-identity.ts historical telemetry aliases
  services/usage-telemetry.ts      attributed usage persistence
  providers/registry.ts            manifests, credentials, provider requests
  db/schema.ts                     PostgreSQL schema
```

## Deployment modes and principals

`POINTER_DEPLOYMENT_MODE=standalone` is the default and retains the combined
listener, local login/registration, local JWT ownership, Pointer web, and CLI.
`managed` creates a non-login service principal and a persisted platform
integration. Host administrator assertions act on the service principal's
server-wide providers, groups, installations, and usage; the human actor is
recorded separately in audit.

Managed mode creates two independently routed Hono applications:

```text
host control plane -> management listener -> /api/* and /api/platform/v1/*
application        -> inference listener  -> /v1/*
```

Both listeners expose only safe `/healthz`, `/readyz`, and
`/.well-known/pointer` metadata. The inference listener has no management
routes, and the management listener has no inference routes. Pointer web is
not required in managed deployments.

A managed application installation maps one external ID to one managed
instance and active inference key. It links exactly one model group and cannot
add direct instance models. The current default group is selected only for new
installs that omit a group. Later default changes do not relink them; group
edits and explicit reassignment affect live routing.

## Proxy request lifecycle

1. API-key middleware hashes the presented key, checks revocation, loads its user and instance, applies model allowlists, and records key use.
2. `resolveModel` maps the V1 display name to `{ modelId, catalogEntityId, providerId, providerModelId, nativeFormat, nativeEndpoint, capabilities }`. The exact `providerModelId` is the only model identifier sent upstream.
3. Capability preflight inspects tools, image input, and `stream: true`. An explicitly unsupported route returns a format-correct `pointer_feature_unsupported` error before credential decryption or provider I/O. Anthropic typed server tools are rejected separately before model resolution because Pointer does not yet model their execution and result lifecycle.
4. The provider manifest declares one fallback `generate` operation with a native format and endpoint. Account-scoped discovery may override that format and endpoint for an individual model. Exact-model capability fallbacks may supplement an omitted discovery boolean but never contradict an explicit provider value. Custom manifests may use conservative format inference when a declaration is absent.
5. The public request is parsed into Gateway IR V1, validated, rendered directly to the provider's native format, and refined as a provider request.
6. For a validated `stream: true` request, Pointer disables Bun's idle timeout only for that request while retaining the listener's 60-second default for non-streaming traffic.
7. Pointer server decrypts the current user's provider credential, issues exactly one upstream request, normalizes failures, and renders JSON or SSE into the original client format.
8. Usage is persisted with user, instance, API key, provider, routed model, stable catalog entity, token counts, prices, latency, TTFB, generation duration, throughput, outcome, and sanitized error fields.

Credential lookup is intentionally after model/capability resolution. Provider authentication failures remain provider errors and never invalidate the Pointer JWT or `ptr_` key.

Management-catalog availability is projected separately from gateway routability. Pointer server loads only
the authenticated user's own provider connections and marks active provider routes with a binary
`available` value. No instance, instance-model, linked-group, shared-key, or provider-global-status
query participates. Group mutations validate the stable catalog entity plus exact provider-model
record against the active generation and the same own-connection authority.

## Gateway V1

The public matrix is four client formats by four provider-native formats. All sixteen paths use the same typed parser and renderer rather than a Chat-Completions hub or duplicated passthrough implementation.

| Client format | Provider formats |
|---|---|
| Chat Completions | Chat Completions, Messages, Responses, Google GenerateContent |
| Messages | Chat Completions, Messages, Responses, Google GenerateContent |
| Responses | Chat Completions, Messages, Responses, Google GenerateContent |
| Google GenerateContent | Chat Completions, Messages, Responses, Google GenerateContent |

The IR version is `1`. It preserves ordered text, image/audio/file content, reasoning and opaque thought signatures, refusal, tool call/result, structured output, expanded sampling, usage, finish, extension, and correlation data where the target wire format can represent it. Strict schemas reject unknown security-sensitive fields. Native Google payloads retain validated Google fields in a format-scoped extension, while Google-to-other-format requests reject unknown or native-only semantics. Cross-format degradation is explicit through compatibility findings; unsupported features fail closed.

Streaming parses fragmented UTF-8 and SSE lines incrementally, retains format-specific stream state, measures TTFB only on meaningful content or tool output, renders target events incrementally, and propagates downstream cancellation to the upstream request and reader. Structured tool arguments are forwarded as each complete upstream SSE delta arrives; Pointer does not wait for the complete tool-call JSON and does not add synthetic heartbeat events. A provider SSE error is normalized into a redacted target-format error with a stable Pointer code and recorded as `upstream_error`; it is not mislabeled as malformed translation. Any terminal event cancels and releases the provider reader so trailing provider heartbeats cannot retain request resources.

## Catalog publication

Source adapters fetch approved upstreams into validated immutable snapshots. Provider inventories use the same observation model. Reconciliation builds a complete generation containing organizations, entities, links, routes, aliases, benchmark links, decisions, and assets.

Activation is atomic under a PostgreSQL advisory lock. Readers only see the single active generation. An empty or invalid source result cannot erase last-known-good facts. Source health is read live from `source_sync_states`, so a refresh failure is visible even when the active generation remains unchanged.

Provider model discovery has its own complete-inventory boundary before reconciliation. Generic
manifests may declare an absolute metadata URL, static query, cursor pagination, and nested
eligibility predicates. Pointer server accumulates every page, filters on provider-declared metadata, and
deduplicates raw IDs before any route persistence or snapshot staging. Manual refresh, hourly
refresh, post-connect refresh, and generic connection testing share this GET-only executor.
Provider discovery never exercises an inference operation. See
[model-discovery.md](./model-discovery.md).

Provider routing identity and catalog identity are deliberately separate. The
exact discovered ID is persisted and sent upstream. A manifest may additionally
select an authoritative metadata field for canonical reconciliation; this can
group equivalent routes without model-name inference. Catalog activation
clears provider-row catalog links and reassigns them only to current routes, so
management counts, test targets, and runtime resolution exclude retained
historical rows.

Snapshot identity ignores volatile fetch time while snapshot revision retains it. Reconciliation content identity ignores live source health. Identical data therefore reuses snapshots and returns the active generation as a no-op instead of creating churn.

## Stable analytics identity

New usage rows persist `catalog_entity_id`. Model statistics filter and group by this immutable identity. For historical rows with no entity ID, Pointer server expands only aliases proven to map to one entity; ambiguous aliases are excluded. Missing price remains unknown and never becomes zero.

## Security and consistency

- Provider API keys, OAuth access/refresh envelopes, and pending device codes are encrypted with
  AES-256-GCM and never returned by APIs.
- Raw `ptr_` keys are shown once and stored only as SHA-256 hashes.
- User ownership is enforced for instances, groups, API keys, provider credentials, and statistics.
- Route-resolution caches are invalidated after alias, allowlist, provider, instance, or
  route-affecting group changes. Merely selecting another default group does not invalidate existing
  instance routing because existing instance links do not change.
- Errors and telemetry sanitize upstream payloads, URLs, headers, and credential-shaped values.
- Build metadata identifies repository, branch, commit, and build time without exposing secrets.
- Managed mutation assertions are short-lived, asymmetrically verified,
  permission-scoped, actor-bearing, and replay-protected.
- Managed credential delivery is encrypted, expiring, acknowledgement-purged,
  and never present in list/reconcile responses, audit, or idempotency results.
- Managed installations, instances, and credentials carry explicit lifecycle
  state checked by the gateway on every request.

See [managed-platform.md](./managed-platform.md) for the lifecycle and
[managed-threat-model.md](./managed-threat-model.md) for the boundary analysis.

## Pre-release replacement policy

There is no runtime compatibility layer for superseded catalog or gateway implementations. Database changes remain additive where necessary to preserve production data, but old views, engine switches, translators, and routes are removed once their V1 replacements are verified.
