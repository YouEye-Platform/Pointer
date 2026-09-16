# Public release policy

## Scope

This policy applies only to the Pointer server repository and its headless
YouEye-managed `standalone.tar`. It does not authorize, package, or publish
Pointer Web or any other release product.

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

This repository does not currently establish a Pointer product license,
copyright owner, or trademark policy. Do not infer those terms from another
YouEye repository. The tracked icon notice under
`apps/web/public/icons/brands/NOTICE.txt` applies only to that optional Web
asset set and is not added to the headless server package.

Adding `LICENSE`, `TRADEMARK.md`, and `THIRD_PARTY_NOTICES.txt` to the managed
standalone package requires a rights-holder decision and approved Pointer-owned
files. Do not add a new rights claim, third-party asset, or broad approval
without that review.
