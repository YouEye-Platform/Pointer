# Google AI / Gemini CLI compatibility plan

Status: implemented and validated; final release evidence is recorded in
`docs/deployments/README.md`

Date: 2026-08-08 (Australia/Melbourne)

Target repository: `Pointer`

Target components: `apps/server`, `packages/contracts`, provider manifests,
PostgreSQL migrations, tests, and current-product documentation

Primary consumer: Google Gemini CLI using the Gemini Developer API transport

Authorization: the follow-up request explicitly authorized implementation on `main`, full testing,
production deployment, live Gemini CLI acceptance, documentation, and push. The design and test
sequence below remain the implementation record rather than a request for additional approval.

## Outcome

Add a fourth typed gateway format, `google-generate-content`, so an unmodified
Gemini CLI can use Pointer as its Google AI base URL while Pointer retains
model, provider, credential, routing, scheduling, audit, and persistence
authority.

The compatibility contract is complete for the Gemini GenerateContent model
inference surface: every accepted field is either translated without changing
its meaning, passed through to a native Google-format provider, or rejected
before provider I/O with a bounded Google-format error. No field, capability,
thought signature, safety result, citation, tool result, or media reference may
be silently discarded or fabricated.

Every Pointer model advertised on this surface is addressable by its Pointer
display identity. Feature availability remains truthful to the selected model
and route:

- text generation works only on generation-capable routes;
- the normal Gemini CLI coding-agent loop requires streaming and function
  calling;
- images, audio, video, documents, structured output, thinking, server-side
  tools, token counting, and embeddings work only when they can be preserved or
  implemented safely by the selected route;
- a missing required capability produces a stable, Google-format
  `pointer_feature_unsupported` error rather than a degraded request.

This is protocol compatibility, not a claim that every underlying model has
every Gemini capability.

## Research snapshot and drift boundary

Research was performed on 2026-08-08 against official Google sources and the
official Gemini CLI repository.

### Verified Gemini CLI state

- npm stable: Gemini CLI `0.54.4`.
- npm preview: `0.55.0-preview.2`.
- npm nightly observed during research:
  `0.56.0-nightly.20260808.gcf22ac7e8`.
- official repository head inspected at commit
  `cf22ac7e86f3dcf528e3ae591fec1c03090a49f8` dated 2026-08-07.
- stable `@google/gemini-cli-core@0.54.4` pins `@google/genai@1.30.0`.

Stable CLI detects gateway mode when `GOOGLE_GEMINI_BASE_URL` is set. It
constructs `GoogleGenAI` and calls the SDK `models` client. Stable `0.54.4` also
has a CLI-side auth validation defect: the non-interactive validator rejects
the internal `gateway` auth enum produced by that detection. A user-level
`security.auth.selectedType` of `gemini-api-key` is therefore required while
the base URL remains set. This keeps the stock binary and intended SDK
transport, and was verified against the isolated Pointer canary. The required
`ContentGenerator` methods are:

- `generateContent`;
- `generateContentStream`;
- `countTokens`;
- `embedContent`.

The main agent loop uses streaming generation. Non-streaming generation is
also used by utility paths, and token counting is used for context management.
The embedding method is part of the stable interface even though no active
non-test call site was found in the inspected stable core.

Stable CLI applies its Gemini-specific `chat-base` generation configuration to
an unknown model name. Exact-name `customAliases` with no parent are therefore
the supported Pointer profile: they retain the same model identity while
omitting implicit temperature, top-p, top-k, and thinking controls that a
non-Gemini route may reject. For a model without function calling,
`tools.core: []` supplies a prompt-only profile. The CLI still serializes one
empty `functionDeclarations` wrapper in that state, so Pointer treats only that
empty wrapper as a semantic no-op while continuing to gate every non-empty or
built-in tool request.

### Verified wire contract

With Gemini Developer API authentication, `@google/genai@1.30.0` defaults to
`v1beta`, sends the key in `x-goog-api-key`, and joins the configured base URL
to these paths:

