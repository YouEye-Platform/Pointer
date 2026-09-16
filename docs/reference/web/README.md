# Pointer web

Pointer web is the frontend-only control surface for Pointer server. Pointer server owns authentication,
provider credentials, provider discovery, the canonical model catalog, routing, translations,
telemetry, operational state, and persistence. Pointer web renders that state and sends authenticated HTTP
requests to Pointer server; it does not implement a second backend.

## Product surface

- Login and registration use Pointer server JWT authentication.
- Login and registration first consume Pointer server's public deployment capability:
  standalone mode keeps local auth, while managed mode directs administrators
  to host Settings → AI without exposing a local form.
- Dashboard summarizes request volume, tokens, cost, latency, throughput, errors, and recent activity.
- Models initially lists only models offered by the user's added providers, with a Show all toggle,
  search, filters, source health, reference pricing, capabilities, exact provider routes, and
  separate benchmark results. Stars show membership in the current default group.
- Model detail preserves slash-containing canonical identities through encoded slug routing.
- Providers lists configured and discoverable providers, credentials, models, prices, balances, rate
  limits, operational state, and Pointer server-declared API-key or subscription-account connection flows.
- Instances, model groups, and API keys control routing scope. Every model group has a dedicated
  deep-linkable page; any owned group can be selected as default. Group entries use canonical
  human-readable model names and exact added-provider routes, and support keyboard/touch reorder
  buttons, provider changes, enable/disable controls, manual aliases, and Pointer server-supplied hidden-role
  badges. Hidden routes are accepted by the proxy but omitted from `GET /v1/models`.
- Proxy Test exercises Pointer server's `/v1/chat/completions` endpoint with a `ptr_` key. It is not an
  agent host and does not manage subprocesses or sessions.
- Test Model sends a direct, provider-specific request through Pointer server's JWT-authenticated test API.
  It displays streamed reasoning separately from the final answer, reports a
  provider output-limit finish as truncated, and surfaces terminal SSE errors
  without misreporting the run as complete. Its default 512-token output budget
  is intended to leave reasoning models enough room to produce a final answer;
  callers can still choose any supported value from 1 through 4096.
- Usage and Compare show Pointer server-computed telemetry and stable catalog-entity aggregation.
- Admin exposes role-protected user, settings, source reconciliation, and operational controls.
- Admin securely installs or removes an optional Artificial Analysis key through Pointer server; the key is
  never returned to the browser.
- Light, Dark, and System themes share responsive desktop/mobile and keyboard-accessible layouts.

## Ownership boundary

The browser may call only Pointer server and the Pointer web origin. This repository must not:

- own authentication, a database, or provider secrets;
- contact model providers, benchmark sources, or Pointer-Board;
- invent model matching, canonical identity, availability, pricing, or benchmark logic;
- convert missing values to zero or hide source failures;
- add backend route handlers as a substitute for a Pointer server API.

If the control surface needs new authoritative behavior, implement a user-scoped or admin-scoped Pointer server
API first, then consume it here.

## Runtime shape

```text
Browser ── static pages ──> Pointer web
Browser ── JWT or ptr_ key ──> Pointer server ──> approved data sources and model providers
```

Production leaves `NEXT_PUBLIC_API_URL` empty so all browser API requests use
the same Pointer origin. A custom cross-origin URL is a build-time development
option.

Pointer web remains a standalone control surface. It does not implement or
consume host platform administration, and managed Pointer deployments may omit
Pointer web entirely.

See [architecture.md](./architecture.md) for code layout, authentication and
local development, [the deployment guide](../../deployment.md) for the release procedure,
[subscription-provider-ui.md](./subscription-provider-ui.md) for the generic account-connect UI,
[catalog-v1-contract.md](./catalog-v1-contract.md) for the client contract, and
[benchmarks-and-icons.md](./benchmarks-and-icons.md) for dynamic benchmarks, AA setup, and the
neutral icon policy.
