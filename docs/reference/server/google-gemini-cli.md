# Google GenerateContent and Gemini CLI compatibility

Pointer exposes the Google Gemini Developer API `v1beta` GenerateContent wire
format so Gemini CLI can use Pointer's model identity, routing, credentials,
capability checks, and telemetry without a modified client. This is a fourth
Gateway V1 format named `google-generate-content`; it is not an alias for a
particular Gemini model family.

The compatibility boundary is the model inference surface used by Gemini CLI.
It does not implement the stateful Google Files, Cached Content, tuning, batch
job, Interactions, or Live APIs. A GenerateContent request may still carry a
provider-owned file or cache reference through a native Google route; Pointer
never dereferences or moves that reference.

## Gemini CLI setup

Use a current Pointer `ptr_` API key as `GEMINI_API_KEY`. Keep the value in a
protected environment or secret manager and do not place it in a settings file,
shell transcript, repository, or support log.

```bash
export GOOGLE_GEMINI_BASE_URL="https://pointer.example.com"
export GOOGLE_GENAI_API_VERSION="v1beta"
export GEMINI_API_KEY="$POINTER_API_KEY"
gemini --model "<exact Pointer display name>"
```

Also select Gemini API key authentication in the user-level
`~/.gemini/settings.json`. Merge this property with any existing settings:

```json
{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  }
}
```

This explicit setting is required for Gemini CLI `0.54.4`. That release detects
`GOOGLE_GEMINI_BASE_URL` and constructs its internal gateway transport, but its
non-interactive auth validator does not accept the corresponding internal
`gateway` enum. Selecting `gemini-api-key` avoids that validator defect; the
SDK still uses `GOOGLE_GEMINI_BASE_URL` and sends `GEMINI_API_KEY` as
`x-goog-api-key`. This is a stock CLI configuration, not a patched binary.

Pointer accepts `x-goog-api-key` only on `/v1beta/*`; URL query keys are not
accepted. Obtain the model name from `GET /v1beta/models` or Pointer's existing
model and group UI. Names are case-insensitive at resolution time and safely
URL-encoded by the SDK, while responses retain the Pointer display identity.

The main `--model` value can be any Pointer model visible to the API key. Add
each Pointer display name used by the CLI as an exact custom alias. The alias
name and target model are intentionally identical:

```json
{
  "modelConfigs": {
    "customAliases": {
      "<exact Pointer display name>": {
        "modelConfig": {
          "model": "<exact Pointer display name>"
        }
      }
    }
  }
}
```

Without an exact alias, Gemini CLI treats an unknown model name as an
interactive chat model and inherits Google's `chat-base` defaults:
`temperature: 1`, `topP: 0.95`, `topK: 64`, and `includeThoughts: true`.
Those are active API requests, not neutral client defaults, and some
non-Gemini providers reject them. An alias with no `extends` clause sends no
sampling or thinking configuration unless the user adds it explicitly. It
does not rename or recursively resolve the model: `modelConfig.model` is the
exact Pointer identity sent to the API.

Add supported generation controls to the alias when desired. For example, a
reasoning-capable route may add `thinkingConfig`, while a provider that accepts
temperature may add `temperature`. Pointer preserves those controls or rejects
them if the selected cross-format route cannot preserve their meaning; it does
not silently drop an active request.

### Prompt-only models

A normal Gemini CLI coding loop additionally needs a route with streaming and
function calling. For a generation model that does not support tools, use a
prompt-only Gemini CLI profile by adding an empty built-in-tool allowlist:

```json
{
  "tools": {
    "core": []
  },
  "modelConfigs": {
    "customAliases": {
      "<exact Pointer display name>": {
        "modelConfig": {
          "model": "<exact Pointer display name>"
        }
      }
    }
  }
}
```

Gemini CLI `0.54.4` still serializes that state as
`tools: [{"functionDeclarations": []}]`. Pointer recognizes this empty Google
wrapper as prompt-only. A non-empty function declaration, Google Search, URL
Context, code execution, or any other built-in tool remains a real capability
request and is rejected before provider I/O when the route lacks tool support.
Because `tools.core` is session-wide rather than model-scoped, keep this as a
separate project or user settings profile when switching between prompt-only
and coding-agent models.

Selecting a model never manufactures features the model or provider lacks:
Pointer returns `pointer_feature_unsupported` in a Google RPC error before
provider inference when required semantics cannot be preserved. On a native
Google route, Pointer passes the validated native request through and lets
Google enforce model-specific features because the Models API discovers
operations, not a complete semantic capability catalog.

### Internal utility aliases

Gemini CLI can make utility requests through built-in aliases independently of
the main `--model`. Override those aliases in `.gemini/settings.json` when the
chosen Pointer instance does not expose Google's default model IDs. Replace
each placeholder with a Pointer display name appropriate to the role. A single
streaming, tool-capable model is a safe initial choice; separate smaller models
can be assigned later.

```json
{
  "modelConfigs": {
    "customAliases": {
      "flash-lite": {
        "modelConfig": { "model": "<Pointer utility model>" }
      },
      "gemini-3-flash-base": {
        "modelConfig": { "model": "<Pointer utility model>" }
      },
      "gemini-3.5-flash-base": {
        "modelConfig": { "model": "<Pointer utility model>" }
      },
      "gemini-2.5-flash-base": {
        "modelConfig": { "model": "<Pointer utility model>" }
      }
    }
  }
}
```

Do not configure Google Search or URL Context utility aliases against a route
that lacks the corresponding native provider tool. Pointer does not execute
those tools on the provider's behalf.

