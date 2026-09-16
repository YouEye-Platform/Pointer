# Pointer monorepo and standalone deployment plan

**Status:** Completed and accepted in production

**Date:** 2026-07-30

**Authoritative repository:** `https://github.com/YouEye-Platform/Pointer`

**Implementation branch:** `main`

**Implementation authority:** Granted by the product owner on 2026-07-30

**Supersedes:** workspace-root `plan2.md`

This plan creates one product named **Pointer** from the current
Pointer-Lite and Pointer-WebUI source snapshots. It does not preserve their
Git histories in the new repository. It also defines a single-host standalone
deployment in which Pointer server and Pointer web share one public origin,
while preserving server-only and YouEye-managed deployment modes.

The product owner authorized the complete task: source changes, validation,
pre-existing issue correction, pushes to the new repository's `main` branch,
artifact creation, existing Pointer LXC mutation, database backup and isolated
test restoration, deployed end-to-end testing, iteration, single-origin
production cutover and detailed documentation. Existing provider credentials
must be retained where technically possible; if re-authentication becomes
necessary, implementation pauses for the owner.

## 0. Execution status

Implementation and production acceptance are complete.

- The donor snapshots have been imported without their Git histories and the
  monorepo is pushed on `main`.
- Pointer-only naming, shared contracts, same-origin browser defaults,
  independent server/web artifacts, full and server-only service profiles and
  the one-origin router are implemented.
- A versioned, transactional PostgreSQL migration runner now packages a fresh
  baseline and every reviewed migration, records schema versions and refuses
  wrong, partial or future databases.
- Local type, contract, unit, PostgreSQL, production build, browser and fresh
  migration gates pass.
- An isolated restored-database canary on LXC 225 preserves and decrypts all
  existing provider credentials. All configured providers pass live connection
  tests, real streamed and non-streamed inference pass, and the deployed web
  login plus management pages pass on one origin.
- Release `27e7c3441b1d95fac5657358539a5b5a5d8f06ae` is deployed on LXC 225
  with server, web and router healthy. The public hostname targets their single
  port and passed browser and inference E2E.
- The superseded server service is disabled, legacy WebUI LXC 226 is stopped,
  the prior monorepo release and verified database backup are retained, and
  temporary canary services, credentials and databases are removed.
- Detailed production evidence and rollback instructions are recorded in
  `docs/deployments/README.md`.

---

## 1. Executive outcome

Create a new pnpm monorepo in `potemsla/Pointer` with one product identity:
Pointer.

Recommended source layout:

```text
Pointer/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── cli/
│   └── contracts/
├── docs/
├── deployment/
│   ├── router/
│   ├── systemd/
│   ├── compose/
│   ├── artifacts/
│   └── proxmox/
└── scripts/
```

The monorepo continues to produce independent deployables:

- Pointer server;
- Pointer web;
- Pointer CLI, normally bundled with the server release;
- static and generated Pointer contracts.

Repository topology does not merge runtime authority. Pointer server remains
authoritative for providers, models, groups, instances, inference, persistence,
managed-platform integration, migrations, scheduling, readiness, audit and
retention. Pointer web remains an optional browser client.

---

## 2. Locked owner decisions

The following decisions come from the product owner and are fixed for this
migration:

1. The product name is **Pointer**.
2. `Pointer-Lite`, `Pointer-WebUI` and `Pointer Duo` are not active product
   identities in the new repository.
3. The new `potemsla/Pointer` repository becomes authoritative after its source,
   deployed validation and production acceptance gates pass.
4. The new repository does not need the complete Git history of either current
   repository.
5. The exact current source heads are retained as provenance, not as imported
   ancestry.
6. Pointer must continue to work as a complete standalone product with its web
   interface.
7. Pointer must also support a server-only/headless installation.
8. Pointer server must retain the managed-platform contract required by the
   future YouEye integration.
9. PostgreSQL remains Pointer's only database.
10. Production deployment and mutation are authorized for this task, subject
    to the backup, canary, acceptance and rollback gates in this plan.

