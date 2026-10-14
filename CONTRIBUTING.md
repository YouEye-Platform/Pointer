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
`youeye-pointer-build-kit-v2` and `pointer-opencodex-v2` validator. Preserve
the OpenCodex2.79.0 pin, private engine state and matching UI content hashes.
Keep the committed
`youeye.build.v2` manifest, `build_kind`, validation/profile values, trust
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

## Release version identity

New releases use `X.Y.Z[-token.N]`, retaining all three numeric positions.
Development targets the next Stable base: after `0.5.3`, use
`0.5.4-dev.N`; private main uses `alpha.N`, public Beta uses `beta.N`, and
feature releases use a collision-checked branch token with a numeric counter.
The exact case-sensitive Git branch remains separate from the display token.
Select source/channel before comparing versions; `.10` follows `.9`.

The release coordinator reserves identities with a stable request key before
building. Retry the same frozen attempt; never repurpose a used identity or
rewrite historical tags, locks or artifact versions. Failed attempts may leave
gaps. Source-only preparation does not start builds or publication, and the
existing branch/merge workflow remains in effect.

This product retains its own version sequence; it is not numbered from the
YouEye core release group. Keep every registered source version authority
consistent. Unchanged published payloads retain their original provenance.