## Public wire surface

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/v1beta/models` | Lists allowed Pointer display models, limits, and route-supported methods. |
| `GET` | `/v1beta/models/{display-name}` | Gets one resolvable Pointer model resource. |
| `POST` | `/v1beta/models/{display-name}:generateContent` | Non-streaming GenerateContent. |
| `POST` | `/v1beta/models/{display-name}:streamGenerateContent?alt=sse` | Google SSE; each data item is a complete response object. |
| `POST` | `/v1beta/models/{display-name}:countTokens` | Exact native count or explicitly labeled estimate. |
| `POST` | `/v1beta/models/{display-name}:embedContent` | Native embedding operation only. |
| `POST` | `/v1beta/models/{display-name}:batchEmbedContents` | Native batch embedding operation only. |

The model path is decoded exactly once and traversal, malformed escapes,
control characters, backslashes, empty values, and oversized identities are
rejected. Pointer resolves the display name internally and sends only the exact
provider model ID upstream. That raw ID is never returned to the caller.

Every response includes `x-pointer-gateway-engine: v1` and
`x-pointer-request-id`. `countTokens` also includes
`x-pointer-token-count-source: exact` when a native Google count operation is
available or `estimated` otherwise. The deterministic estimate supports Gemini
CLI context management but is not represented as the provider's tokenizer.

## Field and capability policy

| Semantic area | Native Google route | Other native provider formats |
|---|---|---|
| Conversation, system instruction, ordered text | Passed through exactly | Typed IR translation |
| Function declarations, calls/results, call IDs, modes | Passed through exactly | Translated when representable |
| Thinking parts and opaque thought signatures | Passed through exactly | Translated only where the target can preserve them |
| Temperature, top-p/top-k, output limit, stops, seed, penalties, log probabilities | Passed through exactly | Mapped to equivalent target controls |
| JSON MIME type and response schema | Passed through exactly | Mapped where structured output exists |
| Inline image, audio, and document data | Passed through exactly | Mapped only to a compatible input part and model capability |
| `fileData` provider references and `cachedContent` | Passed through without dereferencing | Rejected |
| Safety settings/results, prompt feedback, grounding, citations, URL context, code execution metadata | Passed through exactly | Native-only input is rejected; output metadata is never fabricated |
| Google Search, URL Context, code execution, and other built-in tools | Passed to the native provider | Rejected unless a future adapter proves an equivalent |
| Multiple candidates and Google-only response modalities/media controls | Passed through exactly | Rejected because a single-choice target would lose meaning |
| Usage, cached/thought/tool-use counts, finish reason, response ID, model version | Passed through exactly | Common dimensions are translated; unrepresentable metadata remains format-scoped |
| Embeddings | Real native operation and finite-vector validation | Rejected; placeholder vectors are never generated |

Native Google requests and responses retain their validated JSON fields through
a format-scoped extension, including fields introduced by a compatible Google
SDK. On a cross-format route Pointer uses an explicit portable-field allowlist:
an unknown or Google-only field fails with `pointer_feature_unsupported`
instead of disappearing. The schemas also bound candidate, content, tool,
string, and media collections before provider I/O.

For native Google routes, Pointer uses discovered generation methods for
operation dispatch but does not reject native tools, vision, or thinking from
Pointer's coarser static capability flags. Those fields are preserved for the
Google API, which remains authoritative for model-specific validation. The
static capability preflight continues to protect cross-format translations.

Google model discovery records `supportedGenerationMethods`. Model list/get,
generation, token counting, and embedding dispatch use that provider metadata
when it is present. Streaming is advertised for generation-capable Google
models because the streaming action is a transport form of `generateContent`.

## Native Google provider

The built-in Google Gemini provider uses
`https://generativelanguage.googleapis.com`, `x-goog-api-key`, and dynamic
model action paths. Discovery removes the provider resource prefix from model
IDs, preserves limits and supported methods, and declares
`google-generate-content` per model. It no longer routes native Google traffic
through Google's OpenAI-compatibility endpoint.

## Errors and troubleshooting

Errors use Google's `google.rpc.Status`-style JSON envelope. Pointer details
contain a bounded stable reason but never an upstream body, credential,
provider route ID, database detail, or stack trace.

- `UNAUTHENTICATED` / `invalid_api_key`: check that a current Pointer key is in
  `GEMINI_API_KEY` and that the base URL is present. Do not put the key in the
  URL.
- `NOT_FOUND` / `model_not_found`: use a model name returned by that key's
  `/v1beta/models` response or correct the utility aliases.
- `INVALID_ARGUMENT` / `pointer_feature_unsupported`: choose a route with the
  requested tools, media, reasoning, streaming, count, or embedding capability.
- `INVALID_ARGUMENT` / `pointer_upstream_unavailable`: the selected provider or
  model rejected the translated request. Confirm the exact custom alias above
  is present so Gemini CLI does not inject its Gemini-specific chat sampling
  defaults, then check any controls explicitly added to that alias. Pointer
  does not silently remove an active sampling request merely to make an
  incompatible route succeed.
- `UNAVAILABLE` / `pointer_upstream_unavailable`: the provider connection
  failed before an HTTP response was available. Pointer records this as an
  upstream outage, not a translation defect; the CLI may retry it safely.
- `x-pointer-token-count-source: estimated`: context management is available,
  but the selected non-Google route has no exact Google tokenizer operation.

## Compatibility baseline

The implementation was built against Gemini CLI stable `0.54.4`, preview
`0.55.0-preview.2`, nightly
`0.56.0-nightly.20260808.gcf22ac7e8`, and the stable CLI's `@google/genai`
`1.30.0` wire behavior as observed on 2026-08-08. The repository pins that SDK
version in a black-box contract test. Re-check CLI release tags, the SDK pin,
base-URL behavior, action paths, authentication header, and SSE grammar during
each compatibility upgrade.
