# ADR-0013 — The checkout transaction, receipt numbering and idempotency

Status: accepted
Date: 2026-08-12
Extends ADR-0002 (money), ADR-0003 (identifiers), ADR-0004 (multi-tenancy).

## Context

A checkout is the one operation in a POS where a partial write is a financial
error rather than a bug. Three questions had to be answered before a till could
be built on top of it.

## Decision 1 — One transaction, and the client is not in it

`SaleRepository.record` already committed the sale, its lines, its tenders, the
invoice and its tax breakdown, the stock movements, the drawer movement and the
idempotency reservation together. The checkout pipeline adds nothing outside
that boundary except the audit line, which is written afterwards and whose
failure is logged rather than raised — by then the money has moved and the
customer has the goods.

Everything the sale states is computed on the server: unit price and VAT rate
are read from `products`, the price mode and the overselling policy from
`tenant_settings`, the seller's tax identity from `tenants`, the branch and
shift from the open shift on the terminal, and the cashier from the session.
The request carries product ids, scaled quantities, a terminal, an operation id
and the cash that was handed over. Naming any of the other fields is a 400 with
the offending name, not a silent drop: a client that believes it set the price
should be told it cannot, rather than leaving an auditor to find out.

## Decision 2 — The receipt number is allocated under the branch row lock

`sale.sequence` and `invoice.invoiceNumber` are issued inside the transaction
that writes the sale, by `SELECT … FROM branches … FOR UPDATE` followed by
`MAX(sequence) + 1` on that branch.

`MAX + 1` on its own is wrong, and wrong in the way that only shows up on a busy
Friday: under READ COMMITTED two tills read the same number and the second
INSERT dies on `(tenantId, branchId, sequence)`. Taking the branch row's lock
first makes the second transaction wait for the first to commit and then read
the number that now exists. The lock is held to the end of the transaction,
which makes checkout a short per-branch queue — acceptable for a handful of
inserts, and the single place to change if a shop ever outgrows it.

The caller cannot supply either value; `RecordSaleInput` has no field for them.

**Numbering after a rollback.** A transaction that rolls back releases the lock
without having inserted, so the number it was going to use is handed to the next
transaction: the series stays dense, and a refused checkout leaves no gap. A
sale that commits and is later voided keeps its number, because a tax document
that disappears from the series is worse than one marked void. Both behaviours
are asserted live.

## Decision 3 — Idempotency is a claim about intent, and the database settles it

The operation id alone is not enough. A client that reuses a key with a
different basket is not retrying; it is ringing up a second sale under the first
one's name, and answering it with the earlier sale silently drops a transaction
the cashier believes they completed.

So a SHA-256 fingerprint of the canonical intent — branch, terminal, sorted
`productId:quantityScaled` pairs, cash received — is stored in the existing
`idempotency_keys.requestHash` column and compared on every replay. Same key and
same intent replays the original sale and writes nothing. Same key and different
intent is refused with a conflict. The lines are sorted before hashing, so a
client that reorders the basket between attempts still matches.

The fingerprint holds nothing secret: it is a digest of the same ids, quantities
and cash figure the sale row stores in the clear.

The pre-flight read cannot be the guard, because two requests carrying one key
can be in flight at the same instant and both find nothing. The reservation is
therefore written as

```sql
INSERT INTO "idempotency_keys" (...)
VALUES (...)
ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
RETURNING "id"
```

inside the sale transaction. `ON CONFLICT DO NOTHING` blocks on an _uncommitted_
conflicting row, so returning no row proves the competing transaction has
finished — which is what makes it safe to then go and read the sale it produced.
The loser's own transaction rolls back and the service answers from the
committed one: a replay when the intents match, a conflict when they do not.
A raw unique-constraint violation never leaves the repository; it is turned into
`OperationAlreadyRecordedError` at the boundary and into a reason above it, so
the HTTP layer answers 200, 201 or 409 and never 500.

## Decision 4 — Overselling is the merchant's decision, and the UPDATE enforces it

Stock is checked before any money is touched, against the branch's balance, and
only for products that carry `trackInventory`. A shortfall is refused unless
`tenant_settings.allowNegativeStock` is set, which is the merchant saying they
would rather sell and reconcile later.

That pre-flight check is a courtesy — it produces a clean refusal before the
domain does any arithmetic — but it is not what makes the policy hold. Two tills
selling the last unit both read a stock of one, and a read followed by an
increment cannot tell them apart. The decrement is therefore conditional, in the
same transaction as the sale:

```sql
UPDATE "inventory_balances"
   SET "quantityScaled" = "quantityScaled" + $delta, "updatedAt" = now()
 WHERE "tenantId" = $tenant AND "branchId" = $branch AND "productId" = $product
   AND "quantityScaled" + $delta >= 0
RETURNING "quantityScaled"
```

The predicate is evaluated after the row lock is taken, so the second
transaction re-reads what the first committed and matches nothing. No rows plus a
negative delta is `InsufficientStockError`, which aborts the whole transaction —
sale, lines, invoice, tender, drawer movement and reservation all go back — and
reaches the client as `insufficient-stock`. There is no read-modify-write in
Node and no process-local mutex; a second API instance would not weaken this.

Two lines naming the same product are refused rather than summed: each would
pass a stock check their total fails, and quietly merging them would also change
what the cashier sees on the receipt.

## Decision 5 — The shift is revalidated inside the sale transaction

The open shift is read before pricing, to get the branch and to refuse a till
with no drawer open. That read is stale by the time the sale commits: a shift can
be closed in between, and a sale posted into a closed shift is money that
reconciles against nothing.

So the sale transaction locks the shift row and proves it again — same tenant,
same id, status still `open`, same terminal, same branch, and the same cashier.
One drawer belongs to one cashier: no existing Korvi rule permits a shared shift,
and none is invented here. A principal pinned to a branch cannot transact through
a till in another one. Any of these failing is `ShiftUnusableError`, the whole
transaction rolls back, and the client is told `shift-invalid`.

Opening a shift has the mirror-image problem and no unique index that could
solve it, because a terminal legitimately has many shifts over its life. Two
cashiers pressing "open shift" together would both find no open shift and both
create one. `ShiftRepository.open` therefore takes `SELECT … FROM terminals …
FOR UPDATE` first, so the second waits and then sees the first. The refusal is
`ShiftOpenRefusedError`, which the route maps to a 409 — again, never a driver
error.

## Consequences

- A failed checkout leaves no sale, no line, no invoice, no tender, no stock
  movement, no drawer movement and no reserved operation id.
- Two tills in one branch never collide on a receipt number, and never share
  one.
- A double-clicked checkout is answered once, even when both clicks are in
  flight together; a mis-keyed reuse is refused.
- The last unit on a shelf is sold once. With `allowNegativeStock` set it is
  sold twice, because the merchant asked for that.
- Receipt numbering is dense across rollbacks and stable across voids.
- Checkout is a short per-branch queue, and shift opening a short per-terminal
  one. Both are the price of correctness here, and both are the single place to
  change if a shop outgrows them.
- No concurrency decision is made in Node. PostgreSQL is the authority for all
  four races, which is what makes a second API instance safe.
- ZATCA Phase 2 is untouched. The sale and invoice rows keep the shape that
  pipeline will need; nothing here claims a reported invoice was produced.
