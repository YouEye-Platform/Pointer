# Catalog V1

Catalog V1 is Pointer server's authoritative management catalog. It separates immutable upstream observations from Pointer's stable model identity, routing, presentation, and analytics decisions.

## Public contract

JWT-authenticated clients use:

- `GET /api/catalog` for search, filters, facets, source state, provider availability, and pagination.
- `GET /api/catalog/detail?slug=<entity-id-or-slug>` for one active entity and its generation-scoped detail.

Both return `contractVersion: "1"`. Before a generation exists, Pointer server returns `503` with `catalog_unavailable`; it never fabricates a mixed response from partial tables.

The shared response envelope contains `contractVersion`, `snapshotId`, `generatedAt`, and the live
`sources` array. The list adds `items`, `page`, `pageSize`, `total`, and `facets`; facets contain
creators plus Pointer server-owned provider `{id, name, available}` options. The detail response is
deliberately flat: the selected catalog item fields are placed beside the shared envelope rather
than under `item`. `packages/contracts/specs/catalog.v1.schema.json` defines both response shapes.

`GET /v1/models` is deliberately separate. It is API-key and instance scoped, returns only routable display names, and must not be used as the management catalog.

## Runtime sources

Approved sources are fetched by Pointer server:

| Source | Purpose | Provenance |
|---|---|---|
| OpenRouter public models API | reference identity, metadata, modalities, parameters, pricing | source URL and fetch time retained |
| Official LMArena Hugging Face data | text, vision, search, document, WebDev and agent metrics | CC-BY-4.0 |
| BenchLM static data | keyless aggregate scores, ranks and benchmark evidence | MIT |
| Artificial Analysis free API | optional preferred Intelligence ordering and evaluations | API key; source terms and attribution apply |
| Official LiveBench Hugging Face data | LiveBench metrics | source license retained |
| Aider leaderboard YAML | coding metrics | Apache-2.0 |
| Configured providers | exact raw IDs, route capability, price, limits | provider-inventory |

Pointer-Board is not a runtime source. Benchmark observations stay separate. Pointer publishes a
normalized, source-attributed percentile consensus only for the cross-source Recommended order;
it does not rewrite or average the upstream scores. See [benchmarks.md](./benchmarks.md) for source
policy, ordering, credentials, and terms.

## Data model

- A source snapshot is an immutable validated inventory for one source.
- An observation is exactly what a source said: native ID, name, namespace hint, raw attributes, and provenance.
- A model entity is Pointer's stable internal identity.
- An observation link records the resolver decision, confidence, evidence, and review state.
- A provider route maps one entity to one provider and exact raw upstream model ID.
- A provider may declare an authoritative metadata identity for reconciliation
  while preserving its exact raw upstream route. This is evidence, not a route
  rewrite or display-name inference.
- Identity claims preserve source names and selected display-name provenance.
- Organizations and assets are first-class generation-scoped presentation data.
- Benchmark links retain the source-specific model label, metrics, URL, license, and fetch time.

Canonical IDs are not sent upstream. Routing always uses the route's raw
provider ID. When provider infrastructure IDs do not express model ownership,
a manifest's optional `catalogIdentity` field can extract an exact
upstream-declared identity, such as a complete repository owner/name. Missing
or incomplete metadata falls back conservatively and never triggers
inference. A declared identity becomes the primary structured claim only when
another current source corroborates it; otherwise it remains an alias and
cannot suppress the raw provider route.

## Reconciliation lifecycle

1. Fetch a complete source/provider inventory.
2. Validate schema, required provenance, duplicate native IDs, and non-empty safety rules.
3. Compute an order-independent inventory hash that excludes only volatile provenance fetch time.
4. Reuse an existing validated snapshot when source, content, URL, and license are identical.
5. Build the complete generation plan from the selected last-known-good snapshots.
6. Match conservatively using exact aliases and structured evidence. Normalization creates candidates but does not force a merge.
7. Validate entity, link, route, benchmark, slug, asset, and provenance invariants.
8. Compute a semantic generation hash that excludes live source health.
9. Return the existing active generation as a no-op when the semantic hash is unchanged.
10. Otherwise persist the complete ready generation and atomically switch the active pointer.

