# Managed boundary threat model

## Assets and trust boundaries

Protected assets are provider credentials, Pointer inference credentials,
management authority, server-wide routing configuration, application
attribution, usage history, and audit history. The trusted boundary contains
Pointer server, PostgreSQL, the host control plane that signs assertions, and the
host's protected application-configuration store.

Application networks and browsers are untrusted. They may reach only the
inference listener through host routing. The management listener is
host-only/firewall-restricted even though it still requires authentication.
Provider networks are external and never receive platform assertions or
Pointer credentials.

## Principal threats and controls

| Threat | Control |
|---|---|
| Forged or confused-deputy management assertion | Asymmetric JWKS verification; exact issuer, audience, server subject, actor, admin flag, permission, algorithm, time, and lifetime validation |
| Replayed mutation | Required `jti`, durable replay record until token expiry, and mutation idempotency |
| Cross-server or cross-installation access | Persisted integration binding, external-ID validation, ownership predicates, and per-installation advisory locks |
| Browser or application reaches management API | Split listeners, no management routes on inference, host firewall/routing requirement, optional exact management CORS |
| Oversized management payload | 64 KiB platform body limit and strict request schemas |
| Raw credential leakage | Hash-only API-key storage; encrypted, expiring delivery payload; acknowledgement purge; previews on reads; sanitized audit and errors |
| Partial/crashed provisioning | Transactional lifecycle changes and durable idempotent results |
| Unsafe rotation | Prepare/commit/abort state machine, overlap, required delivery acknowledgement before commit |
| Disabled or archived app continues inference | API-key middleware checks installation, instance, key lifecycle, and rotation state on every request |
| Managed resource changed through legacy route | Managed instance/key mutation guards and permission middleware on all management domains |
| Group deletion breaks applications | Default and linked-group deletion guards; historical group identity retained on archive |
| Trust or schema drift | Startup persisted-trust check and `/readyz` checks for schema, service principal, integration, default group, registry, and catalog |
| Sensitive operational logs | Safe fixed log messages, request IDs, allowlisted audit state, no raw assertions or request bodies |

## Availability and residual risks

JWKS, database, and registry failures fail closed for management authentication
or readiness. The inference listener may continue serving previously valid
application traffic when management dependencies outside its request path are
temporarily unavailable. A stale but active catalog reports degraded readiness
rather than billing a provider health-check request.

Network isolation is a deployment responsibility and must be verified from an
application network namespace. PostgreSQL backup encryption, host compromise,
signing-key custody, host configuration-store security, and upstream provider
availability are outside Pointer server's direct control. Audit records intentionally
identify the actor and action but never reproduce request bodies.