| Operation | Required wire endpoint |
| --- | --- |
| Generate | `POST /v1beta/models/{model}:generateContent` |
| Stream | `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` |
| Count tokens | `POST /v1beta/models/{model}:countTokens` |
| Embed | `POST /v1beta/models/{model}:embedContent` and batch form `POST /v1beta/models/{model}:batchEmbedContents` |
| List models | `GET /v1beta/models` |
| Get model | `GET /v1beta/models/{model}` |

`GOOGLE_GENAI_API_VERSION` can override the SDK version. `v1beta` is the
canonical Pointer compatibility version because it is the SDK default and
contains the feature surface used by the CLI. Add versioned `v1` action routes
only after comparing their official schemas field by field. Do not alias beta
fields into `v1` without that review.

Google now documents the Interactions API as a recommended API for some new
agentic integrations. The inspected Gemini CLI stable transport does not use
Interactions; it still uses the GenerateContent family. An Interactions
adapter, Live API, and the broader Google control plane are separate work and
must not delay or distort the CLI-compatible contract.

### Implementation-time refresh

Completed on 2026-08-08 before the release gates:

1. npm tags remained stable `0.54.4`, preview `0.55.0-preview.2`, and nightly
   `0.56.0-nightly.20260808.gcf22ac7e8`;