One source failure cannot erase successful data from another source. A failed or empty refresh
leaves its last-known-good snapshot selected. An optional source without a credential is explicitly
`disabled` and its historical snapshots are excluded from reconciliation. Current health,
timestamps, record count, and sanitized failure are read live from `source_sync_states`, so
freshness remains honest without generation churn.

Provider inventories follow the same completeness boundary. Generic discovery accumulates all
declared cursor pages and applies provider metadata predicates before persistence. An HTTP,
response-shape, cursor, page-limit, or empty-inventory failure cannot stage a partial provider
snapshot. See [model-discovery.md](./model-discovery.md).

## Identity and naming

Reference observations provide the strongest normal identity evidence. Provider-only and benchmark-only models remain valid entities when no reference exists. Ambiguous records remain unresolved or ambiguous instead of being force-merged. Resolver version `catalog-identity-2` excludes candidates whose observed version, date, size, variant, modality, or quantization already proves a conflict before deciding whether a missing claim makes the observation ambiguous. Source-specific reviewed aliases are exact, not fuzzy; for example LMArena's exact `kimi-k3-max` configuration is associated with Kimi K3 while a near spelling remains separate.

Display names are selected source claims. A creator prefix is removed only when the organization evidence proves it. Punctuation and brand casing are preserved; generic title casing is only a final fallback. Historical entity IDs and slugs are retained as aliases or unambiguous redirects so existing deep links survive stronger later evidence.

Pointer server assigns semantic presentation identity without supplying image URLs. `modelIconKey` prefers a
recognized model family, `creatorIconKey` preserves the organization fallback, and
`providers[].providerIconKey` identifies the configured route provider. Unknown/custom identities
remain null or use their stable custom key so a client can render a neutral fallback. Pointer web owns the
allowlisted bundled assets, licence notice, and visual rendering.

## Availability and pricing

Catalog presence and user availability are different facts. An active provider route is available
when, and only when, the authenticated user owns a provider connection for that route's provider.
Each exact route returns its stable `providerModelKey` and one `available` boolean. Model-level
availability and provider counts are derived from those routes and count distinct provider IDs.

Instances, instance models, linked groups, shared credentials, and global provider synchronization
status never grant catalog availability. They remain routing or operational concerns. The list
supports `availability=available|all|unavailable`; it has no instance filter or instance facet.
Unknown price is `null`, never zero. Negative sentinels are invalid.

## Analytics linkage

Usage records persist `catalog_entity_id` at request time. The `0009_usage_catalog_entity.sql` migration backfills only provider/model combinations that resolve to exactly one entity. Ambiguous historical rows remain null. Statistics use direct entity attribution first and unambiguous historical aliases only as fallback.

## Operations

Admin routes:

- `GET /api/admin/catalog/generations` lists generation state and reconciliation statistics.
- `POST /api/admin/catalog/reconcile` stages and activates a new semantic generation or reports a no-op.
- `POST /api/admin/catalog/generations/:generationId/activate` atomically rolls back or promotes a complete generation.
- `GET /api/admin/catalog/gc` produces a dry-run retention plan.

Reconciliation is serialized by a PostgreSQL advisory lock. Failed attempts are recorded without changing the active pointer. Garbage collection protects the active generation, recent history, reviewed decisions, and redirect dependencies.

## Migration notes

`0006_catalog_foundation.sql` and `0007_catalog_reconciliation.sql` establish the generation model.
`0008_dynamic_catalog_names.sql` adds source-backed naming claims.
`0009_usage_catalog_entity.sql` adds stable telemetry identity.
`0010_remove_pre_release_legacy_views.sql` removes superseded pre-release compatibility views.
`0012_benchmark_source_credentials.sql` adds isolated encrypted benchmark credentials. Schema
changes preserve users, providers, credentials, models, instances, groups, keys, and usage history.
`0015_model_group_catalog_identity.sql` establishes one default group per user-with-groups and adds
stable canonical-entity plus exact provider-model identity to group entries without removing the
legacy rollback columns.
