# Development and validation

## Toolchain

Use the versions pinned at the repository root:

- Node.js 22.23.2;
- pnpm 10.6.2;
- TypeScript 5.9.3;
- Bun 1.4.2;
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

`VERSION` holds the release line (`X.Y.Z`); change it only to start the next
line. Each build gets `X.Y.Z-dev.N` from the release tool through
`YOUEYE_VERSION`; the standalone artifact scripts add the source commit suffix.
No version is written into `package.json` or other tracked files.

Schema versions describe database compatibility, not release numbers. When
adding a numbered migration, also update
`apps/server/src/db/latest-schema.mjs`; readiness, migration validation and the
managed manifest consume that shared value. Do not bump it for a release with
no schema change. Published versions retain their original source identity;
release changed source under a new version rather than replacing an artifact.

## Database schema and migrations

`apps/server/drizzle/0001_baseline.sql` creates the complete schema of a fresh
database (schema version 1). `scripts/migrate.ts` applies every migration above
the version recorded in `pointer_schema_versions` and refuses anything else:
gaps, a database newer than the release, or Pointer tables without version
records.

To change the schema, write the next migration by hand:

1. Add `apps/server/drizzle/0002_<name>.sql` (lower-case words joined by `_`),
   written to run once inside the runner's transaction on a database at the
   previous version.
2. Raise `LATEST_POINTER_SCHEMA_VERSION` in
   `apps/server/src/db/latest-schema.mjs` (and its `.d.mts`) to the new number.
3. Update `apps/server/src/db/schema.ts` so the Drizzle schema matches.
4. Migrate a scratch database, run the PostgreSQL-backed tests against it
   (`pnpm test:postgres`) and add assertions for new constraints to
   `apps/server/src/db/baseline.test.ts` or a PostgreSQL-backed test.

Never edit `0001_baseline.sql` after the Release; before the Release it may be
regenerated from a migrated database (`pg_dump --schema-only`).

Artifact scripts refuse a dirty worktree:

```bash
pnpm artifact:server
pnpm artifact:web
pnpm artifact:verify
```

Outputs are written to `.artifacts/` and are intentionally ignored by Git.
The server artifact contains source, CLI, the numbered schema migrations
(starting with the baseline), the guarded migration runner and resolved dependencies so
Bun can load provider handlers dynamically and the exact release can apply its
schema. The web artifact is Next.js standalone output.

Create a development database with the same runner used for releases
(`db:migrate`):

```bash
createdb pointer_dev
cd apps/server
DATABASE_URL='postgresql:///pointer_dev?host=/var/run/postgresql' \
  bun run db:migrate --expect-database pointer_dev
```

## Codex model discovery

The Codex backend filters model discovery by `client_version`. The provider
handler pins the tested native CLI compatibility version (currently `0.159.2`),
independently of Pointer's package version. `0.0.0` is also filtered and must not
be treated as an unversioned request. Check the connected account's returned
catalog when upgrading; a public model release alone does not establish account
availability. Refresh the account inventory after installing a discovery update.

A successful connection can still return an older, incomplete model list. The
compatibility regression therefore checks discovery of GPT-6.1 Sol alongside
existing models, not just HTTP success. The fallback catalog is not consulted
when the authenticated backend returns a nonempty list.
