# Contracts

Canonical public contracts live in `packages/contracts`:

| Contract | Source | Consumers |
| --- | --- | --- |
| Deployment capabilities | `specs/capabilities.v1.schema.json` and `src/capabilities.ts` | server, web, host probes |
| Managed platform API | `specs/platform-api.v1.openapi.yaml` | server, YouEye |
| Catalog V1 | `specs/catalog.v1.schema.json` | server, web |
| Gateway compatibility | `specs/gateway-compatibility.v1.schema.json` | gateway tests and clients |
| Management API | `specs/management-api.v1.schema.json` | management clients |

The server owns contract semantics. Web consumes shared types and performs
defensive runtime parsing; it must not recreate server decisions.

To change a generated contract:

```bash
pnpm contracts:generate
pnpm contracts:check
pnpm typecheck
pnpm test:unit
```

Breaking changes require a new explicit API/contract version. Do not silently
change the meaning of an existing field.
