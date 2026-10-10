# OpenCodex engine integration

Pointer retains ownership of user identity, model catalog presentation, groups,
instances, inference keys and managed application lifecycle. OpenCodex supplies
provider authentication, upstream routing and protocol execution. The engine
dependency is pinned to an exact release; updates require integration acceptance.

## Process and storage boundary

OpenCodex has process-global caches and file-backed configuration. Independent
owners must not share one mutable configuration or credential home. Pointer
starts owner-scoped engine processes with private state and loopback listeners.
No client chooses an engine address or filesystem path. Pointer authenticates
the instance key and resolves ownership before selecting an engine.

PostgreSQL remains authoritative for Pointer product records. OpenCodex owns its
private engine configuration, account tokens, continuation state and SQLite
coordination files. Provider refresh must have one writer. Backups must retain
both stores and their binding records. Private files are never returned by a
browser API or included in source/build artifacts.

Local coding-client configuration injection and automatic package updates are
disabled for managed engine processes. They must not inspect or change the
operator's native client homes. Engine versions are upgraded by Pointer's
deployment process, not independently by a background updater.

## Request boundary

The integration passes Responses, Chat and Messages bodies to the engine
without running Pointer's general-purpose protocol translation first. Public
model names resolve to an owner-authorized upstream selector. Responses stream
incrementally with cancellation and correlation preserved. Instance credentials
and host assertions are never forwarded to an upstream provider.

Google-compatible generation uses a dedicated ingress adapter because Google
upstream support does not establish a Google incoming API. The adapter converts
Gemini requests to Responses and emits Gemini JSON or incremental SSE. It holds
only active tool arguments while streaming. Gemini token counting uses the
engine's Messages token estimate and marks it with
`x-pointer-token-count-source: estimated`. Provider-native Google token counting,
embeddings and the broader Gemini multimodal matrix remain required acceptance work.

Response continuation handles are authenticated for one owner and instance.
Rotating an instance key retains that scope; another instance cannot reuse a
handle. The signing secret must survive backup/restore. Provider-visible cache
keys are also scoped to the instance. Neither boundary replaces Pointer's live
key, owner, group and managed-installation authorization. Embedded Claude
`ocx-route` overrides cannot bypass group routing. Responses conversation IDs,
stream IDs and stored item references are rejected until their instance ownership
can be verified; callers can use the scoped `previous_response_id` path.

The `/api/connections/providers/:name/compatibility` GET/PUT operation exposes
`supportsResponsesCustomTools` as a boolean or null (upstream default). Set it
to false for Responses endpoints that reject custom tools: OpenCodex then owns
custom-to-function translation and response restoration. Pointer uses upstream's
secret-free provider editor with its baseline conflict check, preserving stored
credentials and unrelated settings. It does not rewrite protocol payloads or
invent native client catalog enum values.

The `/api/connections` management surface exposes an explicit subset of upstream
account/provider/pool operations. It excludes arbitrary config writes, coding
client integration, native credential import and credential export. ChatGPT
sign-in uses the upstream device flow. Engine listeners remain private; upstream
loopback inference admission does not enforce Pointer's tenant boundaries.

`POST /api/connections/sync` projects non-secret provider/model inventory into
PostgreSQL, including a stable account binding and exact upstream selector.
Models without enough identity evidence retain separate provider-scoped routes;
engine discovery alone never establishes a shared canonical identity.

Providers shows the full upstream model inventory. Pointer groups are the only
app model-selection boundary. Synchronization clears OpenCodex's initial
visibility gate through its supported atomic operation; no second enable/disable
UI is exposed. Provider account disabling remains separate from model selection.
Unidentified engine models retain exact provider-scoped route identities rather
than disappearing or being merged without evidence. Reference-catalog refresh
loads public metadata for the full model list; a source failure retains the
previous snapshot and reports a warning. Labels preserve explicit
provider/operator names and otherwise format recognized family spellings for
display; upstream selectors and version suffixes remain unchanged. Such fallback
labels are presentation, not additional model identity/capability evidence.

## Product controls

Provider detail screens expose upstream account/key selection, labels, removal,
reauthentication and supported pause/cooldown controls. Pool settings come from
that provider's supported settings list; missing quota or balance remains unknown.
Connection probes test the engine's supported discovery endpoint, not inference.
Provider statistics and request diagnostics report measured usage, routing attempts,
cache/reasoning detail and incomplete price coverage. API price estimates do not
represent subscription billing.

Provider model controls expose upstream validated model names, context-window
overrides, price overlays and custom endpoint model inventory. Adding an inventory
entry does not grant an app access; it must still be selected in its Pointer group.
The native OpenAI lane retains its own context configuration restrictions.

Usage records retain the Pointer request ID and allowlisted upstream error codes.
HTTP 200 followed by an SSE error remains a failed inference; a missing terminal
event is recorded as `incomplete_stream`. Provider error messages and arbitrary
payloads are excluded from this diagnostic projection. A retained null code means
the precise rejecting condition is unknown.

