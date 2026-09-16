# Gateway V1 Compatibility

This document defines the active pre-release gateway contract. All public proxy routes and internal engine labels remain V1.

## Public formats

| Format | Route | Declared wire version |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `v1` |
| Anthropic Messages | `POST /v1/messages` | `2023-06-01` |
| OpenAI Responses | `POST /v1/responses` | `v1` |
| Google GenerateContent | `POST /v1beta/models/{model}:generateContent` and streaming action | `v1beta` |

The `model` field is normally a display name returned by the caller's `GET /v1/models`. Pointer server also
accepts the instance group's hidden positional aliases (`big`/`opus`/`default`,
`medium`/`sonnet`/`secondary`, and `small`/`haiku`/`utility`) without advertising them. Resolution is
case-insensitive, instance-scoped, and constrained by the API-key allowlist. Provider raw IDs are
internal route data.

## Support states

- `native`: the target format represents the feature directly.
- `emulated`: Pointer preserves the semantic result through a documented transformation.
- `lossy`: a known part cannot be represented; best-effort requires an explicit finding.
- `unsupported`: execution is unsafe or materially incorrect and is rejected.
- `unknown`: evidence is insufficient; security-sensitive unknowns are rejected.

Best-effort does not mean silent. A lossy transformation must be identified by stable feature and detail codes. Unsupported features never proceed.

## Capability preflight

Before credential lookup, Pointer server derives requested capabilities from the validated request:

- a non-empty `tools` or legacy `functions` array requests tools;
- image, image URL, or input-image content requests vision;
- `stream: true` requests streaming.

If the selected route explicitly lacks one, Pointer server returns HTTP 400. Messages callers receive
a Messages error envelope; Chat Completions and Responses callers receive an OpenAI-style error;
Google callers receive a Google RPC-style error. Each uses the stable code
`pointer_feature_unsupported`. The provider is not contacted.

Anthropic typed server-tool declarations are a separate capability from ordinary
caller-executed function tools. Pointer does not currently model Anthropic
server-tool execution, citations, or provider-native server-tool result events.
`POST /v1/messages` therefore rejects a typed tool such as
`web_search_20250305` before model resolution, credential lookup, or provider
I/O with HTTP 400 and `pointer_feature_unsupported`. Callers may continue to
use ordinary Messages tools defined by `name`, `description`, and
`input_schema`; Pointer translates those tool calls but never executes them.

## Translation guarantees

Text order, role order, tool call/result correlation, JSON arguments, usage, finish reasons, and meaningful stream lifecycle are preserved when representable. Reasoning signatures and encrypted reasoning are never fabricated. Provider-specific extensions round-trip only in their source namespace and are explicitly dropped or rejected cross-format. A native Google route retains the complete validated GenerateContent payload. A Google request targeting another provider format uses a portable-field allowlist and rejects any unknown or Google-only input field before provider inference.

For Chat Completions streams, a non-null `finish_reason` closes content but does
not by itself close the wire stream. Pointer accepts following usage accounting
whether it arrives with empty choices or an otherwise-empty choice that repeats
the same finish reason, then closes the response at `[DONE]`. A conflicting
repeated finish reason remains invalid. If an otherwise valid upstream ends
cleanly after the finish chunk without sending `[DONE]`, Pointer emits the
missing terminal marker. Meaningful content after a finish reason, or EOF before
any terminal, remains a translation failure. This lifecycle preserves
`stream_options.include_usage` behavior used by Fireworks, OpenRouter, xAI and
other OpenAI-compatible providers without treating their final usage chunk as
post-terminal data. OpenAI-compatible `delta.reasoning` is normalized to the
public Chat `delta.reasoning_content` field.

Unknown fields, authorization fields, malformed nested content, invalid tool schemas, non-finite JSON numbers, and orphan tool results are rejected with bounded validation details.

For native Anthropic Messages passthrough, Pointer forwards the caller's `anthropic-version` and
optional `anthropic-beta` headers. JSON transport-only `anthropic-version` is removed from the body;
allowlisted beta fields including `context_management` remain intact. This preservation does not
claim that every Anthropic-compatible upstream implements every beta feature.

## Errors and privacy

Public errors use stable Pointer codes and bounded messages. Rate-limit retry metadata may be forwarded only from allowlisted headers. Raw upstream response bodies, arbitrary headers, URLs, bearer values, provider keys, OAuth tokens, JWTs, and `ptr_` keys are excluded from errors, warnings, logs, and telemetry.

A provider-native SSE error event is a terminal upstream failure, not a stream
translation failure. Pointer closes any open translated content block, emits a
format-correct redacted error, cancels the upstream reader, and records
`upstream_error`. Malformed or unsupported non-error events remain
`translation_error` failures. Provider error messages and provider-private
codes are not copied to the public stream. Every public error stream carries a
bounded Pointer-owned code. Its `x-pointer-request-id` is the same identifier
used by the adapter and telemetry; an unrelated application correlation ID
cannot overwrite it.

Every gateway response identifies engine `v1`. Streaming responses also carry one Pointer request ID. No configuration variable can select another engine.

## Stream lifetime

The Bun listeners retain a 60-second idle timeout as protection for ordinary
requests. After a request has passed public-format validation and is confirmed
to have `stream: true`, Pointer disables Bun's idle timeout for that request
with the server's request-scoped timeout API. This applies consistently to all
sixteen client/provider format combinations and permits a valid upstream SSE
stream to remain quiet while a provider is generating or between structured
tool-argument deltas.

Pointer does not emit synthetic SSE comment heartbeats. Translation continues
to forward each complete upstream SSE event immediately, including partial
structured-tool argument deltas. Downstream cancellation still cancels the
upstream fetch and stream reader, including while Pointer is still waiting for
provider response headers. A terminal provider event also cancels and releases
that reader so provider heartbeats cannot retain a completed request. Reverse proxies must
leave SSE response buffering off and use read/send timeouts suitable for long
inference requests.

## Telemetry

Each completed proxy attempt records one usage outcome: `success`, `upstream_error`, `translation_error`, `timeout`, `client_abort`, or `incomplete_stream`. Cost uses immutable price snapshots and remains unknown when pricing is missing. Throughput uses provider completion time when trustworthy, otherwise observed generation time after meaningful TTFB; total request latency is not used.

## Non-goals

Pointer does not execute tools, continue agent loops, manage conversations, or retry paid generation through a second model automatically. The Pointer web proxy-test page is a caller of these routes, not a separate runtime.

The Google compatibility boundary is the GenerateContent model inference family used by Gemini
CLI, including model discovery, token count, and native embeddings. It does not claim the Google
Interactions, Live, Files, cache lifecycle, tuning, or job-control APIs. See
[google-gemini-cli.md](./google-gemini-cli.md).
