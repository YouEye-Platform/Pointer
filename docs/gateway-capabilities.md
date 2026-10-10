# Endpoint capabilities and tool compatibility

Pointer resolves wire support independently of model names. Precedence is the
protocol baseline, provider `gateway.wire`, discovered model `wireCapabilities`,
then the owned provider account's explicit `wireCapabilities` overrides. The
account API validates overrides; only its owner can read or change the account.
The effective profile appears as `wire_capabilities` in `/v1/models` and governs
requests as well as downstream harness catalogs.

Standard Responses defaults to JSON functions. Extended Responses support for
additional tools, namespaces, raw custom tools, grammar, client metadata,
reasoning context, verbosity and tool search requires an explicit claim.
Responses containers cannot be enabled on Chat Completions, Messages or Gemini.
`reasoningEfforts` advertises only declared labels; an unknown list is not a
license to copy another model's choices. `toolNameMaxLength` bounds aliases.
Codex account discovery normalizes the backend's declared reasoning levels into
this profile and preserves whether any recognized level is available. A model
name does not establish reasoning support; absent metadata stays absent.

The existing IR models tool declarations, namespace membership, JSON versus raw
string input, client tool-search calls, results and call IDs. Top-level,
additional and deferred definitions join one deterministic table. Equivalent
JSON definitions deduplicate regardless of property order; conflicting identities
and ambiguous history references fail explicitly. Namespace aliases reserve
existing names, hash collisions and retain the original identity for replies.

All routing pairs, including Responses to Responses, use the same codec. A
portable endpoint receives hoisted definitions and string-argument functions
for raw tools (`{"input":"raw text"}`). Returned JSON and streamed calls recover
the original kind, namespace, name and call ID. Custom argument fragments remain
buffered until a complete JSON string can be decoded; added/input/done/terminal
events remain ordered. Native declarations and calls stay native when supported.
Client deferred-search histories become ordinary paired calls/results and their
returned declarations are exposed eagerly. Unsupported server-side search and
opaque reasoning replay across incompatible protocols fail instead of dropping
history or inventing backend behavior.

Client-executed tool search retains its supplied argument schema and description
on the native Responses wire. Portable function lowering uses that same schema;
it does not invent a fixed search argument name. Client search without an object
argument schema is rejected before inference. Initial and deferred declarations
share this contract, while hosted server search remains a separate capability.

A grammar unsupported by the backend is a prompt instruction, not enforcement.
Such responses carry `x-pointer-tool-grammar: prompt-only`; strict compatibility
rejects this degradation. Backend and client validation are separate claims.
Pointer and Crew do not retry generations automatically.

## Local provider accounts

`POINTER_ALLOW_LOCAL_ENDPOINTS=true` enables HTTP and private-network endpoints
for existing provider-account users. Public HTTPS remains the default policy.
No additional administrator role is required to save an owned account. URLs
must omit embedded credentials, query strings and fragments. Metadata,
link-local, unspecified, multicast and other special destinations remain blocked.
Model discovery and inference pin a validated DNS address to the connection,
keep TLS hostname/certificate verification enabled and refuse redirects. Native
route paths must remain within the configured account endpoint.

Basic Model Test sends one prompt through an exact owned account/model route.
It includes discovered provider-only models without claiming a canonical catalog
identity. Success demonstrates basic inference; worker conformance additionally
requires tools, choices, histories, reasoning replay and streaming tool calls.
The common offline corpus covers standard/extended Responses, Chat Completions,
Messages and Gemini. Live acceptance must use isolated bounded fixtures, record
observable calls/results and avoid existing workers.

Upstream 400/422 rejections and 404/405 model/endpoint errors have separate safe
categories. Error-body inspection is bounded by bytes and time, provider prose is
never reflected, and only allowlisted machine codes and parameter paths survive.
Pointer request IDs remain the correlation key.

Hosted web search is separately declared with `webSearch`; portable endpoints default to disabled. Unsupported hosted search is rejected explicitly before inference. Native nullable reasoning placeholders are accepted when replaying tool-call history.

Encrypted Responses reasoning supplied on a completed stream item is retained in the IR completion and both item-done and terminal output, so the next tool-result turn can replay it. Incompatible protocol routes fail explicitly when opaque replay cannot be represented.

## Tool evidence and admission

Base tool capability is tri-state. `/v1/models` reports `capabilities.tools`
as `true`, `false` or `null` and includes `capability_evidence.tools` with
`supported`/`unsupported`/`unknown`, source and observation time. Missing metadata
is unknown; it permits a tool request through a compatible codec and does not
establish model quality or worker conformance. Explicit negative declarations
reject tool declarations and tool-bearing history before generation.

An owned account's `capabilityOverrides: {"tools": true}` or `false` takes
precedence over discovered evidence; `{}` returns to discovery. This semantic
override is separate from `wireCapabilities.customTools`, namespaces and grammar.
Only the account owner can change it, using the normal account API. It cannot
make an incompatible wire represent a feature or confer grammar enforcement.

Discovery recognizes boolean tool claims, supported parameter lists, capability
objects and positive membership in capability lists. List omission remains
unknown. A manifest may declare a same-origin `capabilitiesEndpoint` for an
additive bounded metadata GET. A missing, failing or malformed optional endpoint
does not make models unsupported. Supplemental evidence cannot replace routing
identity, pricing or endpoint URLs, and an explicit primary denial wins.
Discovery retains prior explicit evidence when later metadata omits it; it never
retains an inferred negative as an explicit denial.

Schema 23 separates discovered metadata per provider account and reconciles old
provider-model false defaults only when raw evidence lacks an explicit claim.
Routing also reconciles legacy raw evidence without using model-name heuristics.
Account discovery and overrides do not leak between endpoints sharing a model ID.

Go discovery preserves the validated effort values in the existing metadata
source's `reasoning_options` entries. Missing declarations remain unknown;
no model-name heuristics or inferred effort lists are added.