---

## 3. Verified planning baseline

The implementation worker must revalidate these facts before importing source.

### 3.1 Source repositories

Pointer server donor:

- repository: `https://github.com/YouEye-Platform/Pointer-Lite.git`;
- branch: `main`;
- observed head:
  `9435350c95d6a2bd5be2653b543c0490b410bffc`;
- managed-platform implementation:
  `ff56cd6c254800a8eb5f525ce42659062e14170e`.

Pointer web donor:

- repository: `https://github.com/YouEye-Platform/Pointer-WebUI.git`;
- branch: `main`;
- observed head:
  `8acead41203f51ea5728601be8f634658cd4b87c`;
- managed-capability implementation:
  `ac00e33b513a77a66d21c71c986aa5b7bb017671`.

New repository:

- repository: `https://github.com/YouEye-Platform/Pointer.git`;
- observed on 2026-07-30 with no advertised `main`, `master` or tags.

### 3.2 Current toolchain

- package manager: pnpm;
- Pointer server pnpm pin: `10.11.0`;
- Pointer web currently resolves pnpm `10.33.0` because it has no package
  manager pin;
- TypeScript resolved in both repositories: `5.9.3`;
- locally observed Bun: `1.3.14`;
- locally observed Node.js: `20.19.2`;
- server runtime: Bun;
- web framework: Next.js `15.5.20`;
- web runtime artifact: Next standalone output;
- database: PostgreSQL through Drizzle and postgres.js.

The migration must select and pin one supported pnpm, Bun, Node.js and
TypeScript toolchain. The recommended consolidation baseline is pnpm 10.11.0
and TypeScript 5.9.3 unless a separate toolchain change is approved.

### 3.3 Current validation evidence

The current deployment records report:

- 378 Pointer server API/unit/contract tests passed;
- 42 guarded PostgreSQL cases skipped in the normal suite;
- 2,521 assertions;
- 3 CLI tests passed;
- 13 managed PostgreSQL tests passed;
- 21 existing PostgreSQL integration tests passed;
- server typecheck, contract drift check and builds passed;
- web typecheck and production build passed;
- 11 Chromium Playwright tests passed.

The new monorepo cannot lower these gates. Historical results are a baseline,
not a substitute for rerunning them from the new repository.

---

## 4. Product and package naming

Recommended package identities:

- root: `pointer`, private and unversioned;
- server: `@pointer/server`;
- web: `@pointer/web`;
- CLI: `@pointer/cli`;
- contracts: `@pointer/contracts`.

Recommended operational identities for new deployments:

- CLI binary: `pointer`;
- server service: `pointer-server.service`;
- web service: `pointer-web.service`;
- same-origin router service: `pointer-router.service`;
- server artifact: `pointer-server-<version>-<identity>`;
- web artifact: `pointer-web-<version>-<identity>`;
- standalone bundle manifest: `pointer-standalone-<version>`.

Active source, UI and documentation should replace:

- `Pointer-Lite` with `Pointer` or `Pointer server`, depending on context;
- `Pointer-WebUI` with `Pointer web`, where a component distinction is needed;
- `Pointer Duo` with `Pointer`;
- `@pointer-lite/*` with `@pointer/*`;
- `[pointer-lite]` log prefixes with `[pointer]`.

Retain generic existing interfaces:

- `POINTER_*` environment variables;
- the `pointer` CLI command;
- `/api/*`;
- `/v1/*`;
- `/.well-known/pointer`;
- `/api/platform/v1/*`;
- existing database table names and schema version data.

Historical source hashes and old production identities may appear in the
source-provenance record. Do not rewrite historical facts.

The authorized deployment replaces the legacy component service names with
`pointer-server`, `pointer-web` and `pointer-router`, installs releases under
`/opt/pointer`, and cuts `pointer.example.com` over to the same-origin router
after backup, canary and acceptance gates pass. The legacy services and LXC
remain rollback targets during the acceptance window.

---

## 5. Runtime modes

