# Configuration

Pointer server is configured entirely through environment variables (loaded from `.env` locally, or a
systemd `EnvironmentFile` in production). See `apps/server/.env.example`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres connection string, e.g. `postgres://pointer:pw@localhost:5432/pointer` |
| `JWT_SECRET` | ✅ | — | HS256 signing secret for management JWTs. **Fail-closed**: the server throws at startup if unset — there is no insecure default. |
| `ENCRYPTION_SECRET` | ✅ | — | AES-256-GCM key material for encrypting provider API keys at rest. **Fail-closed.** |
| `POINTER_DEPLOYMENT_MODE` | — | `standalone` | `standalone` or `managed`; managed mode must be explicitly configured. |
| `CORS_ORIGIN` | standalone | — | Exact allowed browser origin, e.g. `https://pointer.example.com`. |
| `BIND` | — | `0.0.0.0` | Standalone listener bind. |
| `PORT` | — | `4000` | Standalone listener port. |
| `DISABLE_COMPRESSION` | — | `false` | Set `true` to skip gzip on `/api/*` responses. Needed only behind proxies/tunnels that can't forward an upstream gzip body. Keep the default (on) behind nginx/NPM. |

## Managed mode

Managed mode fails startup when any required trust or listener field is absent,
malformed, overlapping, wildcard-CORS, or outside its security bound.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MANAGEMENT_BIND` | — | `127.0.0.1` | Host-only management bind. |
| `MANAGEMENT_PORT` | ✅ | — | Management listener port. |
| `MANAGEMENT_CORS_ORIGIN` | — | none | Optional exact control-plane browser origin; `*` is rejected. |
| `INFERENCE_BIND` | — | `0.0.0.0` | Application inference bind. |
| `INFERENCE_PORT` | ✅ | — | Inference listener port; must differ from management. |
| `PLATFORM_ISSUER` | ✅ | — | Exact assertion issuer. |
| `PLATFORM_AUDIENCE` | ✅ | — | Exact Pointer management audience. |
| `PLATFORM_SUBJECT` | ✅ | — | Exact host server subject. |
| `PLATFORM_INTEGRATION_ID` | ✅ | — | Stable external server/integration identity. |
| `PLATFORM_JWKS_URL` | ✅ | — | Trusted HTTPS asymmetric verification-key endpoint; HTTP is accepted only on loopback for isolated tests. |
| `PLATFORM_SIGNING_ALGORITHMS` | — | `RS256,ES256` | Comma-separated allowlist from RS256/384/512 or ES256/384/512. |
| `PLATFORM_MAX_ASSERTION_SECONDS` | — | `300` | Maximum issued lifetime; hard maximum 900. |
| `PLATFORM_CLOCK_SKEW_SECONDS` | — | `30` | Verification tolerance; hard maximum 120. |
| `PLATFORM_JWKS_COOLDOWN_SECONDS` | — | `30` | Minimum refresh interval after an unknown signing key; hard maximum 300. |
| `PLATFORM_JWKS_CACHE_SECONDS` | — | `300` | Verification-key cache lifetime; hard maximum 3600. |
| `MANAGED_SERVICE_PRINCIPAL_NAME` | — | `Managed AI gateway` | Non-login owner display name. |
| `CREDENTIAL_DELIVERY_TTL_SECONDS` | — | `600` | Recoverable encrypted delivery lifetime. |
| `IDEMPOTENCY_TTL_SECONDS` | — | `86400` | Durable platform mutation-result lifetime. |
| `AUDIT_RETENTION_DAYS` | — | `365` | Managed audit retention. |

The configured issuer, audience, and subject are persisted on first managed
startup. Later configuration drift fails closed instead of silently rebinding
an existing database. Local JWT and encryption secrets remain required because
the same artifact supports standalone rollback and existing encrypted data.

An authorized host rename uses the packaged `transition-managed-identity.js`
command before restarting with the new issuer. This is a local database-owner
operation, not an HTTP endpoint or automatic startup override. The host passes
`DATABASE_URL` and `POINTER_IDENTITY_TRANSITION` through its protected execution
environment. The latter contains `integrationId`, `oldIssuer`, `newIssuer`,
`audience`, and `subject`. Invoke with `--expect-database pointer --check` to
validate without changing trust, then omit `--check` to apply. Both require the
exact active integration, active service owner, unchanged audience/subject and
HTTPS issuers. The connected role must own the named database.

The transition serializes with managed startup, retains ownership and application
data, and atomically records an audit receipt with the issuer change. Repeating
the same completed transition is safe; a matching audit receipt is required.
An exact reverse transition supports host rollback. The host must coordinate
its routing/configuration change and Pointer restart, and restore the previous
settings if the new service cannot become ready. Changing environment variables
alone continues to fail closed.

## Gateway contract

The gateway engine is fixed to V1. There is no engine-selection or dual-run environment variable.
Compatibility policy is enforced by the typed V1 request boundary and model-capability preflight;
deployment configuration cannot bypass those checks.

## Security notes

- **Never commit secrets.** Generate strong random values for `JWT_SECRET` and `ENCRYPTION_SECRET`
  and keep them in a `600`-permission env file. Rotating `ENCRYPTION_SECRET` invalidates all stored
  provider and optional benchmark keys (they'd need to be re-added).
- Provider and optional benchmark API keys are encrypted with AES-256-GCM before they touch the database.
- `ptr_` API keys are stored only as SHA-256 hashes.
- `CORS_ORIGIN` should be the single Pointer web origin. The proxy uses Bearer tokens (no cookies), so
  there is no cross-site cookie surface.
- CORS is not network isolation. A managed deployment must restrict the
  management listener at the host firewall/router and expose only inference to
  application networks.

## Database schema

Drizzle Kit is a development schema tool:

```bash
bun run db:generate   # generate SQL migrations from schema.ts
bun run db:push       # inspect/bootstrap a disposable development schema only
```

Production deployments never use `db:push`. Apply the packaged current-schema
baseline and reviewed SQL migrations through `scripts/migrate.ts`, using a
database owner or dedicated migration role, only after backup restoration has
been rehearsed; see [deployment.md](../../deployment.md).
