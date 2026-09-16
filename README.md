# Pointer

Pointer is a self-hosted AI gateway and browser control surface. It provides
one product and one repository while retaining a strict runtime boundary:

- `apps/server` owns authentication, provider credentials, model discovery,
  routing, protocol translation, persistence, telemetry and managed-host
  integration.
- `apps/web` is an optional browser client. It stores no provider secrets and
  has no direct database or provider access.
- `packages/contracts` is the shared API and capability boundary.
- `packages/cli` is the headless command-line client.

The full deployment runs server, web and a path router in one LXC behind one
origin. The same server artifact can also be installed without web, and managed
mode retains isolated management and inference listeners for YouEye.

## Quick start

Requirements: Node.js 22.23.2, pnpm 10.6.2, Bun 1.3.x and PostgreSQL 17.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
# Fill the local-only values in apps/server/.env.
pnpm --filter @pointer/server db:push
pnpm dev:server
```

In another shell:

```bash
API_PROXY_TARGET=http://127.0.0.1:4000 pnpm dev:web
```

Open `http://127.0.0.1:3000`. Production does not use the development rewrite:
the Pointer router sends `/api`, `/v1`, `/v1beta`, health and capability paths
to the server and all other paths to web.

## Validation

```bash
pnpm typecheck
pnpm contracts:check
pnpm deployment:check
pnpm build
pnpm test:unit
pnpm test:postgres
pnpm test:e2e
```

`pnpm verify:full` additionally creates and checks immutable server and web
artifacts. Artifact creation requires a clean Git commit so release identity is
never ambiguous.

## Documentation

- [Architecture](docs/architecture.md)
- [Development and validation](docs/development.md)
- [Standalone and headless deployment](docs/deployment.md)
- [Operations and rollback](docs/operations.md)
- [Managed/YouEye integration](docs/managed-youeye.md)
- [Contracts](docs/contracts.md)
- [Imported source provenance](docs/migration/source-baseline.md)
- [Authorized implementation plan](docs/implementation-plan.md)
- [Deployment guidance](docs/deployments/README.md)

The deeper server and web references are under `docs/reference`.