### 5.1 Full standalone Pointer

One LXC may contain:

```text
External reverse proxy / TLS
            |
            v
Pointer HTTP router :8080
       |          |
       |          +--> Pointer web :3000
       |
       +-------------> Pointer server :4000
                              |
                              v
                         PostgreSQL
```

Properties:

- one public origin, such as `https://pointer.example.com`;
- external Nginx Proxy Manager needs one upstream:
  `<pointer-lxc-address>:8080`;
- server and web bind to loopback only;
- the router is the only LXC service exposed to the LAN/public reverse proxy;
- PostgreSQL is local or otherwise privately reachable;
- the browser uses relative same-origin API URLs;
- web remains a separate process and artifact;
- server remains usable without web.

### 5.2 Headless standalone Pointer

Headless mode installs:

- Pointer server;
- PostgreSQL or a protected connection to an existing PostgreSQL service;
- Pointer CLI where required.

It does not require:

- Pointer web;
- the full same-origin router, unless the operator wants a stable public
  front-door port.

The external reverse proxy may target the standalone server listener directly,
or a router profile may forward every Pointer API path to it.

### 5.3 YouEye-managed Pointer

Managed mode installs:

- Pointer server only;
- a dedicated Pointer database and role on YouEye's PostgreSQL service;
- no Pointer web;
- no standalone same-origin management router.

One Pointer process retains two distinct listeners:

- a private management listener reachable only by YouEye Control Panel;
- an inference listener reachable by authorized applications.

The management listener must never be placed behind the public standalone
router. Same-origin standalone convenience must not weaken managed listener
isolation.

---

## 6. Same-origin routing design

### 6.1 Router responsibility

Use a small, committed HTTP-only reverse-proxy configuration inside the full
standalone LXC. Nginx is the recommended initial implementation because its
route precedence, request buffering and streaming behavior can be configured
and tested explicitly.

The internal router terminates no TLS. TLS remains at the existing external
proxy.

Recommended route ownership:

| Public path | Internal target | Owner |
|---|---|---|
| `/.well-known/pointer` | server `127.0.0.1:4000` | deployment capability |
| `/api/*` | server `127.0.0.1:4000` | standalone management API |
| `/v1/*` | server `127.0.0.1:4000` | inference gateway |
| `/healthz` | server `127.0.0.1:4000` | core process health |
| `/readyz` | server `127.0.0.1:4000` | core readiness |
| `/_pointer/web/version` | web `127.0.0.1:3000` | web build identity |
| `/_pointer/web/healthz` | web `127.0.0.1:3000` | web process health |
| `/_next/*` | web `127.0.0.1:3000` | Next assets |
| all other paths | web `127.0.0.1:3000` | browser pages/public assets |

Pointer web currently owns `/api/version`. That conflicts with routing all
`/api/*` to the server. Move the web-only version route to
`/_pointer/web/version` before enabling the same-origin router. Do not create
ambiguous per-location exceptions for a long-term component-health contract.

### 6.2 Browser configuration

For the same-origin standalone artifact:

- build Pointer web with an empty `NEXT_PUBLIC_API_URL`;
- browser calls remain relative;
- do not set the current development-only `API_PROXY_TARGET`;
- let the dedicated router forward backend paths directly to Pointer server.

This avoids baking an installation-specific public server hostname into the
browser bundle.

A separately deployed two-origin web artifact may continue to use an explicit
`NEXT_PUBLIC_API_URL`, but it is not the preferred full-stack deployment.

### 6.3 Inference proxy requirements

For `/v1/*`, the router must:

- disable response buffering;
- disable request buffering where streaming/request semantics require it;
- preserve streaming chunks without coalescing;
- preserve `Authorization`, `Content-Type`, request ID and approved protocol
  headers;
- use an appropriate HTTP version and connection behavior;
- retain long read timeouts for model streams;
- propagate client cancellation;
- enforce reviewed request size and header limits;
- avoid response compression that changes existing proxy behavior;
- never log authorization or provider material.

