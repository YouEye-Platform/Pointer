# Provider model discovery

Provider model discovery is Pointer server's metadata-only process for learning
the exact upstream model IDs that a connected provider account can route.
Pointer server owns this process; Pointer web only starts a manual refresh and
renders the resulting catalog.

Model discovery is not inference. It never sends a prompt and never calls chat,
Messages, Responses, embeddings, image, audio, video, rerank, moderation, or
other model-execution endpoints. Generic discovery always issues `GET` to the
manifest's model-list contract. The two subscription handlers also fetch their
authenticated account model lists without generating content.

## Refresh lifecycle

Discovery runs:

- five seconds after Pointer server starts;
- hourly while Pointer server is running;
- after an API-key provider is added;
- after an OAuth provider connection completes; and
- when an authenticated user selects Refresh Models, which calls
  `POST /api/providers/:id/sync`.

The manual and scheduled paths use the same implementation. Generic provider
connection testing also uses the same discovery executor, so Test Connection
cannot pass against one endpoint while Refresh Models reads another.

For a generic provider, one refresh:

1. resolves the discovery URL;
2. adds only the manifest's safe headers and the connected user's provider
   authentication;
3. issues GET requests and follows every declared cursor;
4. validates each response page before continuing;
5. accumulates the complete result in memory;
6. applies provider-declared metadata filters;
7. removes duplicate provider-native model IDs;
8. upserts eligible model metadata and exact provider routes;
9. stages one complete provider-inventory snapshot; and
10. schedules canonical catalog reconciliation.

If a provider-specific handler implements `fetchModels`, that handler remains
authoritative for its private account contract. OpenAI Codex and Grok
subscription use this path.

## Manifest contract

Simple providers remain YAML-only. `models.discovery` supports:

| Field | Meaning |
| --- | --- |
| `enabled` | Enables inventory discovery. |
| `url` | Optional absolute metadata URL when the model catalogue is not below the inference base URL. |
| `query` | Static string, number, or boolean query parameters. |
| `listPath` | Dot-separated response path containing the model array; a root array remains supported. |
| `idField` | Provider-native model ID field used for routing and deduplication. |
| `nameField` | Human-readable model name field. |
| `contextField` | Dot-separated context-limit field. |
| `pricingPath` | Dot-separated pricing object, with configured input/output fields and units. |
| `filters` | AND-combined metadata predicates. |
| `pagination` | Cursor, continuation response path, optional has-more boolean, page size, and safety limit. |
| `catalogIdentity` | Optional provider-declared authoritative cross-provider identity; it never replaces the provider routing ID. |

`catalogIdentity` contains:

- `field`: dot-separated provider metadata field;
- `stripPrefix`: optional exact prefix that must match before removal; and
- `minimumSegments`: minimum non-empty slash-separated segments after prefix
  removal.

Missing, non-string, wrong-prefix, and incomplete values return no catalogue
identity and leave the conservative identity resolver unchanged. Pointer does
not derive this identity from the display name or send a model request to
discover it.

Each filter has a nested `path` and one or more of:

- `equals`;
- `notEquals`;
- `in`;
- `notIn`; or
- `exists`.

Filter values are primitive provider-contract values. Filters must not contain
model IDs or naming-pattern guesses.

Pagination supports both common provider shapes:

- a continuation token whose presence means another page; and
- a separate boolean such as `has_more`, paired with a cursor such as
  `last_id`.

The executor rejects:

- an invalid endpoint;
- invalid page-size or cursor configuration;
- a non-success HTTP status;
- invalid JSON;
- a non-array model-list field;
- a non-string continuation cursor;
- `has_more: true` without a cursor;
- a repeated cursor; and
- a catalogue exceeding the configured maximum pages.

Errors contain the provider ID and safe status only. Credentials, headers, and
raw upstream response bodies are not included.

## Fireworks example

Fireworks separates inference from model catalogue management. Inference
remains on `https://api.fireworks.ai/inference/v1`; discovery uses the official
serverless catalogue:

