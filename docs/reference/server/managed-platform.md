# Managed platform contract

Managed mode lets one trusted host platform administer a server-wide Pointer
installation without giving applications or browsers Pointer management
credentials. The normative HTTP contract is
[platform-api.v1.openapi.yaml](./contracts/platform-api.v1.openapi.yaml).

## Identity and authorization

The host calls the management listener with a short-lived, asymmetrically
signed Bearer assertion. Pointer server validates the configured issuer, audience, server
subject, algorithm allowlist, lifetime, `jti`, administrator authorization,
permission list, and human `act` actor. A mutation assertion can be consumed
only once. The server subject selects the managed Pointer installation; the
human actor is retained separately for audit.

This lifecycle contract uses service scope. A separate
`pointer_owner_scope=actor` assertion is available to a managed host's
same-origin personal Settings adapter. Pointer maps the stable actor issuer and
subject to an isolated external user; it never treats that assertion as the
service principal and rejects it on every `/api/platform/v1` route. The two
scopes therefore share assertion verification without sharing ownership.

Permissions are least-privilege capabilities:

- `management.read`
- `providers.manage`
- `groups.manage`
- `applications.provision`
- `usage.read`
- `settings.manage`
- `test.inference`

Local HS256 Pointer JWTs are not valid platform assertions. Managed mode does
not expose local registration or login.

## Installation model

One external application installation ID owns exactly one managed Pointer
instance and normally one active `ptr_` inference credential. A service-owned
installation retains the original service-principal routing. An actor-routed
installation instead stores an explicit external routing owner; every user of
the host application shares that application's credential, while routing and
usage belong to the selected YouEye owner.

The instance routes only its selected model group. Omitting `groupId` on first
ensure selects the current default group. The default is a new-install
preselection, not a universal model pool: changing the default never relinks an
existing installation. Editing a selected group changes routing immediately,
and explicit group reassignment preserves the instance and credential.

Provider credentials remain encrypted under the applicable service or actor
owner and are never delivered to applications. The application receives only
its own Pointer inference credential.

An actor other than the current routing owner cannot reassign the group. The
host must call the explicit takeover operation, which moves the instance,
active key, and group to the new actor without changing the external
installation ID. Actor disable immediately disables linked installations and
inference. Reactivation never silently resumes them; a host enable or explicit
takeover is required.

## Mutations and recovery

Every platform mutation requires an `Idempotency-Key` between 8 and 200 safe
characters. Repeating the same operation, key, and body returns the durable
result. Reusing a key for a different body returns `idempotency_conflict`.
Operations serialize on the external installation identity, so concurrent
ensures cannot create duplicate instances or credentials.

Ensure and rotation prepare may return `credentialDelivery`. That object is the
only secret-bearing platform response. Its payload is encrypted at rest,
expires after a bounded interval, is recoverable with the same idempotent
request until expiry, and is permanently purged after acknowledgement. GET and
list responses contain previews only.

Rotation is explicit:

1. Prepare creates a pending credential while the old credential remains valid.
2. The host stores and validates the new credential.
3. The host acknowledges its delivery.
4. Commit activates it and retires the old credential, or abort revokes the
   pending credential and preserves the old one.

After a committed rotation, rollback means another controlled rotation; the
old raw credential cannot be reconstructed.

## Errors and compatibility

Platform errors have one stable envelope containing HTTP `status`, machine
`code`, safe `message`, `requestId`, `retryable`, and optional safe `details`.
Responses never contain stack traces, provider bodies, assertion contents, or
credentials.

Contract version `1` is additive: optional response fields and new enum values
may be added only when old consumers remain safe. Removing or changing a field,
authentication rule, operation, or lifecycle transition requires a new
versioned base path. Deprecations must be published before removal and the old
version retained through at least one coordinated host release.

Generate TypeScript types deterministically:

```bash
pnpm --filter @pointer/server contracts:generate
pnpm --filter @pointer/server contracts:check
```

The generated source is
`apps/server/src/generated/platform-api-v1.ts`. Host integrations should
generate from the OpenAPI document instead of maintaining handwritten response
types.
