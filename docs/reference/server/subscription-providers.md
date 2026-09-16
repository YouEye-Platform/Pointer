# Subscription provider authentication

Pointer server supports refreshable provider subscriptions through a provider-neutral OAuth device
authorization engine. The first adapter is `xai-grok`, which targets the account-scoped Grok Build
session service. It is separate from the existing `xai` manifest, which continues to use an xAI API
key and independent API billing.

This integration is an owner-controlled experimental path. It is not a promise that a consumer
subscription can be resold, shared, or used for unattended traffic. xAI's current Acceptable Use
Policy explicitly restricts bot/script/non-human access, while the official Grok Build documentation
also describes device authentication and headless use. Resolve that policy tension with xAI before
enabling broad or unattended traffic. The implementation does not bypass an account gate, rate
limit, subscription check, or provider safety control.

Authoritative references, checked 2026-07-28:

- [Grok Build authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- [Official Grok Build source](https://github.com/xai-org/grok-build)
- [OpenCode xAI provider documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)
- [Hermes xAI OAuth guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/xai-grok-oauth.md)
- [LiteLLM documentation](https://docs.litellm.ai/)
- [xAI Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy)
- [xAI Consumer Terms](https://x.ai/legal/terms-of-service)

The comparison is intentionally scoped. OpenCode and Hermes both separate subscription OAuth from
metered API-key access, automatically refresh OAuth credentials, and use a Responses-style
transport. LiteLLM is useful precedent for provider routing, protocol normalization, streaming, and
telemetry, but its documented xAI path uses `XAI_API_KEY` against the metered API. It does not supply
the subscription device-flow or entitlement design. Pointer therefore reused gateway patterns while
keeping subscription authentication as an explicit provider-handler capability.

## Ownership and boundaries

Pointer server owns the entire authorization protocol, encrypted state, credential refresh, account discovery,
model discovery, and gateway routing. Pointer web only renders Pointer server responses and calls Pointer server's
authenticated management endpoints. The browser never receives a device code, access token, refresh
token, provider user identifier, or encrypted credential value.

The provider manifest declares public OAuth metadata and selects a handler:

```yaml
auth:
  type: oauth-device-flow
  issuer: https://auth.x.ai
  clientId: <public OAuth client identifier>
  scopes: <space-separated scopes>
handler: xai-grok
```

A future provider can reuse the engine by implementing
`startDeviceAuthorization`, `pollDeviceAuthorization`, and
`refreshOAuthCredential`. Its account and model behavior remains isolated in its handler. Providers
that use PKCE, browser callbacks, cookies, proof-of-possession tokens, or a non-OAuth protocol need a
different adapter and must not be forced into the device-flow contract.

The existing Codex device route remains compatible but is not migrated to this engine in the first
release.

## Device authorization lifecycle

1. An administrator activates an OAuth manifest without supplying a key.
2. The user starts device authorization for that active provider.
3. Pointer server requests a provider device code, validates the verification URL, encrypts the device code,
   and stores a short-lived `provider_oauth_device_flows` row scoped to that user and provider.
4. Pointer server returns only the flow ID, one-time user code, verification URL, polling interval, and expiry.
5. Pointer web opens the provider-controlled HTTPS page in a new tab and polls Pointer server at the server-declared
   interval.
6. Pointer server enforces the next-poll time and expiry before contacting the provider token endpoint.
7. Success atomically replaces that user's provider credential with an encrypted, versioned OAuth
   envelope. Pending device state is deleted, then account and model refreshes start.
8. Denied, cancelled, and expired flows never create a provider credential.

Management routes:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/providers/:id/oauth/device/start` | Start one user/provider device flow |
| `POST` | `/api/providers/:id/oauth/device/:flowId/poll` | Perform one rate-limited provider poll |
| `DELETE` | `/api/providers/:id/oauth/device/:flowId` | Cancel and delete pending state |

Every route requires a Pointer management JWT. Flow lookup includes the authenticated user ID and
provider ID, so a flow identifier alone is not an authorization capability.

## Credential storage and refresh

Completed OAuth credentials reuse the encrypted `provider_keys.api_key_encrypted` column so current
ownership, cascades, catalog availability, and deletion behavior stay intact. The decrypted value is
either a legacy opaque API key or a marked version-1 OAuth envelope containing the access token,
optional rotating refresh token, expiry, safe provider user identifier, issuer, and public client
identifier.

The entire envelope is encrypted with the existing AES-256-GCM service before persistence. A marked
but malformed envelope fails closed and is never sent upstream as an API key. Raw credentials are
never returned by management APIs or written to logs.

Pointer server refreshes an OAuth access token up to two minutes before expiry. Refresh is single-flight per
process and user/provider pair. A rotated refresh token replaces the old encrypted envelope; if the
provider omits a replacement refresh token, Pointer server retains the previous one. A transient refresh
failure may use the existing token only while it is still valid. Expired and unrefreshable
credentials resolve as unavailable. Provider-declared terminal refresh failures are quarantined in
the running registry so ordinary requests do not repeatedly submit a rejected refresh token; a new
account connection creates a new credential identity.

Disconnecting an account deletes the credential and pending device state. It does not revoke the
provider-side grant because xAI does not currently expose a revocation contract in the public Grok
Build flow; use the provider's account controls if server-side revocation is required.

## Grok adapter

`xai-grok` follows the public contracts used by the official Grok Build source:

- issuer `https://auth.x.ai`;
- RFC 8628 device and token endpoints;
- session service `https://cli-chat-proxy.grok.com/v1`;
- provider-required token-auth, client identity, client mode, authentication-response, and user
  identity headers;
- account-scoped `/models` and `/user?include=subscription` discovery.

Only a safe account projection is persisted: connection state, subscription tier, principal type,
masked user suffix, and blocked state. Email, names, tokens, raw account payloads, and provider
response bodies are excluded.

Model discovery records the provider-declared `apiBackend` as a per-model native format and endpoint.
The gateway can therefore route one account's models independently to Chat Completions, Messages, or
Responses without pretending that the entire provider has one wire protocol. Missing or invalid
metadata falls back to the manifest's declared generation operation.

The account-scoped model payload currently omits a vision boolean for `grok-4.5`, even though xAI's
official [image understanding documentation](https://docs.x.ai/developers/model-capabilities/images/understanding)
documents image input for that model. The `xai-grok` manifest therefore declares an exact-model
`capabilityFallbacks` entry for vision. Shared model sync applies a fallback only when discovery
omits an explicit boolean; an upstream `supportsVision: false` remains authoritative, and the
fallback cannot affect a different or newly discovered model. This provider-neutral contract can
support another incomplete subscription catalog without adding its model names to shared code.

The checked upstream Grok Build compatibility version is declared in the handler configuration and
must be reviewed when the official client changes its OAuth, headers, model schema, or version gate.

Grok generation uses the account-scoped Responses endpoint for the discovered `grok-4.5` model.
Pointer requests upstream SSE even for a non-streaming public request and lets the gateway's
Responses consumer assemble the final JSON. The request preserves public tool and response fields,
sets `store: false` unless the caller supplied a value, and includes
`reasoning.encrypted_content`. That encrypted reasoning is required for lossless conversion to
Messages `redacted_thinking`; Pointer still rejects unsigned plaintext reasoning instead of
inventing an Anthropic signature.

Current Grok Responses may include a reasoning-item status, `output_text.logprobs`, and additional
bounded usage dimensions. These fields are validated rather than copied blindly. A reasoning item
with no summary and no encrypted content is treated as a semantically empty placeholder.

Non-streaming usage is recorded only after the upstream response has passed protocol validation and
translation. If translation fails after an upstream `200`, Pointer records a `502`
`translation_error` while preserving available token and latency facts. Deleting a temporary API
key retains its usage history and sets `usage_logs.api_key_id` to null.

## Verification

Automated acceptance covers:

- marked OAuth-envelope round trips and malformed-envelope fail-closed behavior;
- device start form fields, URL allowlisting, pending/slow-down/success classification, identity
  extraction, refresh parsing, and safe account projection;
- model discovery across all three native protocols;
- additive migration and ciphertext-only pending state;
- Pointer web add/connect/poll/success behavior with no credential input or rendered token;
- normal API-key provider and legacy Codex regression coverage.

Live owner acceptance completed on 2026-07-28. The connected account reported a safe `fresh` state,
the `GrokPro` tier, no blocked flag, and one discovered `grok-4.5` model using the Responses
protocol with tools and streaming. Controlled production checks passed through the public
Responses, Chat Completions, and Messages contracts, including a forced function call and a streamed
Chat response with usage. Each request returned the unique acceptance marker through Pointer's V1
gateway.

The same day's vision follow-up proved two separate boundaries. A controlled request through the
subscription handler and Pointer's typed adapters returned `200` and the expected image marker.
Before the fallback release, the public gateway correctly failed closed because the incomplete
discovery row said vision was unsupported. After the exact-model fallback was deployed and the
provider resynced, `GET /v1/models` advertised vision and a public Responses request using an
external NASA PNG returned `200`, gateway `v1`, the exact visual marker, and input/output usage.
The disposable instance and key were deleted while the successful telemetry row was retained with a
null API-key reference. See
[the Grok vision release record](./deployments/2026-07-28-grok-vision.md).

The live pass did not force-expire or disconnect the owner's credential. Proactive refresh,
single-flight refresh, rotated-token preservation, terminal refresh quarantine, and disconnect are
covered by code and automated tests; an actual expiry remains an observational production check.
There is no reactive retry when a still-valid token is invalidated early by the provider. Reconnect
is the safe recovery until that behavior is implemented and tested.
