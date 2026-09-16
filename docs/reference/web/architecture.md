# Architecture and operations

## Boundary

Pointer web is a Next.js App Router application whose product pages are browser clients of
Pointer server. It has no application database, credential store, source adapters, routing engine, or
model-identity implementation. Next serves the built application and a non-secret build-identity
endpoint; all product authority remains in Pointer server.

The browser calls Pointer server directly using `NEXT_PUBLIC_API_URL`. Local development may use the
`API_PROXY_TARGET` rewrite so a connector preview can reach Pointer server same-origin. That rewrite is
disabled in production and must never be used to add Pointer web-owned backend behavior.

Before showing a login or registration form, Pointer web reads Pointer server's unauthenticated
`/.well-known/pointer` capability contract. Standalone Pointer server reports local auth
available and the existing forms remain unchanged. Managed Pointer server reports local
auth unavailable, so Pointer web shows host-owned `Settings → AI` guidance and never
submits local credentials. A capability outage suppresses the forms with a
retryable connection state; a 404 alone is treated as compatibility with an
older standalone Pointer server release. Pointer web supports capability contract `1`; an
unknown version fails closed with the same actionable connection state.

Pointer web does not call the protected `/api/platform/v1` host contract and
is not required in a managed deployment. The host control plane owns that
integration.

## Code layout

```text
src/
  app/
    login, register                 Pointer server authentication
    (dashboard)/
      dashboard                     summary telemetry and recent activity
      models, models/[slug]         V1 catalog list and detail
      providers, providers/[id]     provider configuration and operational state
      instances, instances/[id]     routing instances
      keys, keys/[id]               ptr_ key lifecycle and scope
      groups, groups/[id]           summaries plus dedicated model-group management
      chat                          proxy-test client
      test-model                    direct provider/model test client
      usage, compare                Pointer server-computed telemetry
      admin                         role-protected administration
  components/
    IconAvatar                      allowlisted bundled brand icons with local monogram fallback
    Modal                           accessible dialog primitive
    ModelGroupStar                  anchored group/provider placement popover
    RecentActivity                 dashboard activity
    TestTargetPicker               Pointer server-discovered provider/model selection
    ThemeSelector                  Light, Dark, and System preference
  lib/
    api.ts                          base URL, JWT helpers, 401 handling, proxy stream reader
    deployment capability types    public standalone/managed compatibility only
    catalog.ts                      V1 catalog response types and display-only formatting
    groups.ts                       Pointer server group summary/detail/entry response types
    stats.ts                        statistics response types
    store.ts                        auth hydration and local token state
    test-model.ts                   direct-test response types
```

Model and provider display helpers may format dates, token counts, and known numeric values. They may
not create canonical IDs, infer missing prices, merge benchmark scores, or decide provider
availability.

## Authentication

1. Login or registration sends credentials to Pointer server and receives `{ token, user }`.
2. Zustand stores the management JWT in `localStorage` as `pointer_token`.
3. The dashboard hydrates the session through `GET /api/auth/me`.
4. Management API requests send `Authorization: Bearer <JWT>`.
5. A Pointer server 401 clears the management token and redirects to `/login`.
6. Proxy Test uses a separate `ptr_` API key stored as `pointer_proxy_key`; management JWTs are
   never substituted for proxy keys.

Managed mode has no Pointer web management session: the login/register pages render
host guidance and do not redirect between each other, preventing an auth loop.

Provider authentication failures must remain provider errors. They must not be treated as a Pointer
management-session failure.

Provider authentication controls are capability-driven. Pointer web renders Pointer server's declared API-key,
generic OAuth device-flow, or legacy compatibility path; it never owns an OAuth client, token
endpoint, device code, refresh policy, or provider credential. Device polling calls Pointer server only and
uses Pointer server's returned interval. See [subscription-provider-ui.md](./subscription-provider-ui.md).

## Catalog flow

The Models pages call only `GET /api/catalog` and
`GET /api/catalog/detail?slug=<encoded-identity>`. Both are JWT-authenticated Pointer server APIs with
`contractVersion: "1"`. The client renders active generation facts and live source health exactly as
returned. A `503 catalog_unavailable` is an explicit unavailable state, not permission to assemble a
fallback catalog.

Provider raw IDs are display and route evidence, not browser-generated canonical IDs. Pricing,
capabilities, availability, aliases, benchmark descriptors, recommended ranking, and provenance
remain Pointer server-owned. See
[catalog-v1-contract.md](./catalog-v1-contract.md).

Models explicitly requests `availability=available` initially and switches to `availability=all`
only through Show all models. It never loads instances to determine availability. The page loads
group summaries plus `/api/groups/default` once, derives filled stars by stable catalog entity, and
uses one reusable popover to choose a target group and exact available provider route.

The group index only manages summaries and default selection. Entry management lives at
`/groups/[id]`, which consumes Pointer server-enriched canonical names, provider identity, availability, and
hidden role aliases. Add Model reuses the Models page's recommended/ascending catalog query,
supports debounced server search and paging, and sends only `catalogEntityId` plus
`providerModelKey`.

## Configuration

| Variable | Phase | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | build time | Optional API base URL for cross-origin development. Leave empty for production same-origin routing. |
| `API_PROXY_TARGET` | local development only | Rewrites local `/api/*`, `/v1/*`, `/v1beta/*`, and `/.well-known/pointer` requests to a local server. |
| `POINTER_BUILD_REPOSITORY` | build and runtime | Repository identity exposed by `/_pointer/web/version`. |
| `POINTER_BUILD_BRANCH` | build and runtime | Exact source branch exposed by `/_pointer/web/version`. |
| `POINTER_BUILD_COMMIT` | build and runtime | Full immutable commit SHA exposed by `/_pointer/web/version`. |
| `POINTER_BUILD_AT` | build and runtime | UTC build timestamp exposed by `/_pointer/web/version`. |

`NEXT_PUBLIC_*` values are compiled into browser assets. Production leaves the
API URL empty so browser requests remain relative to the Pointer origin.

## Local development

Use pnpm:

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

For a same-origin connector preview, leave `NEXT_PUBLIC_API_URL` empty and set
`API_PROXY_TARGET=http://127.0.0.1:4000`. For direct cross-origin development,
set a server URL and configure the server's exact `CORS_ORIGIN` to the web
origin.

Minimum pre-push verification:

```bash
pnpm --filter @pointer/web typecheck
pnpm --filter @pointer/web build
pnpm test:e2e
```

Browser acceptance also checks authentication, models and providers list/detail, source failure
presentation, instance/group/key changes, proxy test, direct test, usage/compare, admin role
protection, all three themes, mobile overflow, keyboard focus, console errors, failed network
requests, and broken assets.

Playwright runs against the production standalone server rather than Next's file-watching dev
server. `pnpm test:e2e` builds, prepares `.next/standalone`, and then executes the browser suite.

## Production deployment

Build the web artifact from a clean monorepo commit with
`pnpm artifact:web`. Full standalone runs the generated Next standalone output
under Node on loopback port 3000 and puts the Pointer path router in front of it.
See `docs/deployment.md` for installation and same-origin acceptance.
