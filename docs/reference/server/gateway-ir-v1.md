# Gateway IR V1

Gateway IR V1 is the only request translation engine in Pointer server. It lives at `apps/server/src/gateway/protocol/v1` and uses internal protocol name `pointer.gateway.ir`, version `1`.

## Boundary

```text
public request
  -> strict public-format schema
  -> normalized V1 request IR
  -> compatibility assessment
  -> direct provider-format renderer using the raw route ID
  -> one provider request
  -> normalized V1 response/error/stream IR
  -> caller-format renderer
```

The boundary accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and Google
GenerateContent. There is no engine selector, shadow evaluation, alternate translator, or legacy
passthrough path.

## Request IR

The request protocol preserves:

- ordered system, developer, user, assistant, and tool turns;
- text, URL/base64/file images, audio, files, reasoning, refusal, tool calls, and tool results;
- tool identity and JSON arguments;
- sampling controls including top-k, candidates, penalties, seed, and log probabilities; output
  limits; stop conditions; structured response MIME/schema; and parallel tool-call intent;
- allowlisted source-format extensions with their namespace;
- source format, canonical model identity, and compatibility findings.

The renderer replaces the public display/canonical model with the route's exact `providerModelId`. Unknown top-level fields are not silently forwarded. Credential-shaped fields are denied.

## Response and errors

Responses normalize ordered output blocks, finish reason, usage dimensions, reasoning data, tool identity, and safe allowlisted extensions. A target format that cannot represent required semantics returns a stable Pointer error rather than leaking or inventing provider data.

Upstream errors are normalized from status and allowlisted metadata only. Provider bodies, URLs, arbitrary headers, and credentials never enter public error envelopes or telemetry. Pointer request IDs correlate response headers, stream events, logs, and usage.

## Streaming

Each provider SSE line is parsed incrementally into V1 stream events and rendered to the caller format. State tracks response lifecycle, content blocks, tool calls, partial arguments, usage, and terminal reason. Exactly one terminal event is rendered for a valid trace.

The byte boundary handles fragmented UTF-8, CRLF, multiple chunks per line, and a final line without a newline. Meaningful-token TTFB ignores SSE comment heartbeats, data-bearing Responses `keepalive`/`ping` events, role-only events, and empty lifecycle events. Client cancellation cancels the upstream reader and records a client-abort outcome. A provider stream that ends without a valid terminal event returns a redacted format-correct stream failure and records an incomplete stream.

## Compatibility modes

Adapter policy is `best-effort` by default inside the single V1 engine. Known representational degradation may proceed only when the adapter emits an explicit compatibility finding. `strict` is available to internal conformance callers and rejects lossy findings. Unsupported and unknown security-sensitive semantics always fail closed.

Route capability preflight is separate from wire-format compatibility. It checks tools, image input, and streaming before provider credentials are read.

## Verification

Conformance tests cover all sixteen source/target request, response, error, and stream combinations;
hostile public boundaries; reasoning, opaque Google thought signatures, and tool preservation;
deterministic IDs; semantic-loss findings; redaction; stable errors; raw provider model routing; and
complete stream lifecycle behavior. An official Google SDK black-box test covers the Gemini CLI
transport contract.
