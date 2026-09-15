#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "${KORVI_ENVIRONMENT:-}" != staging ] || [ "${NODE_ENV:-}" != production ]; then
  echo 'Refusing staging migration outside KORVI_ENVIRONMENT=staging and NODE_ENV=production.' >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo 'Refusing staging migration without DATABASE_URL.' >&2
  exit 1
fi

# A staging provider that supplies a dedicated shadow database gets the exact
# same source-ledger/checksum and migration-history drift proof as production.
# Render's free staging database currently cannot provide a second isolated
# database, so that environment performs the forward deploy + Prisma migration
# ledger/status check here. The mandatory exact migration-history drift proof is
# still enforced independently by the PostgreSQL release workflow on the same
# commit before release promotion.
if [ -n "${SHADOW_DATABASE_URL:-}" ]; then
  bash scripts/prove-migration-state.sh
  printf '[ok] staging migrations deployed with exact migration-history proof\n'
  exit 0
fi

# Run through the pinned workspace Prisma CLI. Never echo DATABASE_URL.
npm exec -w @korvi/database -- prisma migrate deploy
npm exec -w @korvi/database -- prisma migrate status

# Do not compare this database to schema.prisma: the generated merchant Prisma
# datamodel intentionally omits reviewed raw control-plane tables such as
# platform_support_notes. That comparison would ask Prisma to delete valid
# security-boundary objects and report a false drift. Migrations are the full DB
# authority; the dedicated release proof replays them into an isolated shadow.
printf '[ok] staging migrations deployed; Prisma migration ledger/status are current (exact drift proof is a separate mandatory release gate)\n'
