# Development and validation

## Toolchain

Use the versions pinned at the repository root:

- Node.js 22.23.2;
- pnpm 10.6.2;
- TypeScript 5.9.3;
- Bun 1.3.x;
- PostgreSQL 17 for integration tests.

Run `pnpm install --frozen-lockfile` after the lockfile is committed. Provider
credentials and production environment values must never be copied into the
repository or test logs.

## Local environment

Create `apps/server/.env` from the example and use a dedicated development
database. The server requires database, JWT, encryption and CORS configuration.
Never point destructive or integration tests at production.

For same-origin browser development:

```bash
pnpm dev:server
API_PROXY_TARGET=http://127.0.0.1:4000 pnpm dev:web
```

`NEXT_PUBLIC_API_URL` is optional. Leave it empty for the deployed same-origin
topology. Set it only when deliberately developing the web client against a
different server origin.

## Gates

Fast local gate:

```bash
pnpm verify
```

Complete gate:

```bash
pnpm test:postgres
pnpm test:e2e
pnpm artifact:server
pnpm artifact:web
pnpm artifact:verify
```

PostgreSQL tests are guarded and run only through `test:postgres`; the ordinary
unit suite reports them as skipped. With no `DATABASE_URL`,
`test:postgres` creates a uniquely named local test database, initializes it
through the release migration runner, runs the suites and drops only that
temporary database. With `DATABASE_URL` supplied (as in CI), it requires a
database name containing a distinct `test` segment, applies pending migrations
and sets the catalog and managed safety expectations to that exact name unless
they were supplied explicitly. Safety checks reject every non-test name.
Playwright builds and starts the production standalone web output before
exercising Chromium.

## Contract changes

Edit the canonical spec under `packages/contracts/specs`, then run:

```bash
pnpm contracts:generate
pnpm contracts:check
pnpm typecheck
```

Commit the spec and generated TypeScript together. Do not hand-edit
`packages/contracts/src/generated/platform-api-v1.ts`.

## Release artifacts

For a release-only version bump, change `apps/server/package.json` once. The
managed manifest reads that version directly; standalone artifact metadata
adds the exact source commit suffix. Commit, branch and build provenance are
generated rather than edited by hand. A version bump does not require changing
the build recipe or duplicating the version in documentation.

Schema versions describe database compatibility, not release numbers. When
adding a numbered migration, also update
`apps/server/src/db/latest-schema.mjs`; readiness, migration validation and the
managed manifest consume that shared value. Do not bump it for a release with
no schema change. Published versions retain their original source identity;
release changed source under a new version rather than replacing an artifact.

Artifact scripts refuse a dirty worktree:

```bash
pnpm artifact:server
pnpm artifact:web
pnpm artifact:verify
```

Outputs are written to `.artifacts/` and are intentionally ignored by Git.
The server artifact contains source, CLI, the current-schema baseline, reviewed
numeric migrations, the guarded migration runner and resolved dependencies so
Bun can load provider handlers dynamically and the exact release can apply its
schema. The web artifact is Next.js standalone output.

For an empty local database, initialize it through the same controlled runner
used for releases:

```bash
cd apps/server
DATABASE_URL='postgresql:///pointer_dev?host=/var/run/postgresql' \
  bun run scripts/migrate.ts --expect-database pointer_dev
```

`db:push` is only a development schema-diff aid. It is not a production
migration command.
