# ADR-0017 — Shift close and cash drawer reconciliation

- **Status:** Accepted
- **Date:** 2026-08-11
- **Phase:** Financial core

## Context

A drawer close must explain physical cash without trusting a browser, losing a
halala, or racing the sale/refund that changes the answer. Historical closed
shifts did not always record who closed them.

## Decision

The tenant-scoped PostgreSQL `Shift` row is the serialization boundary for every
drawer-affecting write. Sale, return, manual movement, and close take it `FOR
UPDATE` and validate tenant, branch, terminal, owner, and open status. PostgreSQL,
not a process mutex, decides race order.

The server accepts only close identity, terminal/shift identity, and declared
cash. It rejects client assertions of expected cash, variance, category totals,
closer, tenant, branch, user, or status. Current-shift reads remain blind: no
expected drawer balance is exposed before counting.

Persisted movements retain signed semantics: sale/pay-in are positive and
refund/pay-out negative. The immutable close snapshot stores positive category
magnitudes and uses exact `bigint` arithmetic:

    expected = opening float + cash sales - cash refunds + paid in - paid out
    variance = declared - expected

No rounding or clamping occurs. Physical cash is the cashier's counted,
non-negative declaration; positive variance is surplus and negative variance is
shortage.

Both operations reserve the existing `(tenantId, scope, operationId)`
idempotency key inside the same tenant transaction as the financial mutation.
The canonical semantic fingerprint detects changed intent. A matching retry
loads the original persisted movement or snapshot and does not recompute time or
money. Rollback removes the reservation with the rest of the transaction.

New closes record `closedByUserId`; it is a tenant-safe composite foreign key.
Legacy unknown closers remain `NULL`—the opener is never fabricated as closer.

## Lock order and deadlock audit

- Sale: branch (receipt number), then shift, then settings/idempotency, sale and
  inventory writes.
- Return: original-sale reads, branch (return number), then shift, then
  idempotency and return/refund/inventory writes.
- Manual movement: idempotency unique-key reservation, then shift, then movement.
- Close: idempotency unique-key reservation, then shift, then movement aggregate
  and shift snapshot.

Manual movement and close acquire neither branch nor sale locks. They therefore
cannot create a shift-to-branch or shift-to-sale reverse edge. Sale and return
retain their established order. Same-key retries may wait at the idempotency
unique index but do not hold a shift lock while waiting.

If sale/refund/movement owns the shift first, close waits and includes its
committed movement once. If close owns it first, the later operation observes
closed status and its entire transaction rolls back. Two independent closes
serialize on the shift and only one succeeds.

## Consequences

The close row is the single historical reconciliation authority and remains
explainable if movements are later archived. RLS and explicit tenant predicates
remain defense in depth. Deferred: close UI, forced manager close, safe/vault or
deposit workflow, GL posting, multi-currency, and offline synchronization.
