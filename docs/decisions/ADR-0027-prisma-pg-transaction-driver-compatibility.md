# ADR-0027 — Prisma / pg transaction-driver compatibility gate

- **Status:** Accepted
- **Date:** 2026-09-08
- **Phase:** 5

## Context

Korvi's PostgreSQL proof on the current Stage 5 stack (`prisma`, `@prisma/client`
and `@prisma/adapter-pg` 7.10.0 with `pg` 8.23.0) emits node-postgres's
deprecation warning that `client.query()` was called while the same client was
already executing a query. Node-postgres states that this behavior is removed in
`pg` 9.

The warning was not dismissed as test noise. A dedicated PostgreSQL 17 trace run
used `NODE_OPTIONS=--trace-deprecation` while retaining the normal non-bypass
application role, all migrations, every discovered live proof and full
verification. The warning stack repeatedly entered through:

`pg Client.query -> @prisma/adapter-pg PgTransaction.performIO ->
PgTransaction.queryRaw -> Prisma query interpreter`.

No Korvi source frame appeared in the warning stack. Static review of Korvi's
transaction boundary (`withTenant` / `withoutTenant`) and the inventory,
receiving, sale and RBAC write paths also found their operations awaited
sequentially. The live concurrency tests intentionally race separate Korvi
operations; they do not issue overlapping queries on one raw `pg.Client`.

This matches the upstream Prisma report
<https://github.com/prisma/orm/issues/29407>, which describes concurrent
`PgTransaction.performIO` calls on one node-postgres client and the same pg 9
compatibility consequence. At the time of this decision that report is open and
has no released production-stable fix identified by Korvi's dependency gate.

The existing workaround reported upstream is to downgrade `pg`. Korvi does not
accept that merely to silence a warning: ADR-0009 requires exact
production-stable dependency targets unless a reviewed exception is justified,
and a downgrade would trade an observed upstream compatibility debt for an
older driver without evidence that this is the safer production posture.
Suppressing deprecation warnings would be worse because it would hide the signal
that guards a future breaking upgrade.

## Decision

**Stay on the current production-stable pg 8 line until the Prisma adapter is
proven pg-9-safe.** `pg` major 9 is an explicit compatibility gate, not a routine
dependency refresh.

The repository therefore asserts all of the following:

1. `prisma`, `@prisma/client` and `@prisma/adapter-pg` remain on one exact aligned
   version. A mixed Prisma engine/client/adapter set is not an acceptable way to
   work around the warning.
2. The direct `pg` dependency remains an exact 8.x pin while this ADR is active,
   and the lockfile must resolve the direct copy to that same version.
3. We do **not** patch `node_modules`, monkey-patch `pg`, suppress Node warnings,
   weaken transactions/RLS, serialize unrelated business requests globally, or
   downgrade the driver merely to make the warning disappear.
4. A future pg 9 upgrade must first remove or revise this ADR in the same reviewed
   change and provide evidence that the production-stable Prisma stack no longer
   performs overlapping queries on one transaction client.

This is a compatibility quarantine, not a claim that a deprecation warning is
acceptable indefinitely. The present pg 8 behavior remains covered by Korvi's
normal PostgreSQL integration and concurrency proofs; the guard prevents a
future dependency update from silently converting the known warning into a
hard runtime failure.

## Removal / upgrade conditions

The pg-8 compatibility gate may be removed only when all of these are true on
one exact candidate tree:

- a production-stable Prisma release used by Korvi contains or otherwise proves
  a fix for the transaction-client concurrency mechanism;
- `prisma`, `@prisma/client` and `@prisma/adapter-pg` are aligned;
- the candidate pg 9 version is production-stable and passes ADR-0009's normal
  version and audit gates;
- a PostgreSQL 17 trace run exercises every discovered live proof without the
  concurrent-`client.query()` warning from `PgTransaction`;
- all migrations apply with no drift under the restricted application role;
- the full Korvi verification suite, including stock, purchasing, costing,
  checkout, returns, shifts, settlement, authentication and RLS proofs, is green;
- hosted staging is rebuilt on that exact SHA and passes its health and browser
  gates before promotion.

If upstream closes the report without a fix or changes the adapter contract,
Korvi must re-evaluate the driver/ORM boundary explicitly; this ADR must not be
silently deleted to unblock an automated dependency update.

## Consequences

- A future pg major cannot enter Korvi unnoticed and turn the observed adapter
  warning into a production failure.
- Dependency freshness remains strict for the current supported major; there is
  no blanket exemption from audit or stable-version checks.
- The warning remains visible in proof output so upstream progress can be
  validated against real Korvi workloads.
- Business transaction semantics, RLS isolation, idempotency and financial data
  authority are unchanged by this decision.
