# Public release policy

## Scope

This policy applies only to the Pointer server repository and its headless
YouEye-managed `standalone.tar`. The managed artifact includes the shared host React UI module and its notices.
It excludes the standalone Pointer Web server and other release products.

## Preconditions

A public release must come from Pointer's canonical public repository, with an
exact commit identity and a clean, reviewed source tree. The managed build is
network-denied and remains unsigned: signing, distribution, appliance
integration, and trust decisions are external platform responsibilities.

The repository's managed build manifest remains `youeye.build.v2` with its
current `build_kind`, validation/profile values, trust boundaries, output role,
and supported executor identity. Do not substitute a new executor identity in
source. The only requested external platform action is registration of the
existing executor as a public-neutral executor identity.

## Metadata and compatibility

The generated release manifest must name the public canonical repository and
must carry the shared latest Pointer schema version. The migration runner and
runtime readiness check enforce that same authority. Releases refuse absent or
non-canonical source identity rather than guessing from a private remote.

## Legal materials

Preserve the Pointer-owned `LICENSE`, `NOTICE.md` and tracked `third-party`
materials in the managed artifact. The shared UI includes approved fonts and
brand assets with their notices. Inspect those exact tracked notices; do not
infer rights from another YouEye repository or add new rights claims. A new
third-party asset or uncertain redistribution right requires its own review.
