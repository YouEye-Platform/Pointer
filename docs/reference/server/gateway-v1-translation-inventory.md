# Gateway V1 translation inventory

This document records the active direct translation surface for the four public V1 proxy formats:
OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and Google GenerateContent. It is
maintained alongside the typed schemas and executable sixteen-path conformance matrix in
`apps/server/src/gateway/protocol/v1`.

## Execution model

Every request follows one route:

1. Parse and validate the caller's public V1 envelope.
2. Resolve the display model to a provider route and exact raw provider model ID.
3. Reject unsupported tools, image input, or streaming before provider credential access.
4. Normalize the request into the typed V1 intermediate representation.
5. Render directly to the provider's declared native format.
6. Parse the provider response, error, or SSE stream into the same representation.
7. Render directly to the caller's requested public format.

There is no generic Chat-shaped hub, provider passthrough path, alternate engine, or client-selectable
translation mode. Native source/target pairs still cross typed parse and render boundaries so model
routing, validation, error handling, telemetry, and IDs behave consistently.

## Request coverage

| Semantic area | Chat Completions | Messages | Responses | Google GenerateContent | V1 behavior |
|---|---|---|---|---|---|
| Model identity | `model` | `model` | `model` | URL model resource | The public display identity is retained for responses and telemetry; the provider receives only its exact raw model ID. |
| Instructions | system/developer messages | top-level `system` | `instructions` and message items | `systemInstruction` | Normalized as ordered instruction/text turns. Unsupported ordering or roles fail validation instead of being silently reclassified. |
| Text content | strings and text parts | text blocks | input/output text parts | ordered `Content.parts[].text` | Text and ordering are preserved across supported routes. |
| Media input | image URL/data, audio, file | image blocks | image/audio/file input parts | `inlineData` and `fileData` | Inline common media is typed. Google provider-scoped file references are native-only. Model capability preflight runs before provider inference. |
| Tool definitions | function tools | custom tools | function and built-in tools | function declarations and built-in tools | Names, descriptions, JSON schemas, strictness where representable, and tool choice are normalized explicitly. Google built-in tools remain native-only. |
| Tool calls/results | assistant tool calls and tool messages | `tool_use` / `tool_result` | function call/output items | `functionCall` / `functionResponse` | Call IDs, names, arguments, and results remain correlated across formats. Invalid JSON arguments are never silently replaced with `{}`. |
| Sampling | temperature, top-p, stop | temperature, top-p, top-k, stops | temperature, top-p | `generationConfig` | Common temperature, top-p/top-k, output limit, stops, candidate count, penalties, seed, and log-probability controls are typed; target-incompatible Google controls fail closed. |
| Structured output | response format | target-dependent | `text.format` | MIME type and JSON Schema | JSON object/schema intent is mapped only where the target has an equivalent. |
| Token limits | completion token fields | `max_tokens` | `max_output_tokens` | `maxOutputTokens` | Normalized to an output-token limit and rendered under the target spelling. |
| Reasoning | reasoning controls/content where defined | thinking blocks where defined | reasoning controls/items | thinking config and thought parts/signatures | Opaque thought signatures are preserved positionally and never synthesized. Unsupported combinations produce compatibility findings or rejection. |
| Safety and metadata | provider extensions | provider extensions | annotations/provider extensions | settings, feedback, ratings, citation, grounding, URL context, code execution | Native Google fields round-trip. Input semantics that cannot cross formats are rejected; Pointer never fabricates provider metadata. |
| Streaming | `stream` | `stream` | `stream` | `streamGenerateContent` SSE | Preserves client intent. Provider SSE is parsed incrementally and rendered into the caller's event protocol. Native Google chunks retain candidate and metadata structure. |
| Extensions | known typed fields only | known typed fields only | known typed fields only | validated format-scoped native payload | Extensions do not cross formats implicitly. Google cross-format requests use an allowlist and reject unknown native fields. |

## Response and error coverage

Non-stream responses normalize IDs, model identity, output text, tool calls, finish/stop reasons, and
usage. Provider-native error bodies are parsed into a safe V1 error representation and rendered in
the caller's envelope. Credential values, upstream authorization headers, raw provider bodies, and
stack traces are never included in client errors or compatibility diagnostics.

Unknown pricing remains unknown. Usage records capture the public model, provider route, immutable
catalog entity when resolved, input/output/cached/reasoning tokens, cost snapshot, status, outcome,
latency, meaningful-token TTFB, and generation timing.

## Streaming invariants

- UTF-8 decoding survives arbitrary byte fragmentation, including multi-byte characters.
- CRLF and LF line endings are accepted, and a final unterminated SSE line is flushed at EOF.
- Keepalive, role-only, and envelope-only events do not set TTFB.
- Generated event and object IDs derive from the stable Pointer request ID.
- Usage is captured from terminal provider events when supplied.
- Incomplete streams, timeouts, and client cancellation are distinct telemetry outcomes.
- Cancellation propagates to the upstream reader and does not emit synthetic completion events.
- Public responses include `x-pointer-gateway-engine: v1` and `x-pointer-request-id`.

## Executable evidence

The protocol tests cover all sixteen source/target format combinations for requests, non-stream
responses, provider errors, and streams. Boundary reviews exercise semantic loss, malformed input,
stable IDs, and public schemas. Route-level tests cover capability preflight and telemetry across all
four public formats. An official `@google/genai@1.30.0` black-box contract test additionally proves
the Google action paths, authentication header, encoded model identity, model discovery, token
counting, embeddings, and SSE consumption. The SSE line decoder is tested with every possible
single-byte boundary.

Production acceptance additionally requires real provider calls through all four public formats,
both streaming and non-streaming where supported, because provider behavior cannot be proven by
fixtures alone.

The detailed Google field policy, Gemini CLI setup, native-only boundaries, operation routes, and
troubleshooting are documented in [google-gemini-cli.md](./google-gemini-cli.md).