Acceptance must exercise OpenAI Chat Completions, OpenAI Responses and
Anthropic Messages, including streaming and cancellation, through the public
same-origin route.

### 6.4 Forwarded identity

The external proxy and internal router must preserve a reviewed forwarding
chain:

- `Host`;
- `X-Forwarded-Host`;
- `X-Forwarded-Proto`;
- `X-Forwarded-For`;
- Pointer request IDs.

Pointer must not trust arbitrary client-supplied forwarding headers. The final
deployment should define trusted proxy hops or overwrite forwarding headers at
the internal boundary.

---

## 7. Single-LXC deployment profiles

### 7.1 Full profile

The full profile installs and wires:

- PostgreSQL;
- Pointer server on loopback port 4000;
- Pointer web on loopback port 3000;
- Pointer router on port 8080;
- server and web release metadata;
- database migration tooling;
- backup and rollback tooling.

The installer generates only non-secret service and router configuration.
Secrets remain in protected root-readable environment/configuration files and
must never be printed or embedded in artifacts.

Systemd dependencies should ensure:

1. PostgreSQL is available;
2. reviewed migrations have completed;
3. Pointer server becomes ready;
4. Pointer web starts;
5. Pointer router starts only when its upstream processes are available.

Service restart policy must not create an uncontrolled migration loop.

### 7.2 Headless profile

The headless profile installs:

- PostgreSQL when requested, or uses an existing protected database;
- Pointer server;
- Pointer CLI when requested;
- no web artifact;
- no web service;
- no web routes.

The same Pointer server artifact must be used by full, headless and managed
profiles.

### 7.3 Proxmox automation boundary

The repository contains sensitivity-safe definitions for preparing or
converting an LXC and installing a selected profile. LXC 225 mutation and the
production cutover are authorized by this plan.

Recommended lifecycle:

1. build and verify immutable artifacts outside production;
2. create a disposable test LXC;
3. install the full profile;
4. validate same-origin operation and rollback;
5. destroy or retain the disposable LXC according to owner direction;
6. create or select the production LXC only under an approved cutover plan.

The implementation must first prove the build in an isolated canary database
and alternate ports on LXC 225. Only then may it promote the release and update
the external proxy; LXC 226 remains an immediate web rollback target.

---

## 8. Source import design

### 8.1 No history import

Do not use `git subtree`, unrelated-history merges or repository renames.

Import only tracked files from the revalidated donor heads:

- current server package into `apps/server`;
- current web application into `apps/web`;
- current CLI into `packages/cli`;
- current static contracts into `packages/contracts/specs`;
- selected active documentation into the new root documentation structure.

Do not import:

- donor `.git` directories;
- node_modules;
- build output;
- `.next`;
- Playwright output;
- environment files;
- database dumps;
- temporary artifacts;
- old deployment artifact branches;
- Pointer V05;
- old raw release staging directories.

### 8.2 Provenance

Create `docs/migration/source-baseline.md` containing:

- both donor repository URLs;
- exact imported commit hashes;
- import date;
- a statement that Git history was intentionally not imported;
- a statement that the old repositories remain the historical record;
- validation results at the source snapshot;
- no secret or environment information.

The first import commit should reference that record.

### 8.3 Old repositories

Until the new Pointer source, artifacts and deployment path are accepted:

- Pointer-Lite and Pointer-WebUI remain the current operational source record;
- do not force-push, delete or rewrite them;
- do not archive them as part of the initial source task.

After the authorized cutover and acceptance window:

- mark them read-only/archive;
- add short relocation notices;
- retain their issues, releases and historical deployment evidence.

---

## 9. Root workspace

Final workspace:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Requirements:

- one root `package.json`;
- one root `pnpm-workspace.yaml`;
- one root `pnpm-lock.yaml`;
- no component lockfiles;
- no npm or Yarn lockfiles;
- root Sharp build permission compatible with the selected pnpm version;
- TypeScript 5.9.3 pinned exactly during consolidation;
- package-specific tsconfig files extending only genuinely shared defaults;
- no server-to-web runtime dependency;
- no web-to-server source import.

