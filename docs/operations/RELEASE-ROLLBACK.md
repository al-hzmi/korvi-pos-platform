# Korvi Release and Rollback Procedure

Status: **ACTIVE ENGINEERING RUNBOOK**

## Forward release

1. Name the exact candidate SHA.
2. Require CI and PostgreSQL live verification on that lineage.
3. For cashier-impacting changes, require actual browser/device proof as applicable.
4. Apply production migrations through `scripts/deploy/production-migrate.sh` using the migration-only identity.
5. Verify zero migration/schema drift.
6. Deploy API and Web from the same SHA.
7. Verify `/health`, `/ready`, protected `/metrics` and representative business smoke tests.
8. Record operator approval before traffic promotion.

## Code rollback

Rollback is allowed only when:

- the target SHA is known-good;
- current database schema remains compatible with it;
- no rollback would reinterpret committed financial, stock, audit or ZATCA truth;
- API and Web are rolled to the same compatible lineage.

Never edit, delete or mark Prisma migration rows successful to force compatibility.

## Database recovery

Database restore is not an ordinary code rollback.

Use `docs/operations/DISASTER-RECOVERY.md`:

1. identify the exact backup and timestamp;
2. restore into an isolated target;
3. verify migration ledger and schema drift;
4. prove RLS and restricted runtime behavior;
5. run application-level verification;
6. record measured restore duration and recovery point;
7. promote only after explicit operator approval.

## Stop conditions

Abort release/rollback when any of the following is true:

- candidate or rollback SHA is ambiguous;
- Web/API SHAs differ unexpectedly;
- migration status/drift is not exact;
- runtime role has elevated database authority;
- restore origin/timestamp is unknown;
- RLS/permission/idempotency would be weakened;
- a ZATCA external outcome is ambiguous and the proposed action would fabricate acceptance;
- a merchant transaction is ambiguous and authoritative state has not been reconciled.

Forward fix is preferred when data is intact and a schema migration has already been committed.
