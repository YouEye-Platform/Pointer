# Streaming provider compatibility implementation plan

**Status:** Completed

**Date:** 2026-07-31

**Authoritative repository:** `https://github.com/YouEye-Platform/Pointer`

**Implementation branch:** `main`

**Implementation authority:** The product owner authorized planning,
implementation, validation, Git publication, production deployment, public E2E,
iteration and documentation on 2026-07-31.

## Outcome

Make Pointer's streamed Chat Completions path compatible with providers that
send a finish chunk followed by a usage-only chunk and `[DONE]`. Make Test Model
show reasoning, surface stream failures, use a practical reasoning-model output
budget and avoid reporting a failed stream as complete.

The work covers:

- `apps/server`: stream lifecycle parsing, safe failure propagation and usage
  telemetry;
- `apps/web`: Test Model stream parsing, reasoning presentation, terminal error
  presentation and token-budget defaults;
- focused server and browser regression tests;
- representative live provider acceptance through the deployed same-origin
  application; and
- release, deployment and rollback evidence.

It does not change provider credentials, billing, quotas or account settings.
The independently observed OpenAI HTTP 429 condition remains an operational
owner/provider issue unless normal inference begins succeeding during
acceptance.

## Verified baseline

Read-only production diagnosis established:

- Fireworks Kimi K3 is ready, serverless and routable.
- A 128-token Kimi K3 Test Model request spent the complete budget without
  visible final content.
- A 512-token request returned reasoning and final content.
- Fireworks, OpenRouter and xAI returned valid content and `finish_reason:
  stop`, then Pointer appended a false `upstream_error` when their separate
  usage chunk followed.
- DeepInfra completed the equivalent stream cleanly.
- Test Model ignored `reasoning_content` and SSE error objects, then
  unconditionally reported completion.
- usage telemetry captured provider token counts but recorded the selector
  failures as HTTP 200 successes.
- two different OpenAI inference models returned HTTP 429 while the
  metadata-only credential test succeeded.

All temporary diagnostic instances and keys were removed. The baseline source
commit is `425dbbd99f20c04ad8620d176e8e40ee76e48150`; production runs
`27e7c3441b1d95fac5657358539a5b5a5d8f06ae`.

## Implementation

1. Keep a Chat Completions finish reason pending until the provider's `[DONE]`
   marker, allowing a usage-only chunk or an OpenRouter-style final accounting
   choice that repeats the same finish reason to be normalized before the
   terminal IR event.
2. At clean EOF, synthesize the pending Chat terminal for compatible providers
   that omit `[DONE]`; continue to fail closed when no terminal was observed.
3. Normalize OpenAI-compatible `delta.reasoning` aliases to
   `delta.reasoning_content`.
4. Expose stream-selector failure state to telemetry so malformed streams are
   not recorded as successful requests.
5. Parse Test Model reasoning and stable stream errors. Never call the
   completion handler after a stream error.
6. Render reasoning separately from the final answer and count either as
   first-token activity.
7. Raise the Test Model default output limit from 128 to 512 tokens while
   retaining the existing explicit 1–4096 validation.
8. Cover split and repeated-finish usage accounting, clean EOF, malformed
   streams, reasoning display and terminal error display with deterministic
   tests.

## Validation gates

Before release:

- [x] focused server stream lifecycle tests;
- [x] focused Playwright Test Model tests;
- [x] all workspace type checks and contract checks;
- [x] complete server and CLI unit suites;
- [x] guarded PostgreSQL integration suites;
- [x] production server, CLI and web builds;
- [x] complete Chromium repository E2E;
- [x] clean-tree immutable server and web artifact creation and verification.

Production acceptance:

- install the matched server and web artifacts on LXC 225 with the full profile;
- verify service, router, readiness, version and public TLS health;
- repeat small Test Model calls against Fireworks Kimi K3, Fireworks or
  OpenRouter reasoning output, xAI and DeepInfra;
- require final content, reasoning visibility where emitted, usage delivery,
  no false terminal error and correct telemetry;
- verify the OpenAI metadata connection and record inference HTTP 429
  separately if it persists;
- verify temporary test resources are gone, service restart counts are clean
  and warning-or-higher journals contain no new release error.

## Release and rollback

The source release must be a clean, pushed `main` commit. Build immutable
artifacts from that exact commit and retain the current production release as
`/opt/pointer/previous`.

No database schema change is planned. Application rollback therefore repoints
`/opt/pointer/current` to the verified previous release and restarts
`pointer-server`, `pointer-web` and `pointer-router`; no database restore is
expected.

After acceptance, record exact source, artifact, Git, deployed, E2E, cleanup and
rollback evidence in `docs/deployments`.

## Completion

The final source and deployed release is
`7663f384445b8c9769034aa74f52bfc7cb1b2baa`. Production acceptance passed for
Fireworks Kimi K3, OpenRouter Kimi K3, xAI Grok 4.3 and DeepInfra Llama 3.3
70B, plus the deployed Test Model browser flow. OpenAI credential metadata
remained healthy while inference continued to return provider HTTP 429.

Exact artifacts, test counts, provider results, telemetry, cleanup and rollback
state are recorded in
[`deployments/README.md`](./deployments/README.md).