Recommended root commands:

```text
pnpm build
pnpm build:server
pnpm build:web
pnpm typecheck
pnpm test:unit
pnpm test:postgres
pnpm test:e2e
pnpm contracts:check
pnpm artifact:server
pnpm artifact:web
pnpm verify
pnpm verify:full
```

Every referenced component script must actually exist. `verify` may be a fast
static/unit gate. `verify:full` must aggregate the complete release matrix or
provide a machine-verifiable CI run identifier covering every required job.

---

## 10. Contract consolidation and YouEye readiness

`packages/contracts` owns:

- managed Platform V1 OpenAPI;
- public deployment-capability schema;
- catalog schema;
- management schema;
- gateway compatibility schema;
- generated TypeScript types;
- contract version metadata;
- deterministic generation and drift checks.

Perform contract work in separate commits:

1. move the current specifications byte-for-byte;
2. reproduce the current managed generated output;
3. make generation deterministic from the contracts package;
4. add the public `/.well-known/pointer` capability schema;
5. consume its generated type and validation boundary in server and web;
6. introduce additional browser-facing generated types only where current
   contracts describe the full response accurately.

Do not expose to Pointer web:

- host assertion internals;
- one-time application access payloads;
- managed credential delivery;
- server-only authorization helpers;
- private platform operations.

Every server release intended for YouEye must include:

- managed OpenAPI;
- management contract version;
- inference contract version;
- schema version;
- component version;
- exact source commit;
- build toolchain identity;
- artifact checksum;
- migration and rollback classification;
- compatibility notes.

---

## 11. Database and migrations

The monorepo migration does not change the database engine or schema.

Do not add:

- SQLite;
- an in-memory production database;
- a second Drizzle dialect;
- silent persistence fallbacks.

Pointer's existing production process applies reviewed SQL migrations in
numeric order and does not use `db:push` against production. Preserve that
discipline.

Before automated full-stack installation is accepted, implement or document a
controlled migration job that:

- initializes a fresh PostgreSQL database;
- upgrades a supported existing Pointer database;
- records the applied schema version;
- refuses an unsupported or ambiguous schema;
- runs once per release, not on every service restart;
- provides a database-name safety guard for destructive tests;
- supports backup, restore rehearsal and rollback classification.

The full LXC installer must not expose PostgreSQL publicly by default.

---

## 12. Artifacts and releases

### 12.1 Server artifact

The server artifact must include only what the server/CLI runtime needs,
including:

- server source or reviewed bundled runtime;
- dynamic provider manifests and handlers;
- SQL migrations;
- CLI;
- managed OpenAPI;
- production package metadata and lock information;
- build and compatibility manifest.

It must not include:

- Pointer web source;
- `.next`;
- Playwright;
- web-only dependencies;
- browser test output.

### 12.2 Web artifact

The web artifact must contain:

- Next standalone server;
- static assets;
- public assets;
- same-origin build configuration;
- web build manifest.

It must not include:

- server source;
- migrations;
- database tooling;
- provider handlers;
- server-only dependencies.

Monorepo output tracing must be configured and tested so the standalone entry
path remains known and stable after moving the project under `apps/web`.

### 12.3 Release tags

Recommended component tags:

- `server-v<semver>`;
- `web-v<semver>`.

Recommended coordinated standalone bundle tag when needed:

- `pointer-v<semver>`.

YouEye monitors compatible server releases only. A web-only release is not a
YouEye Pointer update.

---

## 13. Implementation work packages

### Phase 0 — Revalidate and freeze

Deliver:

- current donor heads;
- clean worktrees;
- new repository remote state;
- current dependency/toolchain versions;
- current validation baseline;
- confirmation production is untouched.

Exit:

- exact source snapshots are unambiguous.

### Phase 1 — Initialize Pointer and import source

Deliver:

