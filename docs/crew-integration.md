# Crew integration contract

Crew deploys Pointer from the case-sensitive `Crew` branch. The branch contains
integration changes that have passed Crew's managed-runtime acceptance but have
not yet been promoted to Pointer `main`.

Pointer is the sole semantic owner of provider responses. It validates and
normalizes the provider protocol, emits the public protocol response, assigns
the Pointer request ID and records usage. Crew makes one request, relays the
returned status and stream, and records route evidence after delivery. Crew must
not reinterpret successful model output or retry a request based on response
content. In particular, a Responses result can validly contain a custom tool
call without text or reasoning output.

Changes on this branch must keep Pointer's normal public-source, type, contract,
deployment, build and unit gates green. Managed deployment uses an artifact from
an exact pushed commit and retains the previous release for rollback.

A future Iris workflow will promote accepted `Crew` changes into Pointer
`main`. It must fetch both Forgejo refs, verify ancestry, show the exact commit
range, run the full Pointer gates and merge without force-pushing. Deployment of
the `Crew` branch does not itself authorize or imply that merge.
