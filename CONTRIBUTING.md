# Contributing to Pointer

## Scope

Pointer is a pnpm monorepo. `apps/server` owns service, persistence,
migrations, managed-host behavior, and release metadata. `apps/web` is the
optional standalone browser product and the shared host-React UI module. The
managed artifact includes the shared module, font/icon notices and persistent
engine runtime; keep the standalone Next.js server separate. `packages/contracts` owns generated API contracts and
`packages/cli` owns the command-line client.

## Development

Use the root-pinned toolchain: Node.js 22.23.2, pnpm 10.6.2, TypeScript 5.9.3,
and Bun 1.4.2. Install with `pnpm install --frozen-lockfile`; use pnpm for all
workspace commands. Before proposing a cross-component change, run the
relevant offline-safe root gates, beginning with `pnpm public-source:check`, `pnpm typecheck`,
`pnpm contracts:check`, and the focused unit tests.

Do not place credentials, database URLs, protected request data, or
production-derived data in source, tests, logs, or reports. PostgreSQL
integration tests require an explicitly safe test database and are separate
from ordinary unit tests.

## Managed server boundary

The YouEye build is `.youeye/build/pointer`. It is headless, network-denied,
and produces an unsigned `standalone.tar`. It selects the exact Bun1.4.2
`youeye-pointer-build-kit` and `pointer-opencodex` validator. Preserve
the OpenCodex2.79.0 pin, private engine state and matching UI content hashes.
Keep the committed
`youeye.build.v1` manifest, `build_kind`, validation/profile values, trust
boundary, executor identity, and output role unchanged unless the owning
platform changes them. Release metadata names Pointer's public product identity
and records the optional checkout source separately; a private checkout does
not imply public publication. The supported executor
is intentionally retained; external platform work is limited to registering
that existing executor as a public-neutral identity, not changing it in this
repository.

Release metadata and readiness use the shared latest-schema authority. Add a
numbered migration and update that authority together; do not hand-edit a
separate schema version in a release manifest or readiness check.

See [PUBLIC_RELEASE_POLICY.md](PUBLIC_RELEASE_POLICY.md) before preparing a
public release.

Public source must use neutral deployment examples and the canonical public
product identity. Keep environment-specific deployment histories in private
operator documentation. Schema IDs identify published schema documents; changes
must preserve schema constraints and be checked against consumers.

## Versions and releases

`VERSION` holds the release line (`X.Y.Z`). Every build is `X.Y.Z-dev.N`: the
release tool picks the next free `N` from this repository's release tags and
passes the full version to `.youeye/build/pointer` as `YOUEYE_VERSION`; the
build fails without it. Nothing in the source tree carries the build number;
the workspace `package.json` versions are the placeholder `0.0.0`. The build
inlines the version into `server.js` and writes it into `release-manifest.json`,
which it also emits as the release's `pointer-build-contract.json`.

A build keeps its version on every channel (dev, alpha, beta, stable).
Promotion copies the same bytes and never rebuilds. Release tags are
`v<version>`. A release holds `standalone.tar`, `pointer-build-contract.json`
and `product-release.json`, which binds them by SHA-256 and the source git tree.

## Interface text

Follow [the localization contract](docs/localization.md) when changing web or
shared-module screens. Add all supported translations with complete messages,
preserve API identifiers, and keep the embedded locale update method free of
remounts. The embedded build runs catalogue and new-literal checks.