- new repository working tree on `f-initial-monorepo`;
- `apps/server`;
- `apps/web`;
- `packages/cli`;
- `packages/contracts/specs`;
- source provenance record;
- no donor Git history or generated output.

Exit:

- imported files match the selected tracked source snapshots.

### Phase 2 — Apply Pointer identity

Deliver:

- Pointer-only product naming;
- new package names;
- log and CLI naming;
- contract titles and identifiers;
- active documentation rewrite;
- no Pointer-Lite or Pointer Duo active product wording.

Exit:

- naming search reports only intentional migration/historical references.

### Phase 3 — Consolidate the workspace

Deliver:

- one root workspace;
- one root lockfile;
- exact TypeScript pin;
- selected pnpm/Bun/Node toolchain;
- root scripts;
- clean frozen install;
- unchanged important dependency resolutions.

Exit:

- server, CLI and web build independently through root filters.

### Phase 4 — Consolidate contracts

Deliver:

- contracts package;
- deterministic generation;
- drift check;
- public capability schema;
- safe server/web consumption boundary;
- release packaging of managed OpenAPI.

Exit:

- contract generation is repeatable and all consumers pass typecheck/tests.

### Phase 5 — Add same-origin standalone routing

Deliver:

- web version/health routes outside `/api/*`;
- relative browser API operation;
- committed internal router template;
- full and headless deployment profiles;
- no managed-listener exposure through the standalone router.

Exit:

- one hostname serves both the Pointer browser and all standalone APIs;
- streaming inference passes through the router without semantic change.

### Phase 6 — Build independent artifacts

Deliver:

- server artifact builder and allowlist;
- web artifact builder and allowlist;
- checksums and manifests;
- isolated canaries;
- independent rollback proof.

Exit:

- neither artifact contains the other component's runtime.

### Phase 7 — Root CI and acceptance

Deliver:

- frozen install;
- typechecks;
- contract checks;
- unit/CLI tests;
- all guarded PostgreSQL suites;
- web production build;
- 11 or more E2E tests;
- same-origin full-stack E2E;
- headless smoke;
- managed-host simulation;
- artifact inspection;
- sensitivity review.

Exit:

- one exact clean commit passes the complete matrix.

### Phase 8 — Source cutover

Authorized for this task.

Deliver:

- push reviewed branch;
- Forgejo CI on the pushed commit;
- merge to `main`;
- fresh clone;
- branch protection and hooks;
- new repository documented as authoritative;
- old repositories still readable.

Exit:

- a fresh clone reproduces all source and artifact gates.

### Phase 9 — Single-LXC production cutover

Authorized for this task.

Deliver:

- disposable LXC rehearsal;
- database backup and restore proof;
- full profile installation;
- one-origin public canary;
- protected production migration decision;
- atomic component promotion;
- rollback proof;
- old LXC disposition decision.

Exit:

- production runs exact released artifacts and previous releases remain
  recoverable.

---

## 14. Validation matrix

### Source and workspace

- Fresh clone succeeds.
- Frozen root installation succeeds.
- Only one active lockfile exists.
- Root filters find server, web, CLI and contracts.
- TypeScript 5.9.3 is the only release-gate compiler.
- Important resolved dependency versions remain intentionally unchanged.
- No generated/build/test output is tracked.

### Server

- Existing API/unit/contract baseline is met or exceeded.
- CLI tests pass.
- Catalog PostgreSQL suites pass against an explicitly disposable database.
- Managed PostgreSQL suite passes.
- API and CLI builds pass.
- Provider manifests and dynamic handlers load from the artifact.
- Every SQL migration is packaged.
- Health and readiness report exact build/schema identity.

### Web

- Typecheck passes.
- Next production build passes.
- Standalone assembly passes from the monorepo layout.
- Existing 11 E2E tests pass at minimum.
- Standalone login and registration remain available.
- Managed, unavailable and unsupported capabilities fail closed.
- Web artifact uses relative API paths in the same-origin profile.
- Web health/version remain reachable outside `/api/*`.

