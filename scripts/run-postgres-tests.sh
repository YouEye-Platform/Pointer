#!/usr/bin/env bash
set -euo pipefail

temporary_database=false
database_name=""

cleanup() {
  if [[ ${temporary_database} == true ]]; then
    [[ ${database_name} =~ ^pointer_monorepo_test_[0-9]+$ ]] || {
      echo "refusing to clean an unexpected PostgreSQL database name" >&2
      return 1
    }
    dropdb --if-exists "${database_name}"
  fi
}
trap cleanup EXIT

if [[ -z ${DATABASE_URL:-} ]]; then
  command -v createdb >/dev/null
  command -v dropdb >/dev/null
  database_name="pointer_monorepo_test_${BASHPID}"
  createdb "${database_name}"
  temporary_database=true
  export DATABASE_URL="postgresql:///${database_name}?host=/var/run/postgresql"
else
  database_name=$(node -e '
    const parsed = new URL(process.env.DATABASE_URL);
    const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!name || name.includes("/")) process.exit(1);
    process.stdout.write(name);
  ')
fi

[[ ${database_name} =~ (^|[_-])test([_-]|$) ]] || {
  echo "refusing PostgreSQL tests against a non-test database" >&2
  exit 78
}

export CATALOG_POSTGRES_TEST_DATABASE="${CATALOG_POSTGRES_TEST_DATABASE:-${database_name}}"
export MANAGED_POSTGRES_TEST_DATABASE="${MANAGED_POSTGRES_TEST_DATABASE:-${database_name}}"
export IDENTITY_TRANSITION_TEST_DATABASE="${IDENTITY_TRANSITION_TEST_DATABASE:-${database_name}}"
export JWT_SECRET="${JWT_SECRET:-postgres-test-jwt-secret}"
export ENCRYPTION_SECRET="${ENCRYPTION_SECRET:-postgres-test-encryption-secret}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://127.0.0.1:3200}"

pnpm --filter @pointer/server exec bun run scripts/migrate.ts \
  --expect-database "${database_name}"
pnpm --filter @pointer/server test:postgres
