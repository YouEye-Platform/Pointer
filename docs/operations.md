# Operations and rollback

## Service topology

```bash
systemctl status pointer-server pointer-web pointer-router
journalctl -u pointer-server -u pointer-web -u pointer-router --since today
```

Healthy full-profile operation has server and web listening only on loopback,
the router listening on port 8080, and PostgreSQL inaccessible from the public
network. `/readyz` is the server's dependency-aware gate; the web health path
proves its own process independently.

The server listener keeps a 60-second Bun idle timeout for ordinary requests.
Validated `/v1` requests with `stream: true` and Google
`/v1beta/models/*:streamGenerateContent` requests disable that timeout per
request; do not replace this with an unlimited global listener timeout. Both
the same-origin router and any external reverse proxy must forward `/v1` and
`/v1beta`, keep response buffering off, and use read/send timeouts long enough
for inference streams. Pointer does not require proxy-generated or
application-generated SSE heartbeats.

## Release layout

```text
/opt/pointer/
  releases/<commit>/
    server/
    web/
  current -> releases/<commit>
  previous -> releases/<prior-commit>
```

Never edit a retained release. Build a new artifact and switch symlinks. The
artifact manifest and health endpoints must agree on commit identity.

An owner-authorized emergency source overlay is a temporary exception, not a
release. Record the exact tested source commit, file hashes, pre-overlay backup,
restart boundary and live acceptance in `docs/deployments/`. Do not change the
immutable release label to imply that the overlay was built or promoted. A
normal immutable release should supersede the overlay when scheduled.

The active Responses-heartbeat overlay and its rollback evidence are recorded
in `docs/deployments/README.md`.

## Backups

Before schema or credential-affecting work:

1. create a timestamped PostgreSQL custom-format backup as the database owner;
2. restrict it to mode 600;
3. create and verify its SHA-256 sidecar;
4. restore it into a separate database;
5. run health, schema and credential-decryption checks against that restored
   database without starting background jobs.

Do not print the database URL, encryption secret, provider ciphertext or
decrypted credential during validation.

## Upgrade

1. Verify local tests and artifact checksums.
2. Back up and restore-test the database.
3. Extract the new release without changing `current`.
4. Start it on alternate server, web and router ports with background jobs
   disabled and an isolated restored database.
5. Run same-origin and authenticated acceptance.
6. Stop the canary.
7. Apply any migration once, switch `previous` and `current`, restart services.
8. Change the external proxy only after local full-profile acceptance.
9. Run public E2E and retain the prior release/LXC during the acceptance window.

## Rollback

If no schema changed, repoint `current` to `previous`, reload systemd and
restart the three services. If a migration is not backward compatible, stop
writers before restoring the verified pre-deploy database backup. The legacy
web LXC may remain a temporary front-end rollback target, but never run two
background-enabled server releases against the same database.

After rollback, verify health, readiness, login, catalog counts, provider
connection state and an inference request. Record source commit, deployed
commit, database action and remaining risk separately.
