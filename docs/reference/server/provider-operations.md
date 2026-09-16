# Provider Operations

Provider operations are user-scoped and optional. Pointer server stores credentials encrypted and returns only capability state, freshness, safe account fields, and sanitized errors.

| Provider capability | Providers | Credential | Refresh | Failure behavior |
| --- | --- | --- | --- | --- |
| Model inventory | Every connected provider | User provider key or user-owned OAuth credential | Startup, hourly, post-connect, and manual Refresh Models | Fetch all declared pages before persistence; preserve the last complete reconciled inventory on HTTP, schema, cursor, or empty-result failure |
| Balance | OpenRouter, Together | User provider key | Manual and scheduled; default 5 minutes, configurable by admin | Preserve last value and timestamp; expose `error` status |
| Rate limits | Any provider returning standard rate-limit headers | User provider key used by proxy | Captured on proxy responses | Preserve last headers and freshness independently of provider health |
| Account info | OpenAI Codex and Grok subscription handlers | User-owned encrypted OAuth credential | Manual, post-connect, and scheduled with provider operations | Allowlisted plan/tier, state and masked account suffix only; preserve last value on failure |
| Admin/management keys | None | Not retained | Disabled | Schema compatibility fields remain dormant and are never returned |
| Cross-user key sharing | None | Not retained | Disabled | Registry resolves only the authenticated user's own provider key |

Unsupported capabilities return `supported: false` with a reason rather than zero or an empty success. Artificial Analysis and OpenCode integrations remain excluded. Source refresh, balance refresh, and usage retention intervals are controlled by the admin settings API and are re-read by the maintenance loop.

Model inventory refresh is metadata-only. It issues GET requests to the model-list
contract declared by the provider manifest or account-scoped handler and never calls an
inference endpoint. See [model-discovery.md](./model-discovery.md) for the typed manifest
contract, completeness guarantees, current built-in provider endpoints, and troubleshooting.

## Inference operations

Provider manifests separately declare typed gateway operations. Generation uses `generate` and,
where the provider has a distinct action URL, `streamGenerate`. Google-native providers may also
declare `countTokens`, `embedContent`, and `batchEmbedContents`. Endpoints may contain a `{model}`
placeholder; Pointer URL-encodes the resolved provider model path segment and removes the routing
model from the JSON body before provider I/O.

The built-in Google Gemini manifest uses native `v1beta` model actions and `x-goog-api-key` rather
than Google's OpenAI-compatible façade. Per-model `supportedGenerationMethods` controls dispatch
when discovery provides it. Missing operations are rejected or, for token counting only, replaced
with an explicitly labeled Pointer estimate. See
[google-gemini-cli.md](./google-gemini-cli.md) for the public contract.
