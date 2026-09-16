# Managed mode and YouEye

Pointer server supports a headless managed mode intended for a host platform
such as YouEye. Web is not required.

Managed mode creates two distinct listeners:

- management: loopback/private control-plane operations;
- inference: application-facing OpenAI/Anthropic-compatible traffic.

YouEye runs these on private container ports 4001 and 4002 respectively. Its
same-origin Settings adapter is the only browser path to management; Caddy
publishes only `/v1`, `/v1/*`, `/v1beta`, and `/v1beta/*` from the inference
listener at the appliance apex. Pointer Web is not installed.

The management listener has no inference routes, and the inference listener
has no management routes. Host assertions use asymmetric JWKS verification,
fixed issuer/audience/subject constraints, short lifetime and clock-skew
limits, replay protection, mutation permissions, request-size limits,
idempotency and audit retention.

## Contract discovery

The host first reads `/.well-known/pointer`. The response advertises deployment
mode, surface availability and managed API version. The canonical managed API
is:

- OpenAPI: `packages/contracts/specs/platform-api.v1.openapi.yaml`;
- generated types: `packages/contracts/src/generated/platform-api-v1.ts`;
- capability schema:
  `packages/contracts/specs/capabilities.v1.schema.json`.

Run `pnpm contracts:check` in CI and before release so the generated types and
capability constants cannot drift.

## Required configuration

Set `POINTER_DEPLOYMENT_MODE=managed`, distinct management and inference bind
addresses/ports, and the platform issuer, audience, subject, integration ID
and HTTPS JWKS URL. Only loopback HTTP JWKS URLs are accepted for local tests.
Signing algorithms are restricted to approved asymmetric RS/ES algorithms.

The platform controls installation lifecycle and receives one-time credential
delivery. Pointer remains authoritative for the created instance, group, key,
routing, usage and audit data. Delivered credentials must never persist in
idempotency or audit payloads.

Market applications use service-authority assertions that still carry the
exact YouEye administrator actor. An ensure request with
`routingOwner=actor` creates the application instance, selected group, and key
under that actor rather than under the service principal. This is deliberately
different from the personal Settings adapter: the host retains lifecycle
authority while inference usage and group ownership stay personal.

## Personal YouEye ownership

Managed assertions have an explicit owner scope:

- absent scope means the original service principal and remains administrator
  only, preserving the application-installation lifecycle contract;
- `pointer_owner_scope=actor` maps the assertion's stable `act.iss` +
  `act.sub` identity to one external Pointer user. The display name and role
  may change without changing ownership.

Actor-scoped assertions cannot call `/api/platform/v1`. They may use the
ordinary management APIs permitted by their assertion, and all provider
accounts, groups, instances, inference keys, catalog availability, and usage
remain isolated to that external user. Pointer creates one `My models` default
group on first use. YouEye signs a fresh two-minute RS256 assertion for each
server-side adapter request; no Pointer management token is returned to the
browser.

Global provider definition import and deletion remain standalone-local admin
operations. A managed actor, including a YouEye administrator, can create and
manage only their own accounts from the host-provided manifest catalog.

## Market application ownership

Every AI-capable Market install has one stable external installation ID, one
managed Pointer instance, and one application credential. Its selected actor
group is live: adding, removing, reordering, or repairing routes changes what
the app sees without reinstalling it. The built-in `default`, `medium`, and
`small` aliases are resolved by the selected group exactly like every other
Pointer client; YouEye does not maintain a second model-routing layer.

Another administrator cannot change the group or silently inherit an existing
application. They must call the explicit routing-owner takeover operation with
one of their groups. Takeover preserves the application installation, instance,
key, and attribution history while moving future group routing and usage to the
new owner.

YouEye maps application lifecycle to Pointer lifecycle:

- stop disables the managed instance and key; start enables it again;
- restart and update preserve the instance, key, owner, and group;
- uninstall archives the installation, revokes credentials, and hides the
  archived instance from the normal instance list;
- failed install rolls back the Pointer installation and protected key;
- deleting or disabling the routing owner disables all of their linked apps;
  another administrator must take each app over explicitly to recover it.

Only inference port 4002 is proxied into an application network. Management
port 4001 is never exposed to applications. Applications receive only their
own `ptr_` key, and YouEye stores it in the app's protected secret scope rather
than install metadata, events, logs, or API responses after delivery.

## Provider accounts and routing

A provider is a reusable protocol definition. A provider account is one
user's nickname, credential, optional custom base URL, and status. A user may
connect the same provider repeatedly. API-key and OAuth device credentials are
stored against the exact account, and a model-group entry records the selected
provider account internally. Public inference discovery continues to show the
model's human name; it never exposes provider account IDs or nicknames.

When several owned accounts can serve the same provider route, management must
supply `providerAccountId`; Pointer never picks one implicitly and never falls
back to a different account after an upstream error. Custom base URLs must be
public HTTPS URLs, resolve only to public addresses when saved, and are
revalidated before use.

Model availability is also account-specific. Each successful complete sync
replaces that account's provider-model mapping, while the shared catalog keeps
the union needed for friendly presentation. A credential alone never makes a
route available if that exact account did not report the model.

## YouEye lifecycle and recovery

YouEye provisions Pointer as the `youeye-pointer` core LXC, uses a dedicated
`pointer` database in the shared PostgreSQL service, stores only generated
Pointer secrets below `/var/lib/youeye/pointer`, and writes a mode-0600 runtime
environment. It runs the artifact's migration entrypoint before starting or
restarting the service. The Pointer database and secret directory are included
in encrypted core backup and restore; Pointer is quiesced with the other core
services.

The repository-owned `.youeye/build/pointer` entrypoint emits the headless
`standalone.tar` consumed by YouEye-Infra. The archive contains the Bun server,
migration runner, numbered SQL migrations, provider manifests, package
metadata and a source-bound `release-manifest.json`; it contains no Web UI,
credentials, or legal files not established by Pointer-owned repository context.

For pre-release integration, YouEye-Infra's unsigned fast-development lane can
build this exact manifest from a pushed Pointer commit and apply it to one
exact-identity test VM. The deployment runs migrations from the candidate,
atomically swaps `/opt/pointer`, preserves `/etc/youeye-pointer.env` and all
database/provider state, checks both `/readyz` listeners, and automatically
restores the pre-deploy VM checkpoint on failure. It does not create a tag,
signature, public release, or appliance.

## Integration gate

Before YouEye production integration:

1. run managed contract and PostgreSQL tests;
2. verify listener route separation from the deployed artifact;
3. test JWKS rotation and JWKS outage fail-closed behavior;
4. test replay rejection and mutation permission enforcement;
5. test actor-routed install, delivery, group propagation, explicit takeover,
   owner disable, enable, rotation, abort, archive, and hidden archive state;
6. confirm applications can reach inference but not management and ordinary
   users cannot mutate managed resources;
7. verify retained inference attribution after takeover, rotation and archival.

See `docs/reference/server/managed-platform.md` and
`docs/reference/server/managed-threat-model.md` for endpoint and threat-model
detail.
