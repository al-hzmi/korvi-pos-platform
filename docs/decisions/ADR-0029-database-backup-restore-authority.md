# ADR-0029 — Database backup and restore authority boundary

- **Status:** Accepted
- **Date:** 2026-09-08
- **Phase:** Production operations foundation

## Context

Korvi deliberately runs merchant data through a restricted PostgreSQL role with
FORCE RLS. That role is the correct application authority precisely because it
cannot read another tenant merely to make an operational task convenient. A
complete installation backup, however, must preserve every tenant, the global
permission catalogue, migration ledger, RLS policies and append-only financial
and audit history.

Making the runtime role capable of reading every tenant for backup purposes would
collapse the security boundary that ADR-0004 and the restricted-role PostgreSQL
gate are designed to prove. Running backups from the web/API process would also
place recovery authority and long-lived backup material inside the attack surface
of the merchant application.

The current free Render staging database is explicitly disposable, expires and
has no managed-backup guarantee. It therefore cannot be used as evidence that a
future production database meets disaster-recovery requirements.

## Decision

Backup/restore authority is an **operations-plane capability separate from the
Korvi runtime role**.

1. The API/web runtime keeps a non-superuser, non-BYPASSRLS application role.
   It does not receive backup credentials and does not perform installation-wide
   dumps.
2. Production uses either provider-managed physical/snapshot backups or a
   dedicated operations identity whose credential is unavailable to the
   application runtime. The chosen production topology must document why that
   identity can capture all tenant data without weakening runtime RLS.
3. Backup material is treated as sensitive customer data: encrypted in transit
   and at rest, access-controlled, retained under an explicit policy and never
   attached to public CI artifacts.
4. Restore is performed into an isolated target first. A restore is not accepted
   because `pg_restore` exits zero; Korvi must prove the migration ledger,
   schema drift status, restricted runtime role, RLS behavior and representative
   application-owned data through the restored database.
5. Migration rollback is not a disaster-recovery mechanism. If a deployed
   schema makes an older binary incompatible, preserve the database and use a
   reviewed forward fix unless a separately reviewed restore procedure is
   explicitly invoked.
6. Production RPO/RTO are release inputs, not guesses in source control. Before
   commercial launch the selected provider/topology must publish a backup
   frequency/retention policy, Korvi must set target RPO/RTO against it, and a
   measured rehearsal must demonstrate that the target is achievable.

## CI rehearsal boundary

Korvi keeps an automated PostgreSQL 17 disaster-recovery rehearsal as engineering
proof. It creates an ephemeral source database, migrates it with the same
restricted ownership model, creates a synthetic tenant through Korvi's existing
control-plane authorities, captures a logical backup using an ephemeral CI
operations authority, restores into a fresh database owned by a second
restricted application role, and re-runs schema/application verification.

The ephemeral PostgreSQL service's administrator is used only as the simulated
operations-plane backup authority. That is not permission for a production API
process to hold superuser credentials.

The rehearsal proves that the repository can produce and consume a coherent
logical backup. It does **not** by itself close the Production Operations gate:
production-equivalent backup retention, observability/incident response and a
controlled merchant field rollout remain separate evidence.

## Consequences

- Runtime tenant isolation is not traded away for operational convenience.
- A backup that cannot be restored through Korvi's real schema and application
  checks is treated as unproven.
- Backup archives are never required to leave the CI job as artifacts; only the
  proof log and cryptographic digest are retained.
- The free staging database remains synthetic and disposable rather than being
  promoted into a false production DR environment.