```yaml
models:
  discovery:
    enabled: true
    url: https://api.fireworks.ai/v1/accounts/fireworks/models
    query:
      filter: supports_serverless=true
    listPath: models
    idField: name
    nameField: displayName
    contextField: contextLength
    catalogIdentity:
      field: huggingFaceUrl
      stripPrefix: https://huggingface.co/
      minimumSegments: 2
    filters:
      - path: state
        equals: READY
      - path: status.code
        equals: OK
      - path: kind
        notEquals: EMBEDDING_MODEL
    pagination:
      cursorParam: pageToken
      cursorPath: nextPageToken
      pageSizeParam: pageSize
      pageSize: 200
```

This configuration dynamically includes newly released ready serverless
generation models such as Kimi K3. Kimi K3 is not present in source,
configuration, or tests as a fixed model entry.

Fireworks model `name` values are infrastructure resource paths and remain the
exact inference routes. When a record includes a complete `huggingFaceUrl`,
Pointer uses the exact repository owner/name as additional canonical identity
evidence. For example, a Fireworks resource can therefore group with an
equivalent route from another provider without changing what Pointer sends to
Fireworks. The declared identity becomes the primary structured claim only
when another current source independently corroborates the same normalized
identity. Without corroboration it remains an alias and the raw provider
identity remains primary, preventing new metadata from suppressing a valid
route. Publisher-only URLs such as `https://huggingface.co/Qwen/` are
incomplete under the two-segment rule and are not guessed.

Official references:

- <https://docs.fireworks.ai/api-reference/list-models>
- <https://docs.fireworks.ai/faq-new/models-inference/how-to-check-if-a-model-is-available-on-serverless>

## Built-in provider contracts

| Provider | Discovery contract | Eligibility behavior |
| --- | --- | --- |
| Anthropic | `GET /v1/models`, `limit=1000`, then `after_id=last_id` while `has_more` | Endpoint is already language-model-specific. |
| Cerebras | `GET /v1/models` | Provider documents it as the current inference model list. |
| DeepInfra | `GET /v1/openai/models` | Account's OpenAI-compatible inventory; the separate all-modality catalogue is not a routing inventory. |
| Fireworks | `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` | Ready, healthy, non-embedding model cards. |
| Google Gemini | `GET /v1beta/models` | Native model resources. The handler removes the `models/` prefix, records input/output limits and `supportedGenerationMethods`, and declares the native Google format. |
| Groq | `GET /openai/v1/models` | Complete active inventory; see metadata limitation below. |
| Kimi global | `GET https://api.moonshot.ai/v1/models` | Current global account inventory. |
| Mistral | `GET /v1/models` | `capabilities.completion_chat == true` and `archived != true`. |
| OpenAI Codex | Account-scoped Codex backend, with official public Codex catalogue fallback | Handler-owned inventory and per-model operation metadata. |
| OpenAI | `GET /v1/models` | Complete account inventory; see metadata limitation below. |
| OpenRouter | `GET /api/v1/models/user` | Account provider preferences, privacy settings, and guardrails are applied upstream. |
| SambaNova | `GET /v1/models` | Environment's available model inventory. |
| Together | `GET /v1/models` | `type == chat`. |
| Grok subscription | Account-scoped authenticated session `GET /models` | Handler-owned subscription inventory. |
| xAI API | `GET /v1/language-models` | Chat and image-understanding language models only. |
| Z.ai | `GET /api/paas/v4/models` | Current account language-model inventory. |

The Kimi built-in provider is explicitly the current global platform. A future
China-region provider must be a separately named manifest with its own endpoint
and key expectations; the two regions must not be silently conflated.

## Upstream metadata limitations

Pointer filters only on authoritative provider metadata. It does not infer
capability from a model name.

OpenAI's account models response intentionally spans multiple API families but
does not declare a per-model operation or modality field. Groq's active model
list similarly includes text and audio offerings without an authoritative type
field on each list record. Pointer therefore retains their dynamic inventories
rather than adding fragile exclusions such as `whisper-*` or
`*-embedding-*`.

