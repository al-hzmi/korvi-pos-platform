# ADR-0016 — Returns and refunds

Status: accepted · Strike 3B-1b · supersedes nothing · builds on ADR-0002,
ADR-0004, ADR-0013, ADR-0015

## Context

Korvi could take money and could not give it back. `returns`, `return_lines`
and `refunds` existed as a sketch from the SaaS foundation — enough shape to
reserve the names, not enough to be a commercial document: no till, no drawer,
no operator, no number, no gross, no discounts, and no engine behind them.

A return is the operation where a point of sale is most likely to lose a
merchant money quietly. Nothing crashes when a partial refund is a halala
short; it simply happens on every partial return, forever.

## Decision

### The original sale is the only authority

Every figure on a return is prorated from the persisted sale line — its gross,
its two discount components, its net, its VAT and its total. Nothing is
recomputed from `products`. A price change, a VAT change, a rename, a
reclassification or a deactivation after the sale must not alter what a
customer gets back, and the only way to guarantee that is to never read the
catalogue at return time.

A sale that is not `finalized` is not returnable.

### Cumulative proration, never per-return rounding

For each component, the cumulative share owed after `q` of `Q` has come back is

    target(component, q) = floor(component * q / Q)

and what a return pays is `target(newCumulative) - alreadyRefunded`, where
`alreadyRefunded` is the sum of the finalized return rows rather than a
recomputation. At full quantity the target is the original component exactly,
so however a line is broken up — in any order, in any sizes, unit or weighted —
the sum of every return against it equals the line, on every component.

Rounding each return independently loses the remainder at every step. Three
returns of one unit from a line of three whose net is 1000 would refund 999,
and the same goods returned together would refund 1000.

`total` is derived as `net + VAT`; the other five components are prorated.
`gross - discounts` is deliberately not asserted to equal anything: under
tax-inclusive pricing it is the total, under tax-exclusive it is the net, and
one constraint cannot be both. That is why `sale_lines` only ever checked
`net + VAT = total`, and returns follow it.

### Unit versus weighted comes from a snapshot

`sale_lines.productType` is added and written at the moment of sale. Reading
the live product row at return time would mean a catalogue edit could change
what a historical sale means. The column is nullable, and rows written before
this migration deliberately remain NULL: today's editable catalogue is not
historical evidence. NULL means "no immutable fact proves the type". For such
a line the engine permits only the entire remaining quantity, because a full
remainder needs no unit-vs-weight interpretation; partial returns require the
immutable snapshot. A quantity that happens to be a whole number is not
evidence that the line was sold by the unit, and no heuristic of that shape is
acceptable.

This is the one change to the sale write path in this strike. It is additive:
one column, one value, and no arithmetic.

### The transaction is the authority, not the read

`ReturnRepository.record` owns the whole commercial fact in one transaction:
the document, its lines, the refund record, the stock reversal, the drawer
movement, the return number and the idempotency reservation.

The serialization boundary is `SELECT ... FROM sales ... FOR UPDATE`. Every
return against a sale queues on that row, so remaining quantity is read by one
transaction at a time; two cashiers returning the last unit cannot both see it
available. Sale lines are additionally locked in id order for deadlock hygiene.
There is no application-level lock anywhere.

Pricing stays in the domain by passing a pure `plan` function into `record`:
the adapter reads the authoritative state under lock and hands it over. Its
refusals roll the transaction back before a number is issued.

The preflight read in the service is a courtesy to the user interface. It is
explicitly not authority.

### Numbering

A return takes its own per-branch series, allocated under the branch row's
lock exactly as a receipt number is, and rendered `R-<branch>-<000001>`. A
rolled-back return releases the number to the next transaction, so the series
has no gap; a committed return keeps its number forever.

### Idempotency

Scope `return`. The fingerprint covers the material intent — sale, till, the
canonicalised lines and quantities, and the refund method with its scheme and
reference. It excludes everything the server derives (amount, branch, shift,
operator, number) and excludes the free-text reason, which a cashier may retype
differently on a retry. Same id and same intent replays the same document; same
id and different intent is `idempotency-conflict`.

### Refunds

One refund per return document, enforced by a unique index. Either cash, which
writes a negative `refund` movement against the open shift, or electronic,
which records that an approval happened elsewhere and writes no drawer
movement. Korvi contacts no scheme, acquirer, wallet or bank. The reference is
bounded, and cardholder data is refused by field name and by value — the same
Luhn check the settlement strike introduced, reused rather than reimplemented.

No cash-availability rule. Expected cash is accounting state, not a count of
the notes in the drawer, and refusing a lawful refund because a running total
looks low would be Korvi inventing a policy the merchant never asked for.

### Inventory

Stock is credited only where the original sale actually decremented it, proved
from that sale's own `inventory_movements` rows rather than from
`products.trackInventory` as it stands today. A merchant who enabled tracking
last week must not have last month's returns inflate a balance that was never
reduced.

### Authorisation

`sale.refund`, which already exists; no permission was invented. The branch
comes from the session, the till is proved to be in that branch, and the shift
must be open, on that till, in that branch and the operator's own. A sale in
another branch and a sale that does not exist get the same answer, so no
refusal reveals that another branch's sale exists.

## Boundaries

This is not a ZATCA credit note. Nothing here is signed, nothing is cleared,
and nothing claims to be reported. What the return document does carry is every
immutable tax fact a Phase 2 credit-note pipeline will need — quantities, the
VAT rate per line, and net, VAT and total per line and per document — so that
pipeline can be built without reconstructing historical prices or discounts.

Manual pay-in and pay-out, shift close, drawer reconciliation, the returns user
interface, receipt printing and payment-provider integration are not in this
strike and are not stubbed.

## Consequences

Returns per sale are serialised on the sale row. A sale being returned by two
tills at once queues; this is the correct trade for an invariant no constraint
can express, and the lock is held for the length of one small transaction.

A merchant may return goods against a sale whose product has since been
deleted. The line still refunds correctly, because everything it needs was
snapshotted; only the stock reversal is skipped, because there is nothing to
credit.
