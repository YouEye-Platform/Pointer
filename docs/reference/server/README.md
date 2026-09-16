# Pointer server

Pointer server is the backend engine for Pointer. It is an AI API gateway: it owns authentication, provider credentials, provider discovery, model identity, routing, wire-format translation, persistence, source synchronization, and operational telemetry. Pointer web is an unprivileged browser client of this API.

Pointer server is not an agent host and does not run local models. It does not own tool-execution loops, chat sessions, or OpenCode processes.

## Pre-release contract

The product has one public contract generation: V1. New implementations replace old code in place while the product remains pre-release; the YouEye-native integration begins with package version `0.2.0`.

- Proxy routes include the OpenAI/Anthropic `/v1` surface and the Gemini CLI-compatible Google
  `/v1beta/models/*` GenerateContent surface.
- The management catalog is `GET /api/catalog` and `GET /api/catalog/detail?slug=...` with `contractVersion: "1"`.
- The gateway has one typed IR under `apps/server/src/gateway/protocol/v1` and always reports engine `v1`.
- There is no alternate gateway engine, shadow execution, duplicate paid request, or legacy catalog response.

## Backend authority

Pointer server is authoritative for:

- JWT users and role checks, `ptr_` API keys, instances, model groups, and allowlists.
- Dedicated ordered model groups with one selectable default, stable canonical membership, exact
  provider routes, and hidden `big`/`opus`/`default` role routing.
- Encrypted provider credentials and OAuth state.
- Provider manifests, raw provider model IDs, operation endpoints, model discovery, and routing.
- Canonical model entities, aliases, organizations, pricing observations, assets, and benchmark provenance.
- Request translation across OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and
  Google GenerateContent.
- Streaming, usage, cost, latency, meaningful-token TTFB, throughput, outcome, and error telemetry.
- Source health, last-known-good data, generation activation, and rollback.

Pointer web must not reproduce any of these decisions.

## Request path

All proxy endpoints require a `ptr_` key. The submitted display name is resolved within the key's instance and allowlist to a provider route and exact raw provider model ID. Pointer checks requested tools, image input, and streaming against route capabilities before provider credential decryption. Anthropic typed server tools are rejected earlier as unsupported rather than being misclassified as malformed caller-defined tools. The request then crosses the typed V1 IR, is sent once to the provider, and is rendered back into the caller's format.

Streaming remains SSE end to end and is never compressed by Pointer server. Validated streaming requests use Bun's request-scoped no-timeout setting, while non-streaming traffic retains the listener's 60-second idle timeout. Pointer forwards structured tool-argument deltas incrementally without injecting heartbeat events. Provider SSE errors become redacted target-format upstream errors with stable Pointer codes, and terminal events cancel and release the provider reader. Client disconnects also abort an upstream fetch while response headers are pending. The response includes `x-pointer-gateway-engine: v1` and the same `x-pointer-request-id` used by stream errors and telemetry.

## Catalog and telemetry

The management catalog publishes one transactionally activated generation. Source and provider inventories are immutable observations; canonical entities, routes, aliases, benchmark links, and presentation claims are generation-scoped projections. Identical inventories reuse snapshots, and a reconciliation whose semantic content hash matches the active generation is a no-op.

Catalog availability means an active route is offered by a provider the current user has added.
Instances and group assignment never participate. Provider rows expose a stable exact
`providerModelKey` plus `available`; list facets contain providers but no instances.

Usage rows store both the routed model ID and stable `catalog_entity_id`. Statistics use the stable entity directly and consult unambiguous historical aliases only for older rows without entity attribution.

## Local development

```bash
pnpm install --frozen-lockfile
createdb pointer_dev
export DATABASE_URL=postgresql:///pointer_dev
export JWT_SECRET=<development-secret>
export ENCRYPTION_SECRET=<development-secret>
pnpm db:push
pnpm test
pnpm build
pnpm dev
```

Pointer server runs on `http://localhost:4000` by default. Use `curl http://localhost:4000/healthz` for process health, then verify authenticated management and proxy workflows rather than treating health alone as acceptance.

## Documentation

- [architecture.md](./architecture.md): ownership, gateway, catalog, and telemetry design.
- [managed-platform.md](./managed-platform.md): host identity, installation
  lifecycle, idempotency, credential delivery, rotation, and compatibility.
- [managed-threat-model.md](./managed-threat-model.md): trust boundaries,
  controls, deployment responsibilities, and residual risk.
- [api.md](./api.md): HTTP routes and authentication.
- [catalog.md](./catalog.md): source ingestion, canonical identity, reconciliation, and operations.
- [model-discovery.md](./model-discovery.md): provider inventory endpoints, pagination,
  metadata filtering, refresh safety, and provider-by-provider contracts.
- [benchmarks.md](./benchmarks.md): benchmark sources, ranking, terms, credentials, and operations.
- [gateway-ir-v1.md](./gateway-ir-v1.md): typed request, response, error, and stream protocol.
- [gateway-v1-compatibility.md](./gateway-v1-compatibility.md): translation and capability behavior.
- [gateway-v1-translation-inventory.md](./gateway-v1-translation-inventory.md): executable
  sixteen-path field inventory.
- [google-gemini-cli.md](./google-gemini-cli.md): Gemini CLI setup, Google operations,
  native/cross-format semantics, and troubleshooting.
- [configuration.md](./configuration.md): environment variables.
- [subscription-providers.md](./subscription-providers.md): generic OAuth device authorization,
  refreshable credentials, Grok adapter, policy gate, and acceptance.
- [deployment.md](./deployment.md): immutable artifact deployment and rollback.
- [deployments/2026-07-29-provider-model-discovery.md](./deployments/2026-07-29-provider-model-discovery.md):
  complete metadata-only discovery implementation, immutable production release, rollback, and
  live Fireworks/Kimi K3 API and browser acceptance.
- [deployments/2026-07-28-grok-vision.md](./deployments/2026-07-28-grok-vision.md):
  Grok 4.5 capability fallback, deployment, and live public-gateway image acceptance.
- [deployments/2026-07-28-grok-subscription-auth.md](./deployments/2026-07-28-grok-subscription-auth.md):
  paired Grok subscription authentication release, migrations, rollback, owner authorization, and
  live multi-protocol E2E evidence.
- [deployments/2026-07-28-dynamic-benchmarks.md](./deployments/2026-07-28-dynamic-benchmarks.md): paired benchmark production release, migration, rollback, and E2E evidence.
- [deployments/2026-07-20-v1-consolidation.md](./deployments/2026-07-20-v1-consolidation.md): production release and acceptance evidence.
- [deployments/2026-07-21-codex-provider-healthcheck.md](./deployments/2026-07-21-codex-provider-healthcheck.md): Codex account-catalog health-check release and acceptance evidence.
- [cli.md](./cli.md): administration CLI.
- [program-baseline.md](./program-baseline.md): repository boundaries and product baseline.
