# Benchmark ingestion and ranking

Pointer server owns benchmark retrieval, source policy, model association, ranking, persistence, and
the API contract consumed by Pointer web. The browser never contacts a benchmark provider.
Pointer publishes every source-specific score, rank, label, attribution, and fetch time unchanged.
For the default cross-source order it additionally derives one transparent normalized consensus;
it never presents that consensus as an upstream benchmark score.

## Sources

| Source ID | Access | Data used | Terms / license |
|---|---|---|---|
| `artificial-analysis` | Optional user-supplied API key | Stable model/configuration identity, creator, release date, headline indices, evaluation cost, input/output pricing, median performance and source order | Artificial Analysis API terms; attribution is displayed |
| `benchlm` | Keyless | Overall display score, rank, category scores and benchmark evidence | MIT |
| `lmarena` | Keyless | Text style-control Arena score, confidence interval, votes and rank | CC-BY-4.0 |
| `lmarena-vision` | Keyless | Vision style-control Arena results | CC-BY-4.0 |
| `lmarena-search` | Keyless | Search style-control Arena results | CC-BY-4.0 |
| `lmarena-document` | Keyless | Document style-control Arena results | CC-BY-4.0 |
| `lmarena-webdev` | Keyless | Web-development Arena results | CC-BY-4.0 |
| `lmarena-agent` | Keyless | Agent Arena results | CC-BY-4.0 |
| `livebench` | Keyless | Overall and category results | Upstream dataset terms; review before redistribution |
| `aider` | Keyless | Polyglot and edit pass rates and cost | Apache-2.0 |

BenchLM and every LMArena configuration are part of the normal keyless install, so Pointer has a
useful benchmark catalog without asking each server operator for a third-party key. A failed source
keeps its last-known-good snapshot. A source whose optional credential is absent is `disabled`, not
failed or stale.

## Default order

`GET /api/catalog` defaults to `sort=recommended`. Recommended uses every active general-purpose
ranking source: Artificial Analysis when configured, BenchLM, and LMArena Text. Specialist
leaderboards such as Vision, Search, Document, WebDev, Agent, LiveBench, and Aider remain available
as independent sorts and evidence but do not distort the general recommendation.

Within each source, Pointer uses its published rank when present. When a source publishes only a
score, Pointer derives a competition rank using that descriptor's declared direction. The effective
rank is converted to a within-source percentile, where the best result is `1` and the bottom result
is `0`. Recommended is the equal-weight arithmetic mean of the available general-source
percentiles for that model. Coverage breaks an equal consensus score, then stable entity identity
provides the deterministic final tie-break. A missing source is not treated as zero.

The response reports `ranking.method: "mean_percentile"`, the contributing `ranking.sourceIds`,
and each model's consensus rank, percentile, source coverage, eligible-source count, and complete
source projection. Each benchmark presentation also reports its effective rank, whether that rank
was derived, population, and percentile. Models without ranked evidence follow ranked models.
Pointer Web and YouEye render this server decision and never reimplement it.

The `benchmarkDescriptors` array declares labels, descriptions, source URLs, license strings, score
and rank metric keys, units, direction, default visibility and ranking priority. New descriptor rows
and new numeric source metrics can therefore be consumed without a Pointer web source-code allowlist.

## Artificial Analysis setup

As checked on 2026-07-28, the official free endpoint is
`/api/v2/language/models/free`, its documented allowance is 100 requests per key per day, and the
documented response page size is 200. The service controls that page size; Pointer sends only the
documented `page` parameter and follows pagination sequentially, with a defensive maximum of 20
pages (4,000 rows). At the default six-hour refresh
interval, a current two-page dataset consumes about eight scheduled requests per day. Credential
validation and manual refreshes consume additional requests.

The Free response includes headline Intelligence, Coding and Agentic indices, total evaluation
cost, input/output pricing and median performance. Individual evaluation scores, detailed token
counts, percentiles, context and provider detail are higher-tier data and are not supplied by the
Free endpoint. Pointer intentionally calls the Free endpoint for predictable compatibility with
any valid AA key.

The free terms currently permit internal use and require attribution; redistribution needs the
rights described by Artificial Analysis. A self-host operator must confirm that their intended
audience fits those terms before enabling the source.

Only an admin can configure the key:

- `GET /api/admin/benchmark-sources` returns source metadata, health and only a boolean
  `hasCredential`.
- `PUT /api/admin/benchmark-sources/artificial-analysis/credential` validates a submitted key and
  response before storing AES-256-GCM ciphertext, commits that validated snapshot, and reconciles
  the catalog.
- `DELETE /api/admin/benchmark-sources/artificial-analysis/credential` deletes the ciphertext,
  marks the source `disabled`, excludes its historical snapshots from reconciliation, and
  immediately rebuilds the active catalog.

The plaintext is accepted only in the PUT body over the normal authenticated TLS connection. It is
never stored in `system_settings`, returned by any API, sent to Pointer web after submission, included in
source snapshots, or logged by the adapter.

## Identity and provenance

Benchmark source labels, stable external IDs, creator hints, aliases, source variants and all
numeric metrics are retained in the normalized observation payload. Matching is conservative; an
unmatched benchmark model remains benchmark-only rather than being forced onto a routable model.
Every active benchmark link retains its original model label, URL, license and fetch time.

Resolver version `catalog-identity-2` prevents a candidate that already conflicts on an observed
version, date, size, variant, modality, or quantization from creating a false ambiguity merely
because another field is absent. Reviewed source-specific aliases remain deliberately narrow. The
current exact LMArena `kimi-k3-max` label maps to the routable Kimi K3 identity; similar-looking
labels are not fuzzy-matched.

Artificial Analysis effort/configuration names remain visible. Pointer can associate source
evidence with a canonical model without renaming the canonical model to the benchmark
configuration.

## Operations

Automatic refresh uses `source_refresh_hours` (six hours by default). Admins can inspect health
through `GET /api/sources` and start an allowlisted refresh through `POST /api/sources/refresh`.
Refresh requests coalesce per source. Empty, malformed, oversized, timed-out, or upstream-error
responses do not replace the last-known-good snapshot.

After upgrading, apply `0012_benchmark_source_credentials.sql` using the production migration
procedure. Rotation of `ENCRYPTION_SECRET` also invalidates stored benchmark credentials, so remove
and re-add the Artificial Analysis key after any intentional rotation.
