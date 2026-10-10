# Importing saved provider accounts

The operator-only `import-provider-state.js` tool moves saved Pointer account
bindings into new private OpenCodex homes without contacting a provider. It
preserves users, account UUIDs, groups, entry UUIDs and aliases, instances,
application keys and usage history. Provider definitions and model records are
copied into owner-specific scopes; historical catalog records remain intact.

First stop every Pointer writer, retain a paired database/configuration/engine
backup, and rehearse against a restored database. Apply the normal schema
migrations before importing. Never start a restored OAuth grant in parallel
with its original engine: token refresh must have one owner.

Pass `DATABASE_URL` and `ENCRYPTION_SECRET` through the existing protected
operator environment. Set `POINTER_ENGINE_STATE_DIR` to a private persistent
directory with no existing homes for the selected owners. Supply an explicit
JSON plan containing the exact database and each account's existing `id`,
`owner`, engine `provider`, `adapter` and `baseUrl`. `authMode` may specify
`key`, `forward` or `oauth`; key-auth accounts use their saved encrypted key.
The plan contains no credentials. For example:

```json
{
  "database": "pointer",
  "accounts": [{
    "id": "existing-account-id",
    "owner": "existing-user-id",
    "provider": "openai",
    "adapter": "openai-responses",
    "authMode": "forward",
    "baseUrl": "https://chatgpt.com/backend-api/codex"
  }]
}
```

Run `./bun import-provider-state.js --plan plan.json` to preflight without
writing, then use `--apply-stopped` after stopping all writers. That flag records
the operator's maintenance boundary; it cannot stop or inspect another host's
services. The tool rejects mismatched databases/owners, duplicate bindings,
unsupported OAuth grants and existing target homes. Codex imports use the
pinned upstream credential-store writer and remain validation-pending until
real inference succeeds. No operator CLI authentication is imported.

If application fails, leave services stopped and restore the paired backup
before retrying. Database commits and filesystem writes do not form one atomic
transaction. Do not delete a partly written home and rerun against an uncertain
database. Reverting executable code alone is insufficient after a schema or
account-state migration. Any refresh grant changed during live acceptance must
be reconciled with the rollback account state before restarting the old writer.

After startup, discover each imported provider's catalog, verify the retained
public model names and application key, then test inference and conversation
continuation through the real host integration. A cold import proves state
preservation, not provider availability.
