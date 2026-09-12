#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/database"

if [ -z "${DATABASE_URL:-}" ]; then
  echo '[x] migration proof requires DATABASE_URL' >&2
  exit 1
fi

migration_directories="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$migration_directories" -lt 1 ]; then
  echo '[x] migration proof found no checked-in migrations' >&2
  exit 1
fi

expected_manifest="$(mktemp)"
actual_manifest="$(mktemp)"
trap 'rm -f "$expected_manifest" "$actual_manifest"' EXIT

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

npx --no-install prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

printf '[ok] migration proof: %s source migrations, exact successful ledger/checksums, zero schema drift\n' "$migration_directories"
