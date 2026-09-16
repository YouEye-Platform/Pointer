# Standalone and headless deployment

## Profiles

The `full` profile installs:

- Pointer server on loopback port 4000;
- Pointer web on loopback port 3000;
- Pointer router on LAN-facing port 8080;
- one external hostname pointing at port 8080.

The `server` profile installs the same server artifact without web or the
router. Its listener binds to all interfaces by default so an external proxy
can target port 4000. Restrict this with host firewall rules or a service
override when the server is private.

The `YouEye managed` profile uses the repository-owned
`.youeye/build/pointer` entrypoint. It emits an uncompressed `standalone.tar`
rooted at `server.js` and `migrate.js`, with `drizzle/`, `providers.d/`,
`package.json`, and `release-manifest.json`. YouEye installs that archive
without Pointer Web, separates management and inference listeners, and owns
database, secrets, TLS trust, service wiring, health, backup, restore, and
updates. Release construction and signing remain YouEye-Infra operations.

## Host prerequisites

- Debian 13 or equivalent;
- Bun at `/usr/local/bin/bun`;
- Node.js at `/usr/bin/node`;
- PostgreSQL 17 or a protected PostgreSQL connection;
- Nginx for the full profile;
- curl for service readiness checks;
- root-readable `/etc/pointer/server.env`.

The environment file must contain the server's database URL, JWT secret,
encryption secret and allowed CORS origin. It is never included in artifacts.
For migration from the previous two-repository deployment, the installer
retains the existing protected environment through a compatibility symlink
when `/etc/pointer-lite.env` exists. It does not read or print the file.
Retaining the database and encryption secret preserves users, provider
credentials, groups, instances, keys and usage.

## Build

Build from a clean, pushed `main` commit:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm artifact:server
pnpm artifact:web
pnpm artifact:verify
```

Copy the `.tgz` and matching `.sha256` files over an authenticated channel.
Verify each sidecar on the target before extraction.

The YouEye entrypoint additionally requires the exact source commit, source
epoch, dedicated work/output directories, Node 22.23.2, pnpm 10.6.2, Bun 1.3.x,
and the reviewed offline pnpm store supplied by the permanent builder. It fails
on a mismatched checkout, invalid optional checkout source locator, moving
dependency resolution, network fallback, or an ambiguous output directory.

The resulting YouEye headless artifact contains the bundled server and
migration runner, the pinned Bun runtime, migrations, provider manifests,
package metadata, and a source-bound release manifest. It remains unsigned;
YouEye-Infra separately owns any signing and managed host executes the bundled
runtime without downloading an unpinned language runtime.

The managed build keeps the current `youeye.build.v2` manifest, build kind,
validation and provenance profiles, trust boundary, output role, and supported
executor identity. Registering that executor as public-neutral is a narrow
external build-registry action; it is not a source change.

Pointer product licensing and trademark ownership are not established by this
repository. Legal files must not be inferred from another product; their
inclusion in the managed archive remains blocked on a rights-holder decision.
See [PUBLIC_RELEASE_POLICY.md](../PUBLIC_RELEASE_POLICY.md).

## Automated wiring

On the target, from a checkout of the same commit:

```bash
sudo deployment/install-release.sh full \
  /path/to/pointer-server-<commit>.tgz \
  /path/to/pointer-web-<commit>.tgz
```

For headless installation:

```bash
sudo deployment/install-release.sh server \
  /path/to/pointer-server-<commit>.tgz
```

The bundled CLI can be invoked with:

```bash
/usr/local/bin/bun /opt/pointer/current/server/cli/pointer.js --help
```

The installer creates a versioned release, records the prior target as
`/opt/pointer/previous`, switches `/opt/pointer/current`, installs matching
systemd units, renders the router, applies the selected bind profile and
restarts the required services on the new target. Selecting `server` disables
web and router services left by an earlier full installation. It refuses
missing environment, checksum, artifact or runtime prerequisites and does not
edit secret values.
The router requires both application services and waits for server and web
health before accepting traffic, avoiding a transient 502 during simultaneous
startup. The installer returns only after the selected profile's health
endpoints pass.

Database migration is deliberately separate from process wiring. Before a
schema change, take and verify a PostgreSQL custom-format backup and restore it
into an isolated database. Use the packaged, versioned migration runner with
the database owner or a dedicated migration role. The required database-name
argument is a guard against targeting the wrong database:

```bash
cd /opt/pointer/current/server
runuser -u postgres -- env 'DATABASE_URL=postgresql:///pointer?host=/var/run/postgresql' \
  /usr/local/bin/bun run scripts/migrate.ts --expect-database pointer --check
runuser -u postgres -- env 'DATABASE_URL=postgresql:///pointer?host=/var/run/postgresql' \
  /usr/local/bin/bun run scripts/migrate.ts --expect-database pointer
```

The runner uses a transaction-scoped advisory lock, distinguishes fresh,
supported legacy, current and unsupported schemas, initializes a fresh
database from the packaged baseline, applies reviewed numeric SQL migrations
once and records their versions. It refuses a mismatched database name, a
future schema, an ambiguous partial schema or a role without migration
privileges. Never use `db:push` against production.

When PostgreSQL is remote, use an equivalently privileged protected connection
without putting its credentials in shell history or process arguments. Test
the restore and migration path in an isolated database before promotion.

## External reverse proxy

Configure one TLS hostname, for example `pointer.example.com`, with upstream:

```text
http://<pointer-lxc-address>:8080
```

Enable WebSocket forwarding and do not buffer streaming responses. Do not add
a second browser-facing server hostname. The old API hostname may be retained
temporarily as a compatibility alias to the same router.

## Acceptance

Verify locally on the LXC and through the public hostname:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8080/.well-known/pointer
curl -fsS http://127.0.0.1:8080/_pointer/web/healthz
curl -fsS https://pointer.example.com/healthz
curl -fsS https://pointer.example.com/_pointer/web/version
```

Also validate login, providers, models, groups, keys, usage, a protected
`/v1/models` call, an authenticated `/v1beta/models` call, one non-stream
inference and one streamed inference on each enabled public protocol family.
For every streamed inference, require at least one meaningful text, reasoning,
or tool-call event before accepting a normal terminal event. A provider
`response.failed` terminal is a safe `pointer_upstream_unavailable` failure
unless an exact machine code identifies context rejection. Context rejection
is `pointer_context_length_exceeded` (400, non-retryable); a nominally successful
terminal without model output is `pointer_empty_response`. Diagnose failures only from the bounded
request ID, provider, model, status and outcome telemetry; never log the
provider body or credentials.
Confirm browser API requests remain on the page origin and service logs contain
no credentials. `pnpm deployment:check` prevents a release from omitting either
inference family from the committed same-origin router template.

For translated Messages streams, verify the native consumer's final usage as
well as Pointer telemetry. Responses providers often supply usage only at the
terminal event. The final Messages delta must carry cumulative input/cache
buckets even when the initial message had zero usage. IR input usage includes
the full prompt; Messages input, cache-read and cache-creation are disjoint
buckets and must not be double-counted. Incremental stream tests are required:
rendering the entire completed trace at once does not exercise late usage.

Responses-to-Responses routing retains native tool-search, custom-tool,
namespaced function and web-search items, including deferred tool definitions
and call IDs. These items are protocol-scoped IR extensions, not ordinary text
or JSON function calls. A different API family must reject them explicitly when
it cannot preserve their semantics. Streams require a completed native item
before successful termination; native item events and final usage are both
retained. See the [OpenAI tool-search contract](https://developers.openai.com/api/docs/guides/tools-tool-search).
