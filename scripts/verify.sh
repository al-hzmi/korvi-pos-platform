#!/usr/bin/env bash
#
# The gate. Everything that must be true before a push.

set -euo pipefail

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

step "Package manager"
node scripts/verify-package-manager.mjs

step "Dependency pins"
node scripts/verify-versions.mjs

step "Dependency advisories"
bash scripts/audit.sh

step "Formatting"
npm run --silent format:check

step "Lint"
npm run --silent lint

step "Invariants"
bash scripts/check-invariants.sh

step "Prisma client"
# `prisma generate` reads the schema and never opens a connection, but the
# config resolves DATABASE_URL strictly so that `prisma migrate` cannot quietly
# run against a default. A throwaway localhost value satisfies generate without
# putting a credential anywhere; migrate still demands the real one.
DATABASE_URL="${DATABASE_URL:-postgresql://korvi:korvi@localhost:5432/korvi_pos?schema=public}" \
  npm run --silent db:generate

# Build first: packages resolve each other through their published `exports`,
# which point at dist. Typechecking before a build would report every
# cross-package import as a missing module.
step "Build"
npm run --silent build

step "Typecheck"
npm run --silent typecheck

# Separately, because every workspace excludes its tests from the build: a test
# that imports a name its package does not export must fail the gate, not the
# reviewer.
step "Typecheck (tests)"
npm run --silent typecheck:tests

# Scratch Gate 39 runs the normal test command with live-test URLs intentionally
# present. The scratch workflow's independent PostgreSQL proof creates the
# restricted application role later, so the live suites would otherwise fail
# authentication before testing any product behavior. Bootstrap the disposable
# CI database here only when both test URLs are explicitly supplied by Actions,
# then remove every object/privilege owned by the role after a green test run so
# the workflow's subsequent proof still starts from a clean database.
scratch_live_db_bootstrapped=0
if [[ "${CI:-}" == "true" && -n "${KORVI_TEST_DATABASE_URL:-}" && -n "${KORVI_TEST_ADMIN_DATABASE_URL:-}" ]]; then
  step "Scratch live-test database bootstrap"
  psql "$KORVI_TEST_ADMIN_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 <<'SQL'
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'korvi_app') THEN
    CREATE ROLE korvi_app LOGIN PASSWORD 'korvi_gate39_ci'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$do$;
SELECT format(
  'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO korvi_app',
  current_database()
) \gexec
GRANT USAGE, CREATE ON SCHEMA public TO korvi_app;
SQL

  flags="$(psql "$KORVI_TEST_ADMIN_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='korvi_app'")"
  test "$flags" = 'f|f|f|f|f|f'

  DATABASE_URL="$KORVI_TEST_DATABASE_URL" npm exec -w @korvi/database -- prisma migrate deploy
  scratch_live_db_bootstrapped=1
fi

step "Tests"
npm run --silent test

if [[ "$scratch_live_db_bootstrapped" -eq 1 ]]; then
  step "Scratch live-test database cleanup"
  psql "$KORVI_TEST_ADMIN_DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 <<'SQL'
DROP OWNED BY korvi_app CASCADE;
DROP ROLE korvi_app;
SQL
fi

printf '\n\033[1;32m[ok]\033[0m verify passed\n'
