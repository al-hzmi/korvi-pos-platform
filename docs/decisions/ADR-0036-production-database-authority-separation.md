# ADR-0036 — Production Database Migration and Runtime Authority Separation

Status: **Accepted**

Date: 2026-09-14

## Context

Korvi's application runtime is intentionally constrained by PostgreSQL row-level
security and server-derived tenant context. The staging and early CI topology
used a single restricted application role to own tables, apply migrations and
serve application traffic. That model was useful for proving FORCE RLS under a
non-bypass owner, but it is not the production authority boundary.

A production POS/ERP must not allow a compromised API process to create schema,
rewrite the migration ledger, or inherit deployment authority merely because it
needs ordinary merchant data-plane access. Conversely, migrations need enough
authority to create and alter the checked-in schema without receiving provider
administrator, backup or cross-system control privileges.

ADR-0029 already separates backup/restore authority from the merchant runtime.
This decision completes the adjacent schema-deployment boundary without
weakening the RLS, migration-lineage or operations requirements established by
ADRs 0004 and 0029.

## Decision

Production uses three distinct database authority classes.

### 1. Provider/provisioning authority

The provider administrator is used only to establish the database and dedicated
roles, or for separately authorized provider operations. It is not an
application credential and is not the normal migration credential.

### 2. Restricted migration authority

A dedicated migration identity owns the production database/schema objects and
executes forward-only Korvi migrations. It must be a login role with:

- `NOSUPERUSER`;
- `NOBYPASSRLS`;
- `NOCREATEDB`;
- `NOCREATEROLE`;
- `NOINHERIT`;
- `NOREPLICATION`;
- no inherited role memberships.

Its credential exists only in the isolated deployment/operations plane. The API
configuration does not accept or expose it.

Before runtime grants are refreshed, the deployment path must execute the shared
source-driven migration proof: every checked-in migration name and SHA-256 must
match the successful Prisma ledger, all migrations must be complete, and schema
diff must be zero. Literal historical migration counts are forbidden.

### 3. Restricted non-owner runtime authority

The API uses a separate runtime identity with the same safe role attributes and
no role memberships. It owns no public application table and receives only the
data-plane privileges required by the application:

- database `CONNECT`;
- schema `USAGE`;
- application-table `SELECT`, `INSERT`, `UPDATE`, `DELETE`;
- required sequence usage/read;
- required function execution.

The runtime does **not** receive:

- database `TEMPORARY`;
- schema `CREATE`;
- table ownership;
- role administration;
- backup authority;
- migration-ledger mutation authority.

It may read `_prisma_migrations` because production boot preflight independently
verifies exact migration lineage before opening the API listener, but it cannot
insert, update, delete, truncate, reference or trigger that ledger.

PostgreSQL privileges inherited through `PUBLIC` count as real authority. The
production migration path therefore revokes database `TEMPORARY` and public
schema `CREATE` from `PUBLIC` before asserting the runtime boundary; revoking a
privilege only from the named runtime role is not accepted if `PUBLIC` still
re-grants it effectively.

Default privileges are configured by the migration owner so future forward-only
migrations continue granting the runtime necessary data-plane access without
transferring ownership or schema authority.

## Executable proof

`scripts/deploy/production-migrate.sh` is the guarded production migration
entrypoint. It refuses non-production markers, missing migration/runtime
configuration, identical identities, unsafe role flags or memberships, migration
ledger/schema drift, runtime table ownership, or an effective privilege boundary
outside this ADR.

`.github/workflows/strike-5c-postgres-live.yml` reproduces the topology on real
PostgreSQL 17: a provider administrator creates separate restricted migrator and
runtime identities, the migrator owns/applies the schema, then every live
application proof and the full repository verification execute as the non-owner
runtime identity.

`scripts/check-production-migration-contract.mjs`, wired into the invariant scan,
prevents future changes from silently collapsing the authority split or putting
migration-plane configuration into the API runtime.

## Boundaries

This ADR does not close Production Operations Gate 50. It proves the repository
and PostgreSQL authority model, not the selected production provider's HA,
backup retention, failover, measured RPO/RTO, secret manager, alert/on-call or
merchant field evidence.

It also does not replace ADR-0029. Backup/restore authority remains a separate
operations-plane capability and must never be added to either the migration or
runtime identity for convenience.

Staging may retain its documented disposable migration adaptation. Staging
success is not production-provider evidence.

## Consequences

- Compromise of the merchant API no longer implies schema ownership or migration
  ledger write authority.
- Migration execution no longer requires giving the deploy path provider
  superuser/bypass authority.
- Runtime RLS remains effective under a non-owner, non-bypass role.
- Future migrations must remain compatible with the explicit default-privilege
  contract or fail the live PostgreSQL gate.
- Provider provisioning, migrations, runtime data access and backup/restore are
  separate security domains rather than one credential with accumulated power.