### Same-origin full stack

- One public hostname renders Pointer web.
- `/.well-known/pointer` reaches server.
- `/api/*` reaches server and local authentication works.
- `/v1/models` reaches server with application authorization.
- OpenAI and Anthropic inference paths work.
- Streaming is not buffered.
- Client cancellation reaches server/provider handling.
- Web static/public assets load.
- No CORS error occurs.
- Browser network traffic does not contact provider or benchmark origins.
- Server and web local ports are not publicly exposed.
- Restart preserves database state.

### Headless

- Server starts without web files or dependencies.
- PostgreSQL readiness passes.
- CLI/API administration works as documented.
- Inference works.
- No router or web service is required.

### Managed/YouEye simulation

- Server starts without web.
- One process opens two distinct listeners.
- Management cannot serve inference.
- Inference cannot serve management.
- Host assertions remain fail-closed.
- Application installation, group selection, rotation, disable/enable and
  archival pass.
- Managed management listener is absent from the standalone public router.
- Managed OpenAPI in the artifact matches generated types.

### Security and sensitivity

- No secrets in source, artifacts, logs, screenshots or evidence.
- No environment files in artifacts.
- No database URLs in reports.
- No browser storage state retained.
- Router logs redact authorization.
- PostgreSQL is not publicly bound.
- Only intended LXC ports are reachable.

---

## 15. Rollback

### Before push

If work stops before the first push, retain the working tree for diagnosis
unless the owner explicitly requests cleanup. Donor repositories remain
unchanged.

### After source push but before cutover

Keep the new repository available for correction without making it
authoritative. Do not mutate donor `main` branches.

### After source cutover

Use normal revert commits in Pointer. Do not rewrite `main`.
The old repositories remain available as the source and deployment history.

### After standalone deployment

Rollback components independently:

- restore the previous Pointer server artifact, subject to schema compatibility;
- restore the previous Pointer web artifact;
- restore the previous router configuration;
- restore the database only when the migration classification requires it.

The coordinated standalone bundle manifest must identify the exact prior
server, web and router revisions.

---

## 16. Explicit non-goals

This implementation does not require:

- old repository deletion or history rewriting;
- importing donor Git history;
- importing Pointer V05;
- YouEye Control Panel implementation;
- YouEye Settings > AI implementation;
- YouEye Market integration;
- TypeScript 7;
- Next.js major upgrade;
- Bun major upgrade;
- PostgreSQL major upgrade;
- SQLite;
- database schema redesign;
- provider or routing redesign;
- combined server/web runtime process;
- public exposure of the managed management listener;
- TLS termination inside the Pointer LXC.

---

## 17. Completion report requirements

An implementation report must separate:

1. source state;
2. Git/push/merge state;
3. dependency and toolchain state;
4. contract state;
5. build and test state;
6. database state;
7. artifact state;
8. deployment state;
9. remaining risks;
10. exact rollback and verification instructions.

The report must state explicitly whether:

- the new Pointer repository is only local, pushed or authoritative;
- production changed;
- either old repository was archived;
- either current LXC changed;
- a database migration occurred.

All retained evidence must be sensitivity-checked.

---

## 18. Authorized execution boundary

The product owner authorized this complete task:

> Initialize the empty `potemsla/Pointer` repository as a Pointer-only pnpm
> monorepo on `main`; import the exact current tracked server and web source
> snapshots without their Git histories; organize server, web, CLI and
> contracts under the target layout; consolidate the workspace on TypeScript
> 5.9.3; preserve standalone, headless and managed behavior; add a one-origin
> standalone router and single-LXC full/headless deployment definitions; build
> independent artifacts; fix encountered pre-existing issues; run the complete
> local and deployed validation matrix; preserve provider credentials where
> possible; iterate until acceptance passes; deploy the full stack on the
> existing Pointer LXC; document the result; and push the verified repository
> to `main`.

If a live provider requires re-authentication, pause only that provider
acceptance and request owner action. Continue all work that does not depend on
the missing authorization.
