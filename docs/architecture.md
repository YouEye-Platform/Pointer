# Pointer architecture

Pointer is a monorepo, not a monolith. Packaging, dependency versions,
contracts and release identity are consolidated; process and authority
boundaries remain explicit.

```text
Browser / API client
        |
        v
same-origin router :8080
   |             |
   |             +---- ordinary pages, assets, /_pointer/web/* ---> web :3000
   |
   +---- /api/*, /v1/*, /v1beta/*, /healthz, /readyz,
         /.well-known/pointer -------------------------------> server :4000
                                                                  |
                                                                  v
                                                             PostgreSQL
```

## Authority boundary

The server is the only authority for users, credentials, provider operations,
source ingestion, model identity, groups, instances, keys, inference routing,
usage, database migrations, readiness and managed-platform lifecycle. The web
application renders server contracts and keeps only browser session state.

Provider definitions and user accounts are separate domains. One provider
definition supplies protocol and discovery behavior; any number of users—and
any one user repeatedly—may attach account-scoped credentials and optional
public HTTPS endpoint overrides. Group entries retain the exact account route
privately while public model discovery and inference requests use canonical
human model names.

`packages/contracts` prevents the two applications from drifting on shared
surfaces. The deployment capability parser and the generated managed API types
are imported by both sides. JSON Schema and OpenAPI sources live in
`packages/contracts/specs`.

## One origin

The browser defaults to relative URLs. It therefore uses the same public
origin for pages and APIs, with no cross-subdomain browser dependency. The
router preserves streaming behavior under `/v1` and `/v1beta` by disabling
request and response buffering and using long read/write timeouts.

Component-specific diagnostics are intentionally collision-free:

- server: `/healthz`, `/readyz` and `/.well-known/pointer`;
- web: `/_pointer/web/healthz` and `/_pointer/web/version`.

The external TLS proxy needs only one upstream, the LXC router on port 8080.
Direct server and web listeners bind to loopback in the full profile.

## Deployment modes

Full standalone installs all three services plus PostgreSQL. Headless
standalone installs the server only and exposes its listener directly or
through an operator-selected proxy. Managed mode uses the same server artifact
with separate management and inference listeners and does not require web.

## Build identity

Both artifacts are built from the same clean commit. Each contains
`release-manifest.json`, a non-secret `release.env`, and an external SHA-256
sidecar. Health/version responses expose component, version, repository,
branch, commit and build time so mixed releases can be detected.