2. stable continued to use `@google/genai@1.30.0`,
   `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `x-goog-api-key`, and the models
   client; live source and canary inspection also found the stable auth
   validator omission described above, with `gemini-api-key` selected explicitly
   as the stock-CLI workaround;
3. official `v1beta` and `v1` discovery documents both reported revision
   `20260806`; their SHA-256 values were respectively
   `c1614911591d18b440d32dba7c8622a6072bb1b8731b3b704fc6b02aff31f433` and
   `de466cab133bc9a6d912d4a00c2728bbc28866a735b698a6c7cc7142ca0b608a`;
4. the reviewed CLI wire contract remained the `v1beta` GenerateContent model
   actions in this plan; Google's newer recommended Interactions API remains a
   separate surface not used by the inspected Gemini CLI transport;
5. the server pins `@google/genai@1.30.0` in a black-box transport test so
   endpoint, auth, model encoding, SSE, count, embeddings, and model discovery
   drift becomes executable evidence.

## Scope definition

### In scope

- The complete request, response, error, and SSE semantics of the Google
  GenerateContent inference format used by Gemini CLI.
- `generateContent`, `streamGenerateContent`, `countTokens`, `embedContent`,
  `batchEmbedContents`, model list, and model get.
- Gemini CLI system instructions, conversation history, function tools,
  function calling configuration, tool call/result correlation, thinking,
  thought signatures, structured JSON output, sampling, stop sequences,
  multimodal parts, safety settings/results, candidates, usage, finish reasons,
  grounding/citation metadata, URL context, and code execution metadata.
- Pointer-to-Google and Google-to-each-existing-provider translation.
- Native Google provider routing without forcing Google requests through its
  OpenAI-compatibility endpoint.
- Exact or explicitly identified estimated token counting.
- Embedding routing where a real embedding-capable operation exists.
- Documentation and pinned Gemini CLI compatibility tests.

### Explicitly separate from this format project

- Interactions API sessions and state.
- Live API WebSocket audio/video sessions.
- Google Files upload/storage lifecycle, resumable upload, and deletion.
- Cached Content creation/deletion, batch job control, corpora, tuning,
  permissions, and long-running operations.
- Google-hosted image, speech, music, or video generation product APIs that are
  not GenerateContent response modalities.
- Reproducing Google Search, URL Context, safety classification, citation
  generation, or code execution inside Pointer when the selected upstream does
  not provide an equivalent.

These are different stateful services or execution authorities, not fields in
the translation format. Namespace reservations and format-correct unsupported
errors are required so they can be added later without ambiguous behavior.

## Current Pointer evidence

At planning time, local `Pointer/main` and `origin/main` both resolve to
`940bb1bbe73474023ef38efbc7afc2a3f047a103`, and the worktree was clean before
this plan was created. Production identity and live service state were not
inspected.

Observed source constraints:

- The typed gateway intermediate representation currently supports OpenAI Chat
  Completions, Anthropic Messages, and OpenAI Responses in a three-by-three
  translation matrix.
- Public routes currently include `/v1/chat/completions`, `/v1/messages`,
  `/v1/responses`, `/v1/messages/count_tokens`, and OpenAI-shaped `/v1/models`.
- Public API authentication currently recognizes bearer authorization and
  `x-api-key`, but not Google SDK `x-goog-api-key`.
- `GatewayApiFormat`, provider operations, platform capability contracts, and
  the `provider_models.native_format` database constraint recognize only the
  three current formats.
- The Google Gemini manifest currently targets Google's OpenAI-compatible
  `/v1beta/openai` endpoint and declares `chat-completions`; that path cannot
  preserve the full native Google format.
- The gateway IR already models ordered instructions/turns, text, several media
  parts, reasoning, refusal, function calls/results, extensions, common
  sampling, stops, and usage, but it does not yet represent all Google
  candidates, schemas, safety, built-in tools, grounding, detailed usage, or
  response modalities losslessly.
- Model resolution already keeps the externally advertised display identity
  separate from the exact raw provider model ID sent upstream. That invariant
  must be preserved.
- Preflight capability derivation is currently oriented around the existing
  public formats and only a small capability set.

## Proposed architecture

### 1. Add a typed fourth format

Add `google-generate-content` to the public and provider format unions. Extend
the typed gateway matrix from 3 x 3 to 4 x 4. Every one of the 16 public-format
to provider-format paths must have request, non-streaming response, streaming
response, and error tests.

Use `google-generate-content`, not a generic `gemini` label: Gemini is a model
family and product name, while the adapter represents a concrete API grammar.

Add a dedicated protocol module under the existing gateway protocol boundary,
with strict, versioned Google schemas and normalizers. Keep route parsing,
Google SSE rendering, and provider stream parsing isolated enough that the
already-large shared proxy and stream modules do not accumulate another set of
format-specific conditionals.

### 2. Extend the IR before adding route-specific shortcuts

The IR must gain first-class representations for:

- multiple candidates and stable candidate indices;
- generic inline media and typed external references for image, audio, video,
  PDF, and other document media;
- structured response MIME type and JSON Schema;
- candidate count, presence/frequency penalties, seed, log probabilities,
  output modalities, media resolution, speech/image output configuration, and
  any other generation fields present in the pinned discovery schema;
- thinking inclusion, thinking budget/level, thought parts, and positional
  opaque thought signatures;
- function parameter and response schemas, behavior, call IDs, calling mode,
  and allowed function names;
- typed built-in tool requests such as Google Search, URL Context, and code
  execution, without giving the translation layer execution authority;
- request safety settings, prompt feedback, candidate safety ratings, block
  reasons, and probability/severity values;
- citation, grounding, retrieval, URL-context, code-execution, and other
  provider-produced metadata;
- cached, prompt, candidate, thought, tool-use, and modality-level token usage;
- response ID and model-version metadata;
- a bounded, allowlisted native-extension namespace for semantics that have no
  common representation.

Unknown fields remain schema errors. Native extensions must round-trip only
through their declared format and must never become a bypass for unvalidated
arbitrary objects.

### 3. Translation policy

Apply these rules in order:

1. Normalize the Google request into the IR and validate bounds.
2. Resolve the Pointer display model to a route, keeping the raw provider model
   ID private.
3. Evaluate required capabilities before credential lookup or provider I/O.
4. Translate common semantics exactly to the provider's native format.
5. Pass Google-native semantics through only on a native Google-format route.
6. If a required semantic cannot be preserved, return
   `pointer_feature_unsupported`.
7. Permit an optional lossy translation only under Pointer's existing explicit
   best-effort policy, with stable compatibility findings in headers and
   telemetry.

Never:

- flatten multiple candidates into one without an explicit compatibility
  finding;
- convert safety blocking into an ordinary empty answer;
- invent or alter thought signatures;
- manufacture grounding, citations, search results, code execution, or safety
  ratings;
- fetch arbitrary `fileData` URLs inside Pointer;
- substitute a different public model identity in a response.

The current Gemini CLI inserts a documented synthetic signature when replaying
an unsigned call from a non-Gemini model. Pointer must preserve whatever the
client sends but must not synthesize that value itself. Native Google thought
signatures are opaque, order-sensitive data.

### 4. Public routes and model paths

Implement the canonical `v1beta` endpoints listed in the research table.

Model path handling must:

- isolate the bytes between `/models/` and the final `:action` suffix;
- accept the SDK's URL-encoded Pointer display identity;
- decode exactly once;
- reject invalid UTF-8, invalid percent escapes, empty IDs, ambiguous encoded
  separators, traversal forms, control characters, and overlong IDs;
- resolve through the existing Pointer model resolver;
- send the exact configured raw model ID to the upstream provider.

The existing OpenAI `GET /v1/models` must retain its response and bearer-key
behavior. If `v1` Google model listing is added, dispatch that exact collision
only by an unambiguous Google `x-goog-api-key` request; reject requests that
provide conflicting auth schemes. All `v1` action schemas need independent
contract tests. `v1beta` remains the documented Gemini CLI setup.

Google model list/get responses expose Pointer display IDs and truthfully
project supported methods and limits. They must not expose raw provider IDs,
credentials, internal route names, or hidden models.

### 5. Authentication, CORS, and errors

On Google-format routes only, accept `x-goog-api-key` as a Pointer API key and
apply the same hash lookup, instance binding, allowlist, rate limiting, audit,
and redaction behavior as existing API-key forms. Do not accept `?key=` because
URLs are commonly logged. Add `x-goog-api-key` to CORS allow-headers only if
browser SDK use is intentionally supported.

Render failures as Google's JSON/RPC-style error object with a suitable HTTP
status, stable Pointer code, bounded safe message, and Pointer request ID.
Normalize upstream errors before rendering. Never copy raw upstream bodies,
headers, provider IDs, credential material, SQL details, or stack traces into
the client response.

Continue returning the safe Pointer engine and request identity headers used by
the existing gateway.

### 6. Streaming

Render Google SSE as a sequence of complete
`GenerateContentResponse` JSON objects. Preserve candidate indices, part order,
thought flags/signatures, finish reasons, metadata, and final usage. Handle
fragmented UTF-8, fragmented provider frames, comments/heartbeats, CRLF/LF,
EOF, cancellation, timeout, client disconnect, upstream error-before-first-
byte, and error-after-first-byte according to the existing streaming lifecycle
invariants.

When an upstream protocol streams partial function-call JSON arguments, buffer
and validate them before emitting a Google `functionCall`, because the Google
wire shape consumed by the CLI carries a structured arguments object. Enforce
per-call and aggregate buffer limits. Do not emit malformed partial JSON as a
complete function call.

### 7. Native Google provider operation

Change the current Google Gemini provider from its OpenAI-compatible transport
to a native Google operation:

- base URL: the Google Generative Language API origin;
- authentication: `x-goog-api-key`;
- native format: `google-generate-content`;
- dynamic, versioned model/action paths;
- discovery from Google model listing with the `models/` prefix normalized at
  the provider boundary.

Generalize provider operations beyond the single current `generate` operation
to typed operations for generation, token counting, single embedding, and
batch embedding. Keep the route model separate from the request body because
Google places the model in the URL.

Add a reviewed PostgreSQL migration that expands the
`provider_models.native_format` constraint. Do not use `db:push`. Preserve
existing rows and prove forward and rollback behavior in PostgreSQL tests.

### 8. Capabilities and preflight

Replace the current coarse request-body inference with format-aware normalized
requirements. Extend provider/model capabilities, using `supported`,
`unsupported`, or `unknown` where discovery is not authoritative, for at least:

- text and output modalities;
- input image, audio, video, and documents;
- streaming;
- function calling and parallel function calling;
- structured JSON/schema output;
- thinking and thought signatures;
- Google Search, URL Context, code execution, and other server-side tools;
- safety controls and safety metadata;
- exact token count;
- single and batch embeddings;
- candidate count and log probabilities.

Provider-declared or proven route metadata is authoritative. Unknown is not
treated as supported for a semantic whose loss changes security or correctness.
Update static contracts, generated shared types, platform capability output,
provider manifests, and documentation in one monorepo change.

### 9. Token counting and embeddings

For token counting:

- use a provider-native count operation when available and label it `exact`;
- for other generation routes, provide a deterministic conservative estimate
  sufficient for Gemini CLI context compression, label it `estimated` in a
  safe Pointer response header and telemetry, and document its error bound;
- provide a strict policy that rejects estimated counts when exactness is
  required.

Exact cross-provider token counts are impossible without that provider's
tokenizer or counting endpoint. The implementation must not represent an
estimate as exact.

For embeddings, route only to a configured embedding-capable model/operation.
Validate dimensions, numeric finiteness, item counts, ordering, and usage.
Never generate placeholder vectors. If a Gemini CLI release begins to call
embeddings during normal operation, its exact request shape becomes a release
gate.

### 10. Media, files, cached content, and built-in tools

Support bounded `inlineData` as request media and response media where the
selected route supports it. Validate MIME type, decoded byte size, total
request size, and allowed modalities before provider I/O.

Treat `fileData.fileUri` as an opaque provider-scoped reference. It may pass
through to a compatible native provider only. Pointer must not dereference it,
move it between providers, or claim that a Google-hosted URI is usable by a
different provider. Google Files lifecycle support requires a separate storage
and security design.

Treat `cachedContent` the same way: native-only unless Pointer later acquires a
real cache authority and lifecycle API.

Google Search, URL Context, and code execution are typed tool capabilities.
Pass them through on a proven native route or map them only to a semantically
equivalent provider feature with tests. Pointer's translation layer does not
execute them. Function declarations remain client-executed Gemini CLI tools in
the normal agent loop.

### 11. Gemini CLI model selection

The main CLI request passes an arbitrary `--model` value through to the SDK, so
the documented primary invocation uses the exact Pointer display name.

Gemini CLI also has internal utility aliases such as `flash-lite` and dedicated
chat-compression, summarizer, classifier, web-search, and web-fetch configs.
Ship a documented `modelConfigs.customAliases` profile that maps those utility
roles to explicitly selected Pointer models. Do not make the server silently
reinterpret every Google model ID as the current main model: independent calls
do not reliably carry that context, and silent substitution breaks identity and
capability reporting.

The setup guide will use environment variables without displaying a key:

```bash
export GOOGLE_GEMINI_BASE_URL="https://pointer.example.com"
export GOOGLE_GENAI_API_VERSION="v1beta"
export GEMINI_API_KEY="$POINTER_API_KEY"
gemini --model "<Pointer display name>"
```

The guide must explain how to obtain the Pointer display name, configure
the required user-level `security.auth.selectedType`, utility aliases, the
thinking-disabled override for non-reasoning routes, choose models with
tools/streaming, and diagnose a capability error. It must not contain or ask
users to paste secret values into logs.

## Implementation sequence

Each phase is independently reviewable. Deployment follows the separately
granted follow-up authorization and the repository's immutable release,
backup, migration, canary, and rollback gates.

### Phase 0: freeze evidence and contracts

1. Refresh official versions and capture discovery fixtures.
2. Add a Gemini CLI request corpus from stable CLI/SDK behavior with all
   secrets and user data removed.
3. Write the feature inventory and required/mappable/native-only/unsupported
   classification for every schema field.
4. Record baseline unit, PostgreSQL, and end-to-end results before changes.

Exit: reviewers can trace every required CLI operation and field to an official
schema/source and a planned Pointer behavior.

### Phase 1: contracts, IR, and capability model

1. Add the format and operation identifiers to server and static contracts.
2. Extend the IR, compatibility findings, and capability schemas.
3. Regenerate shared types and update the platform capability contract.
4. Add the database migration and migration tests.

Exit: typechecking enforces the new semantics, and no runtime route is exposed
yet.

### Phase 2: Google parsing and rendering

1. Implement bounded `v1beta` request schemas and Google error rendering.
2. Normalize all parts, configs, tools, safety, candidates, usage, and metadata.
3. Implement non-streaming Google response rendering.
4. Implement Google SSE rendering and the partial-tool-call buffer.

Exit: pure adapter tests pass for Google-to-Google round trips and hostile
inputs; unknown or unsupported semantics cannot disappear silently.

### Phase 3: public gateway and model identity

1. Add action routes, model list/get, route-local Google auth, and safe path
   parsing.
2. Resolve display IDs through existing model authority.
3. Perform normalized, capability-aware preflight before credentials/provider
   I/O.
4. Add exact/estimated token-count behavior and embedding dispatch.

Exit: official SDK conformance tests work against a local Pointer server and
raw provider IDs remain private.

### Phase 4: all provider translations

1. Implement Google-to-Chat Completions, Google-to-Messages,
   Google-to-Responses, and native Google translation.
2. Implement each existing public format to native Google provider rendering.
3. Add response, stream, finish, usage, tool, thought, and error translations
   for all 16 format pairs.
4. Complete the feature matrix and best-effort findings.

Exit: the full typed matrix passes; mandatory semantics fail closed where a
route cannot preserve them.

### Phase 5: native Google provider and discovery

1. Update the provider manifest and operation transport.
2. Add provider stubs for path, query, header, body, discovery, pagination, and
   error normalization.
3. Prove exact raw model identity upstream and display identity downstream.
4. Run an optional live Google canary using an existing configured credential
   without exposing it.

Exit: native Gemini features no longer depend on Google's OpenAI-compatible
endpoint, and no credential or provider detail leaks.

### Phase 6: Gemini CLI product compatibility

1. Add a pinned, non-interactive Gemini CLI harness.
2. Add a disposable project fixture that exercises the coding tool loop.
3. Add the utility-alias settings profile and user documentation.
4. Validate stable and preview; run nightly as an allowed-to-fail drift signal.

Exit: stable Gemini CLI passes the acceptance scenarios below with multiple
Pointer model/provider routes.

### Phase 7: documentation, release readiness, and review

1. Update gateway IR, compatibility inventory, API, architecture, provider,
   operations, and capability documentation.
2. Run all monorepo gates and focused security/load tests.
3. Produce a requirement-by-requirement completion report with remaining
   native-only limitations.
4. Follow clean-commit, immutable-artifact, migration backup, canary, health,
   version identity, and rollback procedures under the granted authorization.

Exit: source is release-ready; source, Git, artifact, deployed, and live states
remain reported separately.

## Test plan

### Schema and drift tests

- Validate fixtures against pinned official `v1beta` and, when implemented,
  `v1` discovery schemas.
- Fail CI on a changed pinned hash until a human reviews the schema diff.
- Cover every enum, union part type, nullable/optional boundary, unknown key,
  non-finite number, size limit, and duplicate/ambiguous model path.
- Test the exact stable SDK request shapes rather than hand-authored approximations.

### Adapter matrix tests

For all 16 public/provider format pairs, test:

- system instruction and multi-turn role/order preservation;
- text plus image/audio/video/document parts;
- function declarations, call IDs, structured arguments/results, allowed
  functions, automatic/any/none modes, and parallel calls;
- thinking, thought signatures, reasoning loss policy, and redacted reasoning;
- structured JSON/schema output;
- sampling, stops, candidate counts, finish reasons, refusals, and safety blocks;
- citations, grounding, URL context, code execution, response IDs, model
  versions, and usage;
- upstream client error, authentication error, rate limit, timeout, malformed
  body, malformed stream, and internal error redaction.

### Streaming tests

- Fragment every UTF-8 and SSE boundary, including CRLF and multi-line data.
- Interleave candidate text, thoughts, signatures, tool calls, metadata, finish,
  and usage.
- Verify structured function arguments are emitted only when complete.
- Cover multiple candidates and multiple parallel tool calls.
- Cover empty deltas, heartbeat/comment frames, clean EOF, truncated EOF,
  client abort, timeout, cancellation, and upstream disconnect.
- Prove no post-terminal events, duplicate terminal events, listener leaks, or
  continued upstream work after cancellation.

### Gateway, security, and identity tests

- Accept a valid Pointer key through `x-goog-api-key` only on Google routes.
- Reject query-string keys, conflicting auth schemes, invalid keys, cross-
  instance keys, and disallowed models without leaking lookup state.
- Prove capability rejection happens before credential lookup and provider I/O.
- Prove encoded display IDs resolve correctly and traversal/ambiguous encodings
  do not.
- Prove raw provider model IDs, credentials, upstream bodies, and internal
  route identities never reach responses, logs, traces, or metrics.
- Exercise request/media/tool/schema/candidate/token bounds and rate limits.

### Provider and database tests

- Assert native Google method, version, encoded model path, `alt=sse`, auth
  header, body omission of the route model, timeout, and abort propagation.
- Test model discovery pagination, prefix normalization, duplicates, malformed
  records, stale discovery, and capability merge policy.
- Test the migration forward from existing rows, constraints for all four
  formats, failed invalid values, rollback in a disposable database, and
  concurrent/read compatibility expected by deployment.

### Official SDK tests

Pin stable `@google/genai@1.30.0` initially and run black-box tests for:

- generate, stream, count, single/batch embed, model list, and model get;
- base URL joining, default API version, `x-goog-api-key`, encoded display model
  IDs, SSE parsing, error parsing, and abort signals;
- representative full requests with function tools, thinking, structured
  output, media, safety, and multiple candidates.

Refresh the pin when stable Gemini CLI changes it; retain the previous stable
version for one transition window.

### Gemini CLI end-to-end tests

Required release matrix:

| Channel | Planned version at research time | Gate |
| --- | --- | --- |
| Stable | `0.54.4` | Required |
| Preview | `0.55.0-preview.2` | Required or documented reviewed incompatibility |
| Nightly | `0.56.0-nightly.20260808.gcf22ac7e8` | Drift signal; allowed to fail |

Run against disposable fixtures with no user repository or secrets:

1. non-interactive plain text response;
2. streaming text and stream-json output;
3. multi-turn coding loop with a local function call and result;
4. parallel function calls;
5. structured JSON utility response;
6. thinking parts and signature replay;
7. inline image input on a capable model;
8. token-count/context-compression calibration;
9. utility-alias routing;
10. model names containing spaces and safe encoded characters;
11. model/provider capability rejection;
12. client cancellation and upstream error redaction.

Repeat the core scenarios across at least one route native to each provider API
format. A native Google route additionally tests native safety, grounding or a
built-in tool, and exact count where available. Do not require unsupported
features from incapable models merely to make the matrix green.

### Root validation gates

Run after focused tests pass:

```bash
pnpm typecheck
pnpm contracts:check
pnpm build
pnpm test:unit
pnpm test:postgres
pnpm test:e2e
```

Artifact creation and deployment require the repository's additional clean
commit, artifact verification, migration, backup, canary, health, release
identity, and rollback gates.

## Acceptance criteria

The work is complete only when all of the following are evidenced:

- An unmodified stable Gemini CLI connects through
  `GOOGLE_GEMINI_BASE_URL`/`v1beta` and authenticates using a Pointer key via
  `x-goog-api-key`.
- Every advertised Pointer display model is listable, gettable, and resolvable
  without exposing its provider model ID.
- Every generation-capable model can perform the subset its route truthfully
  declares; the full CLI agent loop passes for routes with streaming and
  function calling.
- The Google GenerateContent field inventory has no unclassified fields.
- Mandatory unsupported semantics fail before provider I/O; no silent field
  loss or fabricated data is possible.
- Google-native fields round-trip on a native Google route, including thought
  signatures and provider metadata.
- All 16 format-pair request/response/error/stream test suites pass.
- Token counts are labeled exact or estimated; embeddings are real or rejected.
- Stable CLI and SDK gates pass, preview status is reviewed, and nightly drift
  is reported.
- Security, redaction, cancellation, migration, contracts, and all root
  validation gates pass.
- Documentation includes setup, utility aliases, capability matrix,
  troubleshooting, and version support.
- Source, Git, artifact, deployment, live service, and remaining limitations are
  reported separately.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Gemini CLI/SDK schema changes quickly | Pinned stable/preview/nightly matrix plus discovery-hash drift gate |
| “Any model” is mistaken for “every capability” | Advertise granular capabilities and reject required unsupported semantics |
| Internal CLI utility aliases bypass the chosen Pointer model | Ship explicit `customAliases` profile; never silently substitute identities |
| Google-only semantics are lost cross-provider | First-class IR, native extension allowlist, strict preflight, compatibility findings |
| Tool-call argument framing differs between streams | Bounded buffering and JSON validation before Google emission |
| Thought-signature corruption breaks tool replay | Opaque positional preservation; never synthesize or normalize signatures |
| `v1` Google list conflicts with OpenAI `/v1/models` | Canonical `v1beta`; add reviewed header-dispatched `v1` behavior only with contract tests |
| File URIs introduce SSRF or unusable cross-provider references | Never dereference; native/provider-scoped pass-through only |
| Estimated token count causes context mistakes | Conservative documented estimate, source label, strict exact-only policy |
| Native built-in tools imply new execution authority | Pass through/map only when proven; otherwise format-correct unsupported error |
| Error/telemetry leaks provider or secret state | Normalize and bound all errors; adversarial redaction tests |

## Requirement trace

| User requirement | Planned evidence |
| --- | --- |
| Google AI format accepted by Gemini CLI | Official SDK wire endpoints, route/auth/SSE adapter, stable CLI E2E |
| Current implementation | Implementation-time version/discovery refresh and stable/preview/nightly gates |
| Any Pointer model | Display-identity model list/get/resolve plus capability-tier acceptance |
| All model/API features | Complete GenerateContent field inventory; exact, native-only, mapped, or rejected classification |
| Implementation plan | Seven phased implementation sequence with exits |
| Testing plan | Schema, 16-path matrix, streaming, security, provider, PostgreSQL, SDK, CLI, and root gates |
| Authorized deployment and push | Clean-commit artifact, verified backup/migration, live acceptance, deployed identity, and pushed `main` evidence |

## Primary sources

- Google Gemini API overview: <https://ai.google.dev/api>
- GenerateContent API: <https://ai.google.dev/api/generate-content>
- Token counting: <https://ai.google.dev/api/tokens>
- Embeddings: <https://ai.google.dev/api/embeddings>
- Models: <https://ai.google.dev/api/models>
- All methods: <https://ai.google.dev/api/all-methods>
- Function calling: <https://ai.google.dev/gemini-api/docs/generate-content/function-calling>
- Thought signatures: <https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>
- Structured output: <https://ai.google.dev/gemini-api/docs/generate-content/structured-output>
- Official Gemini CLI configuration:
  <https://github.com/google-gemini/gemini-cli/blob/v0.54.4/docs/reference/configuration.md>
- Official Gemini CLI content generator:
  <https://github.com/google-gemini/gemini-cli/blob/v0.54.4/packages/core/src/core/contentGenerator.ts>
- Official Gemini CLI base LLM client:
  <https://github.com/google-gemini/gemini-cli/blob/v0.54.4/packages/core/src/core/baseLlmClient.ts>
- Official Gemini CLI chat implementation:
  <https://github.com/google-gemini/gemini-cli/blob/v0.54.4/packages/core/src/core/geminiChat.ts>
- Official Gemini CLI default model configs:
  <https://github.com/google-gemini/gemini-cli/blob/v0.54.4/packages/core/src/config/defaultModelConfigs.ts>
- Official Google Gen AI JavaScript SDK documentation:
  <https://googleapis.github.io/js-genai/>