Named routing rules belong to groups. Their ordered targets reference distinct
enabled group entries; names cannot replace positional aliases. Pointer validates
all target accounts and discovered routes before configuring a private engine Combo.
Disabled or unavailable targets are skipped; a rule needs an authorized live target. Failover and weighted
round-robin use the upstream engine; direct public Combo writes are rejected.
Aggregate group routing usage uses `group-routing` attribution, while upstream
request diagnostics retain physical attempts. A rule's engine identifier is stable
for one owner/group/name and cannot be supplied to bypass a group's public names.

The Gemini bridge recognizes the engine's Codex quota/header control events and
final-answer labels without treating them as generated content or completion.
Account entitlement metadata is omitted from Gemini responses; unknown protocol
events and incomplete streams still fail. Responses string input is expanded to
its equivalent user-message list before engine dispatch. Aggregate usage uses
PostgreSQL's wide sums, including cache counts, and returns numeric JSON beyond
the 32-bit per-request token range.

Responses compaction uses `/v1/responses/compact` with the same instance boundary
as Responses generation. Cache and reasoning counts preserve missing versus zero;
Anthropic cache reads/writes count inside the total prompt size.
Search and vision helper settings are owner-scoped upstream controls. Enabling a
helper can consume the selected account's allowance. Native client injection and
self-update remain disabled.

Catalog refresh includes public benchmark feeds and retains previous evidence on
failure. The Models screen offers explicit refresh and source health. With full
background maintenance disabled, `POINTER_CATALOG_JOBS_ENABLED=true` enables only
catalog refresh with the existing source interval and retry backoff; it does not
invoke Pointer's former provider authentication/discovery handlers.

## Packaging and updates

The dependency is pinned to published OpenCodex 2.79.0 (registry git head
`beba8b7e5e479f3d8b4d404e3e47cf4aaef4d936`). No upstream source files are patched.
Both build paths must retain the engine package, its worker entrypoint and all
upstream runtime assets. The headless artifact carries Bun 1.4.2. The permanent
offline build kit and dependency store need corresponding input reconciliation
before that executor can build this branch; its retained manifest digest is
not evidence of that work having happened.

`POINTER_ENGINE_STATE_DIR` selects private persistent storage.
`POINTER_ENGINE_PROCESSES` defaults to two concurrent owner processes;
`POINTER_ENGINE_IDLE_MS` defaults to five minutes. A stream holds its lease until
completion or cancellation. Busy capacity is reported as retryable failure;
idle eviction preserves files and waits for process exit before reusing a slot.
These limits bound process count, not individual provider latency or total RSS.

An upstream update requires reviewing public API/config changes, updating the
exact pin and lockfile, then repeating engine HTTP, PostgreSQL lifecycle,
packaging, provider and resource acceptance. Update merging is not automatic
proof of compatibility.

## Acceptance status

Synthetic HTTP fixtures exercise account isolation, provider management, all
three upstream incoming protocols, streamed Gemini tools and matching results,
Responses continuation, cancellation, provider errors, restart persistence and
bounded capacity. Disposable PostgreSQL acceptance exercises authenticated
connections, catalog/group/instance creation, positional aliases, usage writes,
cross-instance continuation rejection and key revocation.

The Providers list and per-provider pages use the upstream preset and admitted
OAuth discovery interfaces. Each provider owns its account setup and model list;
ChatGPT device login, remote OAuth redirect/code submission, upstream key presets
and custom endpoints share that structure. Authentication UI coverage is not
proof that every external subscription works. The same screens also build as a host-runtime
module; see [the shared UI contract](shared-ui.md). Browser fixtures verify two
isolated mounts without another React runtime or an iframe. Host deployment and provider acceptance must be verified on each installation;
fixture coverage alone does not establish them. Cold-imported Codex credentials
remain validation-pending until the upstream account validation flow performs its
quota and generation checks. Passive quota inspection does not clear this gate.
Retain a paired PostgreSQL and private-engine backup before migration, stop the
previous credential writer, and never force validation flags to bypass checks.

## Bounded failure receipts

Usage retains `pointer.engine-failure.v1`: initial HTTP status is separate from
terminal outcome, with allowlisted event types, monotonic timings, local abort
attribution, source commit and trusted engine process generation/exit. The
supported Responses `x-opencodex-request-id` (`ocx-` plus 32 hexadecimal digits;
older retained IDs have seven uppercase hexadecimal digits) links a bounded
`/api/logs` lookup to exactly one request's aggregate attempts. Other endpoints
do not expose that header in 2.79.0 and retain an explicit correlation gap.
A log attempt can include several physical
sends; per-send status/timing, provider acknowledgement and upstream WebSocket
close details remain unavailable. Missing/ambiguous/oversized log reads preserve
a coverage gap and never trigger a retry or change inference output.

Compact sanitized receipts are fsynced before usage database queries. The
private bounded spool (`POINTER_DIAGNOSTIC_SPOOL`, managed default
`/var/lib/pointer/diagnostic-spool`) replays stable usage IDs after restart,
preserving unknown pricing instead of recalculating a historical cost. Capture
failure/overflow has a durable coverage marker. Stats returns only the authenticated
owner's receipts; the existing request filter selects an exact request ID.
No prompts, responses, provider-controlled close text, credential headers,
hidden reasoning or blanket engine stdout/stderr enter this capture contract.
