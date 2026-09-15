# ADR-0028 — MySQL2 3.24.4 Patch Refresh

- **Status:** Accepted
- **Date:** 2026-09-08
- **Scope:** transitive validation dependency only; no MySQL application path, schema or financial change

## Context

ADR-0026 remediated Prisma 7.10.0's transitive `mysql2@3.15.3` by using the
root override `mysql2: 3.24.3`. Korvi itself uses PostgreSQL; MySQL2 remains
present only inside Prisma's dependency tree.

On 2026-09-08 the fail-closed production-stable version gate discovered that
`mysql2@3.24.4` had become the newest published stable patch. Retaining
3.24.3 without a new justification would violate the existing supply-chain
policy. There is no product or compatibility reason to hold the older patch.

## Decision

Advance the existing root override from `mysql2@3.24.3` to exactly
`mysql2@3.24.4`. Preserve the rest of the lock graph byte-for-semantic-byte:
obtain the 3.24.4 package metadata from a clean npm resolution, then replace
only the existing MySQL2 package lock node. A clean `npm ci` is the authority
that this bounded lock update is internally valid.

Keep `prisma`, `@prisma/client` and `@prisma/adapter-pg` aligned at 7.10.0.
Do not add MySQL application code, weaken audit/version gates, or add an
`ALLOWED_BEHIND` exception merely to retain an older MySQL2 patch.

This supersedes only ADR-0026's selected MySQL2 patch value. All other
decisions and the reason for the transitive override remain in force.

## Verification

The exact delivered commit must prove:

- the root override and every installed/locked MySQL2 copy are 3.24.4;
- no unrelated locked package version changes as part of this remediation;
- clean `npm ci`, `versions:verify` and the unchanged dependency audit pass;
- Prisma generation, build, typecheck, tests and invariant scans remain green;
- the active-branch commit passes normal CI and PostgreSQL 17 restricted-role
  live proof before deployment.

The `npm ls mysql2 --all` caveat recorded in ADR-0026 remains applicable while
Prisma retains its older exact dependency declaration. It must not be falsely
recorded as a passing diagnostic.