This means those providers can still expose routes whose ultimate operation
compatibility is known only when the provider is called. This is a documented
upstream-contract limitation, not permission to send automatic test prompts.
If either provider adds authoritative operation metadata or a
language-model-specific endpoint, its manifest should adopt that contract and
add deterministic fixtures.

## Completeness, failure, and last-known-good behavior

All pages are fetched before persistence starts. A failure on page two does not
stage page one as a complete inventory. A zero eligible result is unhealthy and
does not stage an empty snapshot.

Provider source health and inventory history are separate:

- a successful complete refresh creates or reuses a provider inventory
  observation and can activate/deactivate canonical provider routes through
  reconciliation;
- a failed refresh marks the provider source operationally unhealthy;
- the last complete inventory remains available to reconciliation; and
- historical `provider_models` rows may remain in PostgreSQL after a model is
  removed upstream. Their existence is not proof that the route is active in
  the current canonical generation.

Catalog activation makes current state explicit: it first clears
`catalog_entity_id` on provider rows, then assigns it only to routes in the
new active generation. Provider list counts, provider detail/list responses,
model-test targets, and runtime resolution require that current link. They no
longer present retained historical rows as current, while reconciliation and
audit history remain intact.

## Canonical grouping and route identity

Pointer keeps two identities separate:

- the provider routing ID is the exact value sent upstream; and
- canonical catalogue identity is evidence used to group equivalent routes.

`catalogIdentity` contributes only the second. Reconciliation stores the raw
provider ID as the observation native ID and active route, and also stores the
declared catalogue identity as an alias. It uses that identity as the primary
structured claim only when a different current source supplies the same
identity. If stronger evidence merges a previous provider-only entity into an
existing canonical entity, generation activation publishes compatibility
redirects for the retired entity ID and stable slug. If no source corroborates
the declared identity, the provider's raw identity remains primary and the
route stays independently navigable.

This is intentionally conservative. Models are not merged merely because
their display names match. Quantization, parameter size, release, modality, or
other hard identity conflicts still prevent grouping. A provider whose
metadata does not contain a complete authoritative identity keeps the existing
resolver behavior.

## Capability mapping

Discovery uses provider booleans when supplied:

- tool use: `supports_tool_use`, `supportsTools`, `supports_tools`, or declared
  `tools`;
- image input: `supports_vision`, `supportsVision`, `supportsImageInput`,
  `supports_image_input`, or declared `vision`; and
- streaming: `supportsStreaming` or `supports_streaming`.

Exact-model manifest fallbacks remain available only when a provider omits a
documented capability. An explicit provider `false` always wins. New provider
catalogues should prefer dynamic booleans over model-specific fallbacks.

## Operations and troubleshooting

Manual refresh:

```bash
curl -X POST \
  -H "Authorization: Bearer <management-jwt>" \
  https://<pointer>/api/providers/<provider-id>/sync
```

Expected success:

```json
{"synced":13}
```

The exact count is provider- and account-dependent and must not be asserted as
a permanent product constant.

Connection test:

```bash
curl -X POST \
  -H "Authorization: Bearer <management-jwt>" \
  https://<pointer>/api/providers/<provider-id>/test
```

Connection testing is also metadata-only. It succeeds only when the applicable
discovery contract returns at least one eligible model.

When refresh fails:

1. confirm the provider's documented model-list URL and response shape;
2. confirm the account key belongs to the intended platform/region;
3. inspect sanitized Pointer logs for provider ID, HTTP status, cursor, or
   response-shape failure;
4. do not print the credential or raw provider response;
5. compare the manifest with the provider's primary documentation;
6. add or update deterministic response fixtures;
7. run the discovery and full API suites; and
8. repeat a metadata-only connection test.

Do not troubleshoot discovery by sending an automatic inference request.
User-authorized model acceptance is a separate operation through
`POST /api/test-model` or the public gateway and can incur provider usage.
