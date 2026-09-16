# Catalog V1 client contract

Pointer server is the sole authority for model identity and catalog facts. Pointer web consumes one
pre-release V1 contract and does not maintain a compatibility adapter.

## Endpoints

| Method | Path | Result |
|---|---|---|
| GET | `/api/catalog` | Active generation list, pagination, facets, and live source health. |
| GET | `/api/catalog/detail?slug=<encoded>` | One active entity resolved by ID, slug, or an unambiguous generation redirect. |

Both endpoints require a management JWT and return `contractVersion: "1"`. If no generation has
successfully activated, Pointer server returns `503` with `catalog_unavailable`. The UI must present that
state and may retry; it must not query providers, source datasets, or Pointer-Board as a fallback.

The shared response envelope is `contractVersion`, `snapshotId`, `generatedAt`,
`benchmarkDescriptors`, `ranking`, and `sources`.
The list adds `items`, `page`, `pageSize`, `total`, and `facets`, where facets contain creator
names plus provider `{id, name, available}` options. There is no instance filter or facet. The detail response is flat: the selected
`CatalogModel` fields sit beside the envelope and are not wrapped in `item`. Client types model
these as `CatalogEnvelope`, `CatalogListResponse`, and `CatalogDetailResponse`.

The authoritative JSON Schema is maintained by Pointer server at `packages/contracts/specs/catalog.v1.schema.json`.

## Identity and routing

`CatalogModel.id` is the stable Pointer server entity identity. `slug` is its URL identity. Routes must use
URL encoding so provider/model-style values containing slashes do not split the Next route.
`providers[].providerModelKey` is Pointer server's stable exact route-record identity and
`providers[].rawModelId` is the exact upstream route identifier. Raw IDs may be displayed as
secondary evidence, but the UI must never normalize them into a canonical ID. Group mutations send
the stable `CatalogModel.id` plus selected `providerModelKey`; gateway requests continue to use
normal advertised names or Pointer server's hidden role aliases.

Aliases and name provenance explain source observations and selected display claims. They are not an
invitation for browser-side matching. Ambiguous or unresolved records remain separate.

Pointer server also owns presentation identity keys. `modelIconKey` selects a recognized model-family mark,
while `creatorIconKey` remains the organization fallback and `providers[].providerIconKey` identifies
the route provider. Pointer web may map only these semantic keys to its bundled allowlist; null or unknown
keys render a neutral local glyph and never trigger a remote image lookup. Artwork has a transparent,
unboxed surface; a brand mark is not placed inside a synthesized rounded tile.

## Unknown and unavailable values

Nullable prices, context windows, output limits, descriptions, source timestamps, and provenance are
rendered as unknown or unavailable. Null is never formatted as zero. Negative price sentinels are not
valid prices and must not reach this contract.

Availability is returned per exact provider route as one `available` boolean. Pointer server sets it only
when the current user owns a connection for that route's provider. Instances, linked groups, shared
keys, and global provider state are not inputs. Models requests use `availability=available` by
default and `availability=all` only when Show all models is enabled.

## Benchmarks and sources

Artificial Analysis, BenchLM, the six official LMArena configurations, LiveBench, and Aider remain
separate benchmark records with source URL, license, fetch time, score/rank presentation, and the
original source model label. `benchmarkDescriptors` defines every display label, score key, rank
key, unit, direction, default visibility, attribution, and ranking priority. The UI discovers
controls from this array and does not maintain a source-ID allowlist.

`ranking` declares Pointer server's `mean_percentile` Recommended consensus and its active
general-source IDs. Each item may include the consensus rank, percentile, coverage,
eligible-source count, and the source-attributed projections used to derive it. Each benchmark
presentation also carries an effective rank, derivation flag, population, and normalized
percentile. The UI requests `sort=recommended` by default and does not reproduce this decision.
Descriptor-specific sorting remains available for every general or specialist source.

The `sources` array is live operational state, independent from the active semantic generation. A
source can be stale or failed while the last-known-good generation remains usable. An optional
source may instead be `disabled`, which is neither stale nor failed. The Models pages must show
actual health without implying the catalog is freshly complete.

## Change discipline

Because the product is pre-release, intentional breaking changes replace the existing V1 contract
rather than adding a second versioned client path. Update Pointer server schemas, Pointer server tests, Pointer web types,
Pointer web pages, and both repositories' documentation in one reviewed change. Do not retain dead client
adapters or alternate endpoints.
