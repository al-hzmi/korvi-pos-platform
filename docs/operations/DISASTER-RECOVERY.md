# Disaster recovery and restore verification

Status: **production-operations foundation; not a production SLA or launch approval**.

Authority: ADR-0029, ADR-0004, ADR-0009 and the current migration/RLS gates.

## Purpose

A database backup is useful only if Korvi can restore it without weakening tenant
isolation, losing migration history or silently changing financial/audit facts.
This runbook defines the minimum evidence required before a backup/restore path
may be described as operational.

The current free staging database is synthetic and disposable. It has no managed
backup guarantee and is not the production DR topology.

## Authority separation

- The web and API runtime use only the restricted Korvi application role.
- Runtime credentials must never be reused as installation-wide backup authority.
- Provider snapshot/backup credentials or a dedicated operations identity stay
  outside the application environment.
- Backup archives contain customer data and receive the same confidentiality
  treatment as the live database. Do not attach them to public CI artifacts.
- A restore target starts isolated from customer traffic. Do not point API/web
  services at it until verification completes.

## Required production record before launch

Record, for the selected production database plan:

1. provider, region, PostgreSQL major and HA/failover topology;
2. backup mechanism, frequency, retention and encryption guarantees;
3. who/what can request, read, delete and restore backups;
4. target RPO and RTO, with the business owner accepting those targets;
5. measured restore duration and the backup timestamp used for the rehearsal;
6. restore verification result, exact application SHA and migration ledger;
7. alerting/incident escalation owner and communication path;
8. the controlled merchant field-validation cohort and rollback/stop criteria.

If any item is unknown, Production Operations gate #50 remains open.

## Restore acceptance sequence

A restore is accepted only when every step below succeeds against an isolated
recovery database.

1. Verify PostgreSQL major and recovery-source identity. Never restore a backup
   whose origin or timestamp is ambiguous.
2. Verify the logical backup/restore tool major before capture. Korvi does not
   rely on an ambient workstation or CI-runner `pg_dump`: the selected client
   must be explicitly compatible with the source server, and the automated
   PostgreSQL 17 rehearsal requires PostgreSQL 17 `pg_dump` and `pg_restore`.
3. Create the target runtime role with
   `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`.
   No application test is allowed to run as the backup/restore operator.
4. Restore the backup without importing provider/admin credentials or ACLs into
   the application role. Ownership of the restored Korvi schema must resolve to
   the intended restricted runtime/migration identity for that topology.
5. Verify the complete `_prisma_migrations` ledger. Failed, rolled-back or
   unexpected migration entries are a stop condition.
6. Run `prisma migrate status` and the schema diff gate. Any drift is a stop
   condition; do not use `db push` to make the restore match source code.
7. Verify ENABLE/FORCE RLS and policy behavior through the normal restricted-role
   live suite. Never disable RLS for restore verification.
8. Verify representative restored data through Korvi's own tenant-scoped
   application authority. Administrative SQL row counts alone are not sufficient.
9. Run the full repository verification against the restored database.
10. Record the exact application SHA, database backup digest, elapsed restore
    time and all gate results. Preserve proof logs; do not preserve the database
    dump in a public artifact.
11. Only after these gates pass may a recovery decision point customer traffic
    at the restored target. DNS/service promotion remains an explicit operator
    act.

## Automated PostgreSQL 17 rehearsal

`.github/workflows/operations-dr-postgres.yml` exercises the repository-level DR
path with disposable databases. It intentionally uses two different restricted
application roles:

- source role owns a freshly migrated source database;
- restore role owns the restored database.

A synthetic active tenant is created through `provisionPermissionCatalogue`,
`provisionTenant` and `activateTenant`, not by direct tenant SQL. The captured
evidence includes tenant settings, default roles/permissions, lifecycle
idempotency evidence and audit events. After restore, the same application-level
read is deep-compared to the pre-backup evidence, then migration drift and the
full verification suite run against the restored database.

The workflow executes `pg_dump` and `pg_restore` from an explicit PostgreSQL 17
container and records both client versions. This is deliberate: the CI runner's
ambient PostgreSQL client is not a dependency of the recovery procedure, and an
older `pg_dump` must not be allowed to fail only when the production server has
already moved to a newer major.

The workflow's PostgreSQL administrator exists only inside the ephemeral GitHub
Actions service and represents the operations plane. The generated dump is
deleted before artifact upload; only the proof log is retained.

## Incident rules

- Preserve evidence first: deployment SHA, database provider event timeline,
  migration state, health/log excerpts and the time of the last known-good write.
- Stop destructive automation while the state is ambiguous. Do not reset an
  occupied database, edit migration ledger rows or delete idempotency/audit facts.
- Prefer a reviewed forward application/schema fix when data is intact.
- Restore only from an identified backup into an isolated target, then execute
  the full acceptance sequence above.
- A successful process exit, health endpoint or provider dashboard alone is not
  recovery proof.

## What this does not close

This runbook and CI rehearsal are prerequisites for scorecard gate #50. They do
not close it. Production-equivalent backup retention, measured RPO/RTO,
observability/incident evidence and controlled merchant field validation must all
exist before that gate can move from OPEN to CLOSED.
