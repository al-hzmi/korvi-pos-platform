#!/usr/bin/env bash
#
# The gate. Everything that must be true before a push.

set -euo pipefail

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

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

step "Tests"
npm run --silent test

printf '\n\033[1;32m[ok]\033[0m verify passed\n'
