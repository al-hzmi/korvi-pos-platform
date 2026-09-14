#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/database"

if [ -z "${DATABASE_URL:-}" ]; then
  echo '[x] migration proof requires DATABASE_URL' >&2
  exit 1
fi

ephemeral_shadow_database=''
expected_manifest=''
actual_manifest=''

cleanup() {
  set +e
  if [ -n "$expected_manifest" ]; then rm -f "$expected_manifest"; fi
  if [ -n "$actual_manifest" ]; then rm -f "$actual_manifest"; fi

  if [ -n "$ephemeral_shadow_database" ]; then
    psql "$POSTGRES_ADMIN_URL" \
      --no-psqlrc \
      --set=ON_ERROR_STOP=1 \
      --set=shadow_database="$ephemeral_shadow_database" <<'SQL' >/dev/null
DROP DATABASE :"shadow_database" WITH (FORCE);
SQL
  fi
}
trap cleanup EXIT

# Production/staging promotion environments must provide an isolated shadow
# database explicitly. GitHub Actions proof jobs are allowed to provision their
# own ephemeral sibling database only when they also provide the local
# administrator connection used to create it. This keeps the strong migration-
# history drift proof mandatory without duplicating shadow setup in every CI
# workflow, while refusing any implicit database creation outside GitHub CI.
if [ -z "${SHADOW_DATABASE_URL:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" != 'true' ] || [ -z "${POSTGRES_ADMIN_URL:-}" ]; then
    echo '[x] migration proof requires a dedicated SHADOW_DATABASE_URL' >&2
    exit 1
  fi

  if ! shadow_provisioning="$(
    DATABASE_URL="$DATABASE_URL" \
    POSTGRES_ADMIN_URL="$POSTGRES_ADMIN_URL" \
    GITHUB_RUN_ID="${GITHUB_RUN_ID:-0}" \
    GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}" \
      node --input-type=module <<'NODE'
const primary = new URL(process.env.DATABASE_URL);
const admin = new URL(process.env.POSTGRES_ADMIN_URL);
const port = (url) => url.port || '5432';
const protocol = (url) => (url.protocol === 'postgres:' ? 'postgresql:' : url.protocol);

if (protocol(primary) !== 'postgresql:' || protocol(admin) !== 'postgresql:') {
  process.exit(2);
}
if (primary.hostname !== admin.hostname || port(primary) !== port(admin)) {
  process.exit(3);
}

const owner = decodeURIComponent(primary.username);
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(owner)) {
  process.exit(4);
}

const runId = String(process.env.GITHUB_RUN_ID || '0').replace(/[^0-9]/g, '') || '0';
const attempt = String(process.env.GITHUB_RUN_ATTEMPT || '1').replace(/[^0-9]/g, '') || '1';
const database = `korvi_shadow_${runId}_${attempt}`.slice(0, 63);
const shadow = new URL(primary);
shadow.pathname = `/${database}`;

process.stdout.write(`${database}\n${owner}\n${shadow.toString()}\n`);
NODE
  )"; then
    echo '[x] migration proof could not derive a safe ephemeral shadow database' >&2
    exit 1
  fi

  mapfile -t shadow_parts <<< "$shadow_provisioning"
  if [ "${#shadow_parts[@]}" -ne 3 ] || [ -z "${shadow_parts[0]}" ] || [ -z "${shadow_parts[1]}" ] || [ -z "${shadow_parts[2]}" ]; then
    echo '[x] migration proof produced invalid ephemeral shadow metadata' >&2
    exit 1
  fi

  ephemeral_shadow_database="${shadow_parts[0]}"
  shadow_owner="${shadow_parts[1]}"
  export SHADOW_DATABASE_URL="${shadow_parts[2]}"

  psql "$POSTGRES_ADMIN_URL" \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --set=shadow_database="$ephemeral_shadow_database" \
    --set=shadow_owner="$shadow_owner" <<'SQL'
CREATE DATABASE :"shadow_database" OWNER :"shadow_owner";
SQL

  printf '[ok] migration proof provisioned an isolated ephemeral GitHub Actions shadow database\n'
fi

# Replaying migration history must never target the production database. Compare
# only connection targets (host/port/database), never credentials, and refuse a
# same-database shadow even if the usernames or query parameters differ.
if ! shadow_relation="$(
  DATABASE_URL="$DATABASE_URL" SHADOW_DATABASE_URL="$SHADOW_DATABASE_URL" \
    node --input-type=module <<'NODE'
const primary = new URL(process.env.DATABASE_URL);
const shadow = new URL(process.env.SHADOW_DATABASE_URL);
const target = (url) =>
  [url.protocol, url.hostname, url.port || '5432', decodeURIComponent(url.pathname)].join('|');
process.stdout.write(target(primary) === target(shadow) ? 'same' : 'different');
NODE
)"; then
  echo '[x] migration proof could not validate shadow database isolation' >&2
  exit 1
fi
if [ "$shadow_relation" != 'different' ]; then
  echo '[x] SHADOW_DATABASE_URL must target a different database from DATABASE_URL' >&2
  exit 1
fi

migration_directories="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$migration_directories" -lt 1 ]; then
  echo '[x] migration proof found no checked-in migrations' >&2
  exit 1
fi

expected_manifest="$(mktemp)"
actual_manifest="$(mktemp)"

while IFS= read -r migration; do
  name="$(basename "$(dirname "$migration")")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  printf '%s|%s\n' "$name" "$checksum"
done < <(find prisma/migrations -mindepth 2 -maxdepth 2 -type f -name migration.sql | sort) > "$expected_manifest"

manifest_entries="$(wc -l < "$expected_manifest" | tr -d ' ')"
if [ "$manifest_entries" != "$migration_directories" ]; then
  echo "[x] every migration directory must contain exactly one migration.sql: directories=$migration_directories manifest=$manifest_entries" >&2
  exit 1
fi

npx --no-install prisma migrate deploy
npx --no-install prisma migrate status

psql_url="${DATABASE_URL%%\?*}"
ledger="$(psql "$psql_url" --no-psqlrc --tuples-only --no-align --command \
  "SELECT count(*) FILTER (WHERE \"finished_at\" IS NOT NULL AND \"rolled_back_at\" IS NULL)::text || '|' || count(*)::text FROM \"_prisma_migrations\"")"
expected_ledger="${migration_directories}|${migration_directories}"
if [ "$ledger" != "$expected_ledger" ]; then
  echo "[x] migration ledger is not an exact successful projection of source: expected=$expected_ledger actual=$ledger" >&2
  exit 1
fi

psql "$psql_url" --no-psqlrc --tuples-only --no-align --field-separator='|' --command \
  "SELECT migration_name, checksum FROM \"_prisma_migrations\" WHERE \"finished_at\" IS NOT NULL AND \"rolled_back_at\" IS NULL ORDER BY migration_name" \
  > "$actual_manifest"

if ! diff -u "$expected_manifest" "$actual_manifest"; then
  echo '[x] migration ledger names/checksums do not match checked-in migration.sql files' >&2
  exit 1
fi

# Migrations — not the reduced merchant Prisma datamodel — are the complete
# database authority. Some reviewed control-plane tables intentionally stay out
# of generated Prisma Client, so comparing the live database to schema.prisma
# would report those security boundaries as false drift. Replay the immutable
# migration history in the isolated shadow database and compare that complete
# result to the live datasource instead.
npx --no-install prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-config-datasource \
  --exit-code

printf '[ok] migration proof: %s source migrations, exact successful ledger/checksums, zero migration-history drift\n' "$migration_directories"
