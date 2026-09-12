#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$KORVI_MIGRATION_TEST_LOG"
SH
chmod +x "$tmp/npm"

log="$tmp/npm-calls.log"
: > "$log"
PATH="$tmp:$PATH" \
KORVI_MIGRATION_TEST_LOG="$log" \
NODE_ENV=production \
KORVI_ENVIRONMENT=staging \
DATABASE_URL='postgresql://staging-contract.invalid/korvi' \
  bash scripts/deploy/staging-migrate.sh >/dev/null

mapfile -t calls < "$log"
expected=(
  'exec -w @korvi/database -- prisma migrate deploy'
  'exec -w @korvi/database -- prisma migrate status'
  'exec -w @korvi/database -- prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'
)

if [ "${#calls[@]}" -ne "${#expected[@]}" ]; then
  echo '[x] staging migration contract invoked an unexpected number of npm commands' >&2
  printf '    %s\n' "${calls[@]}" >&2
  exit 1
fi

for i in "${!expected[@]}"; do
  if [ "${calls[$i]}" != "${expected[$i]}" ]; then
    echo "[x] staging migration command $((i + 1)) drifted" >&2
    printf '    expected: %s\n    actual:   %s\n' "${expected[$i]}" "${calls[$i]}" >&2
    exit 1
  fi
done

assert_refused() {
  : > "$log"
  # Negative cases must be hermetic. `npm run verify` is also executed inside
  # DR/live jobs that intentionally export DATABASE_URL, so inheriting caller
  # deployment markers could turn a missing-variable refusal into a false pass.
  if env -u NODE_ENV -u KORVI_ENVIRONMENT -u DATABASE_URL \
      PATH="$tmp:$PATH" KORVI_MIGRATION_TEST_LOG="$log" "$@" \
      bash scripts/deploy/staging-migrate.sh >/dev/null 2>&1; then
    echo '[x] staging migration guard accepted an unsafe environment' >&2
    exit 1
  fi
  if [ -s "$log" ]; then
    echo '[x] staging migration guard invoked Prisma before refusing' >&2
    exit 1
  fi
}

assert_refused NODE_ENV=development KORVI_ENVIRONMENT=staging DATABASE_URL='postgresql://invalid/korvi'
assert_refused NODE_ENV=production KORVI_ENVIRONMENT=production DATABASE_URL='postgresql://invalid/korvi'
assert_refused NODE_ENV=production KORVI_ENVIRONMENT=staging

printf '[ok] staging migration contract is ordered and fail-closed\n'
