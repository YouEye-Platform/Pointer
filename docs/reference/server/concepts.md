# Concepts

These five entities are how Pointer decides *what a client can call* and *where it goes*.

## Providers & manifests

A **provider** is an upstream model API (OpenAI, Anthropic, DeepInfra, OpenRouter, Groq, …). Providers
are described declaratively by **manifest** YAML files in `apps/server/providers.d/` — 16 ship built
in. A manifest defines the base URL, auth type, endpoints, and how to discover the provider's models:

```yaml
id: deepinfra
name: DeepInfra
type: openai-compatible          # or anthropic-compatible / custom
baseUrl: https://api.deepinfra.com/v1/openai
auth:
  type: bearer                   # bearer | header | query | oauth-device-flow | none
endpoints:
  chatCompletions: /chat/completions
  models: /models
models:
  capabilityFallbacks:
    - modelId: provider-model-id
      supportsVision: true
  discovery:
    enabled: true
    listPath: data
    idField: id
```

`capabilityFallbacks` is an exact raw-model-ID safety valve for incomplete discovery APIs. A
fallback is used only when the provider omitted an explicit boolean; provider-declared `true` or
`false` always wins. Unmatched models retain Pointer's conservative defaults. Keep external
evidence for every fallback in the provider-specific documentation and remove the fallback if the
provider starts returning authoritative capability metadata.

Manifests are a **catalog**, not auto-activated. A provider only becomes active (usable for routing)
once you add it — which stores an (encrypted) API key and triggers a model sync:

```
POST /api/providers/from-manifest  { manifestId, apiKey?, label? }
```

You can also import a custom manifest via `POST /api/providers/import { yaml }`.

OAuth device-flow manifests are activated without a key, then connected through the user-scoped
device authorization routes. Completed access and refresh credentials are encrypted in the same
ownership boundary as API keys. See [subscription-providers.md](./subscription-providers.md).

## Models

Two model tables:

- **`model_catalog`** — a global catalog of model metadata (name, context window, capabilities).
- **`provider_models`** — which models a specific provider offers, with that provider's internal model
  ID and per-provider pricing/specs. Populated by **model sync** (on startup, hourly, and when a
  provider is added). This is the source of truth for resolving a display name to a concrete
  `providerModelId`.

Clients see **display names** via `GET /v1/models`, never raw IDs. See "Model resolution" in
[architecture.md](./architecture.md).

## Model groups

A **model group** is a curated, ordered set of canonical model entries. Each entry stores the stable
catalog entity and one exact provider-model route, plus an optional alias. One canonical model may
appear only once per group; choosing another provider updates that membership instead of creating a
duplicate. Groups are how you decide which models an instance exposes and what they are called.

Each user with groups has exactly one **default** group (auto-created as "Favorites" on
registration), and any owned group can become the default. The default controls Models-page stars
and the group selected for newly created instances. Changing it does not relink existing instances.
An entry's alias becomes its display name; without one, Pointer server returns the canonical human-readable
catalog name.

The first three **enabled** entries also receive hidden role aliases:

| Enabled position | Hidden aliases |
|---|---|
| 1 | `big`, `opus`, `default` |
| 2 | `medium`, `sonnet`, `secondary` |
| 3 | `small`, `haiku`, `utility` |

These names are accepted in proxy requests but deliberately omitted from `GET /v1/models`. Disabling
or reordering an entry immediately recomputes the mapping. Manual entry aliases are visible in
`GET /v1/models` and cannot use a reserved hidden name.

Catalog availability is not instance availability. A canonical route is available in management
UI when the current user has added its provider. Instances and groups decide what a `ptr_` API key
can route after that; they do not make a model appear available in the catalog.

## Instances

An **instance** is a workspace that scopes which models are reachable. It optionally links one model
group, and can also carry its own custom/provider-toggled models. Every API key is bound to exactly
one instance, so the instance determines the model list that key sees in `GET /v1/models`.

## API keys (`ptr_`)

A `ptr_` key is what a client uses to call the proxy (`/v1/*`). Properties:

- Bound to one **instance** (fixes the model list).
- Carries an **allowedModels** glob list (e.g. `["claude-*", "gpt-*"]`, default `["*"]`) — a second
  filter on top of the instance's models.
- Stored only as a **SHA-256 hash**; the raw key is returned once at creation and never again.
- Revocable (soft delete). Tracks `requestCount` and `lastUsed`.

## Provider key sharing (structural, minimal)

The schema supports sharing a provider key with another user (`provider_key_shares`). Resolution
order when proxying is: the caller's own key for that provider first, then a shared key. Full sharing
UX is deferred backlog.

## Managed service principals and applications

In managed mode, a non-login **service principal** owns server-wide providers,
groups, instances, credentials, and usage. A host platform assertion also names
the human administrator who initiated the action. Ownership belongs to the
service principal; audit attribution belongs to the human actor.

A **managed application** is one host installation mapped to one Pointer
instance and one normal active inference key. All humans using that application
share its Pointer identity. Per-human inference identity is not inferred from
management assertions.

Each application selects one live model group. The default group is merely the
preselection when a new installation does not specify one. Changing the default
does not relink existing applications. Editing a group's entries immediately
changes every linked application's routing, while reassigning an application
preserves its instance and key.

Provider credentials never enter an application. The host stores only that
application's delivered `ptr_` key in protected configuration. See
[managed-platform.md](./managed-platform.md).
