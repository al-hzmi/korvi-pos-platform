#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  printf '[x] production migration refused: %s\n' "$1" >&2
  exit 1
}

[ "${NODE_ENV:-}" = 'production' ] || fail 'NODE_ENV must equal production'
[ "${KORVI_ENVIRONMENT:-}" = 'production' ] || fail 'KORVI_ENVIRONMENT must equal production'
[ -n "${MIGRATION_DATABASE_URL:-}" ] || fail 'MIGRATION_DATABASE_URL is required'
[ -n "${PRODUCTION_RUNTIME_DB_ROLE:-}" ] || fail 'PRODUCTION_RUNTIME_DB_ROLE is required'

runtime_role="$PRODUCTION_RUNTIME_DB_ROLE"
if [[ ! "$runtime_role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  fail 'PRODUCTION_RUNTIME_DB_ROLE must be a canonical PostgreSQL identifier'
fi

# Prisma accepts a few client-only URL parameters that libpq/psql does not.
# Remove only those parameters; never strip the entire query string because it
# can carry transport-security controls such as sslmode, sslrootcert and
# channel_binding. The helper never logs the credential on parse failures.
if ! psql_url="$(
  MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
    node scripts/deploy/derive-psql-url.mjs
)"; then
  fail 'MIGRATION_DATABASE_URL is not a valid psql-compatible PostgreSQL URL'
fi

migration_user="$({
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command 'SELECT current_user'
})"
[ -n "$migration_user" ] || fail 'could not resolve migration authority'
[ "$migration_user" != "$runtime_role" ] || fail 'migration and runtime identities must be different roles'

migration_facts="$({
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command \
    "SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
            r.rolreplication, r.rolbypassrls,
            (SELECT count(*)::integer FROM pg_auth_members WHERE member = r.oid)
       FROM pg_roles r
      WHERE r.rolname = current_user"
})"
[ "$migration_facts" = 'f|f|f|f|f|f|0' ] || \
  fail 'migration role must be a dedicated non-superuser, non-bypass operations identity'

# psql does not perform :variable interpolation inside --command/-c arguments.
# Feed SQL through stdin whenever a value is supplied with --set so quoting and
# identifier handling remain psql-owned instead of being interpolated by bash.
runtime_facts="$(
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set=runtime_role="$runtime_role" <<'SQL'
SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
       r.rolreplication, r.rolbypassrls,
       (SELECT count(*)::integer FROM pg_auth_members WHERE member = r.oid)
  FROM pg_roles r
 WHERE r.rolname = :'runtime_role';
SQL
)"
[ "$runtime_facts" = 'f|f|f|f|f|f|0' ] || \
  fail 'runtime role is missing or has unsafe role attributes/memberships'

# Migration authority exists only in this isolated operations process. The API
# runtime never receives this credential. The shared proof applies the immutable
# migration lineage and proves exact ledger checksums plus zero schema drift.
(
  export DATABASE_URL="$MIGRATION_DATABASE_URL"
  bash scripts/prove-migration-state.sh
)

database_name="$({
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command 'SELECT current_database()'
})"
[ -n "$database_name" ] || fail 'could not resolve production database name'

# Prisma migrations are owned by the migration authority. Runtime receives only
# the data-plane privileges required by the application, never schema CREATE,
# table ownership, migration-ledger writes, role administration or backup power.
# Remove PostgreSQL's broad defaults first so PUBLIC cannot re-grant an authority
# that was explicitly revoked from the runtime role.
psql "$psql_url" \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --set=runtime_role="$runtime_role" \
  --set=database_name="$database_name" <<'SQL'
REVOKE TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role";
REVOKE TEMPORARY ON DATABASE :"database_name" FROM :"runtime_role";

GRANT USAGE ON SCHEMA public TO :"runtime_role";
REVOKE CREATE ON SCHEMA public FROM :"runtime_role";

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"runtime_role";

-- Prisma's ledger is deployment authority, not application data authority.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public._prisma_migrations FROM :"runtime_role";
GRANT SELECT ON TABLE public._prisma_migrations TO :"runtime_role";

-- These defaults are scoped to objects subsequently created by this migration
-- owner, keeping future forward-only migrations from silently starving runtime.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"runtime_role";
SQL

runtime_ownership="$(
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set=runtime_role="$runtime_role" <<'SQL'
SELECT count(*)
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tableowner = :'runtime_role';
SQL
)"
[ "$runtime_ownership" = '0' ] || fail 'runtime role must not own public tables'

runtime_boundary="$(
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set=runtime_role="$runtime_role" \
    --set=database_name="$database_name" <<'SQL'
SELECT has_database_privilege(:'runtime_role', :'database_name', 'CONNECT'),
       has_database_privilege(:'runtime_role', :'database_name', 'TEMPORARY'),
       has_schema_privilege(:'runtime_role', 'public', 'USAGE'),
       has_schema_privilege(:'runtime_role', 'public', 'CREATE'),
       has_table_privilege(:'runtime_role', 'public._prisma_migrations', 'SELECT'),
       has_table_privilege(:'runtime_role', 'public._prisma_migrations', 'INSERT'),
       has_table_privilege(:'runtime_role', 'public._prisma_migrations', 'UPDATE'),
       has_table_privilege(:'runtime_role', 'public._prisma_migrations', 'DELETE');
SQL
)"
[ "$runtime_boundary" = 't|f|t|f|t|f|f|f' ] || \
  fail 'runtime database authority does not match the production least-privilege contract'

missing_dml="$(
  psql "$psql_url" \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --set=runtime_role="$runtime_role" <<'SQL'
SELECT count(*)
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename <> '_prisma_migrations'
   AND NOT (
     has_table_privilege(:'runtime_role', format('%I.%I', schemaname, tablename), 'SELECT')
     AND has_table_privilege(:'runtime_role', format('%I.%I', schemaname, tablename), 'INSERT')
     AND has_table_privilege(:'runtime_role', format('%I.%I', schemaname, tablename), 'UPDATE')
     AND has_table_privilege(:'runtime_role', format('%I.%I', schemaname, tablename), 'DELETE')
   );
SQL
)"
[ "$missing_dml" = '0' ] || fail 'runtime role is missing required application-table DML privileges'

printf '[ok] production database authority: exact migrations, restricted migrator, separate non-owner runtime, read-only migration ledger\n'
