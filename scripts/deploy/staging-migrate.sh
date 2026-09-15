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

# Run through the pinned workspace Prisma CLI. Never echo DATABASE_URL.
npm exec -w @korvi/database -- prisma migrate deploy
npm exec -w @korvi/database -- prisma migrate status
npm exec -w @korvi/database -- prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

printf '[ok] staging migrations deployed; ledger and schema are current\n'
