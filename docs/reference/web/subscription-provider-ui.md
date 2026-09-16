# Subscription provider UI

The Providers surface renders Pointer server's generic provider authentication capabilities. It does
not implement OAuth, hold provider credentials, call a provider origin, or decide which protocol a
model uses.

## Add and connect

`GET /api/providers/manifests` declares the authentication type. API-key manifests show the existing
password input and key label. OAuth manifests do not render an API-key field and send only
`{ manifestId }` when activated.

An active provider's detail response supplies:

- the safe authentication type;
- a provider-controlled connection label;
- whether Pointer server has a generic device-flow handler;
- encrypted credential presence and type;
- safe account state and model inventory.

For a generic device flow, Pointer web:

1. calls Pointer server's start endpoint;
2. displays the one-time user code and provider-validated HTTPS verification URL;
3. opens that URL only after an explicit user click;
4. polls Pointer server after the returned interval;
5. uses each pending response's next interval;
6. shows connected, denied, expired, or sanitized failure state;
7. cancels pending state through Pointer server when the modal closes.

The browser receives the flow identifier and human-entered user code, but never the provider
`device_code`, access token, refresh token, encrypted envelope, provider password, or raw provider
account response. Closing a completed modal cannot delete the stored credential because Pointer server has
already removed the pending flow.

The initial Grok adapter is shown as **Grok Subscription** and remains distinct from the normal
**xAI** API-key provider. The legacy Codex UI continues to use its existing endpoints until Pointer server's
Codex adapter is migrated to the generic engine.

## Connected state

OAuth providers replace the manual key form with a short explanation of encrypted Pointer server-owned
storage. Users can reconnect, rename the safe local label, refresh account state, refresh model
inventory, test the connection, or disconnect.

Model rows display Pointer server's per-model native format (`chat-completions`, `messages`,
`responses`, or `google-generate-content`)
for routing diagnostics. Pointer web does not derive the format from a model name or provider.

## Accessibility and failure behavior

- The user code is selectable text and the waiting message is a status region.
- The secure sign-in link opens a new tab with `noopener`/`noreferrer` behavior.
- Test, sync, account, and balance actions are disabled until a credential exists.
- Polling stops on terminal state, modal close, route unmount, or a non-retryable Pointer server error.
- Provider authentication errors stay inside the provider modal/page and never clear the Pointer
  management JWT.

Mocked Playwright acceptance proves that an OAuth provider can be added and connected without an
API-key input or token-shaped browser output.

Live owner acceptance completed on 2026-07-28. The deployed Grok detail page shows:

- an encrypted connected-account credential label;
- safe `fresh · GrokPro` account state;
- one `grok-4.5` model with Responses, tools, streaming, and 500K context badges;
- reconnect, disconnect, account refresh, model refresh, and connection-test controls.

The authenticated production page produced no console errors, page errors, failed requests, or HTTP
failures. The browser did not receive or render the OAuth access/refresh envelope.
