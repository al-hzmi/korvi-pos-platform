# Strike 5B — Purchasing & Receiving

Status: **IMPLEMENTATION CONTRACT — C0 AT THE STOCK BOUNDARY**

Parent: ADR-0024. Predecessor: `STRIKE-5A-STOCK-LEDGER-INTEGRITY.md`.

## The authority boundary

One sentence governs this strike, and every rule below is a consequence of it:

> **A purchase order is not a stock movement.**

A purchase order is a merchant's intent to buy. It records what was asked for
and from whom. It says nothing about what is on the shelf, because nothing has
arrived. Only a _receipt_ — evidence that goods physically arrived and were
accepted — may move stock, and only for the quantity actually accepted
(ADR-0024 §7).

The complete causal chain is:

    Supplier
      → Purchase Order
        → Purchase Order Line
          → Purchase Receipt
            → Purchase Receipt Line
              → Inventory Movement
                → Inventory Balance + Revision

Four things must never exist, and each has a live proof:

| Must never happen                              | Proof                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PO creation changes stock                      | D — movement count, balance count, quantity total and revision total are identical before and after                      |
| A client quantity overwrites a balance         | The receipt schema has no balance field; the API refuses one by name                                                     |
| A receipt row exists without its stock effect  | Q — a late failure rolls back receipt, lines, accumulators, status, movements, balances, audit and idempotency together  |
| A stock effect exists without receipt evidence | Every purchasing movement carries `sourceType = 'purchase-receipt'`, `sourceId` = receipt, `sourceLineId` = receipt line |

## What this strike is not

No costing, no average cost, no FIFO, no valuation, no landed cost, no purchase
price allocation. No `unitCostMinor` column exists anywhere in the purchasing
schema, and its absence is a decision rather than an omission — Strike 5C owns
costing (ADR-0024 §8).

Also absent, deliberately: supplier invoices, accounts payable, journal entries,
tax or regulatory purchasing documents, ZATCA purchasing behaviour, supplier
marketplace or B2B network, payments to suppliers, offline purchasing, batches,
lots, expiry dates, serial numbers, and any UI. 5D owns the operational
interface and cannot add authority.

## Document model

Five new tables, all tenant-owned, all with `tenantId` first in every index, all
with tenant-consistent composite foreign keys, and all under ENABLE + FORCE row
level security.

### `suppliers`

`id`, `tenantId`, `name`, `isActive`, `createdAt`, `updatedAt`. Nothing else.
Contact details, tax numbers, payment terms and banking are all real needs that
belong to a strike with somewhere to put them; a column added speculatively is a
column that has to be migrated when the real requirement disagrees with the
guess.

There is deliberately **no unique index on the name**. Two genuinely different
companies can trade under one name, and a merchant holding two accounts at one
wholesaler is ordinary. A uniqueness rule nobody asked for would block real data
entry to prevent a problem that has not been shown to exist.

There is also **no delete**, as a decision rather than a gap. Deactivation is
the administrative act; the foreign keys are `NO ACTION` so the database agrees.

### `purchase_orders` / `purchase_order_lines`

The header carries `supplierId`, `branchId` (the destination), `operationId`,
`requestHash`, an optional merchant `reference`, a server-controlled `status`,
the actor and the timestamps. Each line carries `productId`,
`orderedQuantityScaled` and `receivedQuantityScaled`.

A purchase order is **immutable after creation** in this strike. There is no
draft-edit workflow, no cancellation and no quantity revision — an ordered
quantity that could be raised after a partial receipt would let a merchant
retroactively legalise an over-receipt.

### `purchase_receipts` / `purchase_receipt_lines`

The header carries `purchaseOrderId` plus `branchId` and `supplierId`
**denormalized from the locked order at receipt time**. That is deliberate:
these are the branch the goods entered and the supplier who delivered them as
they stood when somebody signed, not as the order reads today.

Each line carries the accepted quantity, the three numbers the accumulator
arithmetic is checked against (`orderedQuantityScaled`,
`beforeReceivedQuantityScaled`, `afterReceivedQuantityScaled`), and the stock
effect it produced (`beforeQuantityScaled`, `afterQuantityScaled`,
`resultRevision`).

Four CHECK constraints assert the arithmetic rather than trusting the code:

    acceptedQuantityScaled > 0
    afterReceived = beforeReceived + accepted
    beforeReceived >= 0 AND afterReceived <= ordered
    afterQuantity  = beforeQuantity  + accepted
    resultRevision >= 1

and `purchase_order_lines` independently holds
`0 <= receivedQuantityScaled <= orderedQuantityScaled`.

## Purchase order lifecycle

Three states, and only three: `open`, `partially_received`, `received`.

Status is a **function of the line accumulators**, computed by
`derivePurchaseOrderStatus` in `@korvi/domain` and recomputed inside the
transaction that changed those accumulators. It is never submitted by a client,
and never stored independently of the lines it summarises — so an order cannot
claim to be finished while a line is still outstanding, even for the duration of
one statement.

    every line received == ordered      →  received
    otherwise, any line received > 0    →  partially_received
    otherwise                           →  open

Creation always yields `open`, because every line starts at zero received.

## Receipt lifecycle

Partial receipts are first-class. An order for 100 000 may be filled by a
receipt for 30 000 on Monday and 70 000 on Tuesday; the order moves
`open → partially_received → received`, and the Monday receipt is never
rewritten. Multiple receipts against one order are ordinary, and every one of
them is immutable historical evidence.

A receipt names **purchase-order lines**, not products. The product, the branch
and the supplier are all derived from the locked PO rows. A client that named
the product instead would be choosing which accumulator to spend, and on an
order with one line per product that is the same choice made less safely.

## Over-receipt

For every purchase-order line, at all times:

    0 <= receivedQuantityScaled <= orderedQuantityScaled

This is not a preflight rule. The remaining quantity is evaluated **while the
transaction holds `FOR UPDATE` on the purchase-order line**, and two concurrent
receipts serialize at the order row before either reaches it — so the second
sees what the first spent.

Worked example, proved live:

    ordered  = 10000
    received =  6000   (remaining 4000)

    two concurrent requests, each accepting 3000
    → exactly one commits
    → the other is refused with `over-receipt`
    → final received = 9000, and never 12000

Strike 5B allows **no over-receipt exception and no tolerance**. ADR-0024 §7
explicitly defers such a policy until it is separately designed and approved.

## Lock order

The global class order across all of Korvi, after this strike:

    suppliers
      → purchase orders
        → purchase order lines
          → branches
            → products
              → tenant settings
                → balances

Every actor takes a **subsequence** of it and never reaches backwards:

| Actor                            | Locks                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| Checkout, returns                | one branch `FOR UPDATE`, then balances                              |
| Adjustment, count, transfer (5A) | branches, products, settings, balances                              |
| Purchase order creation          | suppliers, branches, products — **no balance at all**               |
| Receiving                        | purchase orders, purchase order lines, branches, products, balances |

Receiving's own sequence:

1. idempotency reservation
2. the purchase order row, `FOR UPDATE`
3. every line of that order, `FOR UPDATE`, in lexical id order
4. the destination branch, `FOR SHARE`
5. every product being received, `FOR SHARE`, in lexical id order
6. materialize the required balance rows at zero
7. lock those balance rows `FOR UPDATE` in canonical `(branchId, productId)`
   order — Strike 5A's own helper, called rather than copied
8. evaluate every predicate against the _locked_ rows
9. write receipt → receipt lines → accumulators → status → movements → balances
   → audit

**Why it cannot deadlock.** Only receiving ever locks a purchase-order row, so
the only transaction that can wait for one is another receiving transaction —
and it waits at step 2 while holding nothing but its own idempotency row, which
no other operation id contends for. A transaction blocked there cannot be an
interior node of a wait cycle. Everything from step 4 onwards is 5A's existing
discipline unchanged.

**Why the order is `FOR UPDATE` and the branch is `FOR SHARE`.** The order row
is genuinely written — its status changes — and two receipts against one order
must serialize completely. The branch is only read _as an authority_:
`FOR SHARE` conflicts with the `FOR NO KEY UPDATE` a deactivation takes, so a
branch stood down mid-receipt blocks rather than slipping underneath, while two
receipts into the same branch still meet at the balance rows rather than at the
branch.

## Stock effect

For every accepted receipt line:

    balance.quantityScaled += acceptedQuantityScaled
    balance.revision       += exactly 1

through `applyMovementWithin` — the same shared primitive checkout, returns,
adjustments, counts and transfers use. There is no second implementation of
stock arithmetic anywhere in this strike.

The movement carries:

| Field          | Value               |
| -------------- | ------------------- |
| `kind`         | `receipt`           |
| `sourceType`   | `purchase-receipt`  |
| `sourceId`     | the receipt id      |
| `sourceLineId` | the receipt line id |

`kind = 'receipt'` has been permitted by the `inventory_movements_kind` CHECK
since the SaaS foundation migration, so receiving needs no widening of
historical vocabulary and overloads none of `sale`, `return`, `adjustment` or
`transfer` with false semantics.

Because receiving steps the same revision counter, a stock count taken while a
delivery is being booked notices it and refuses rather than overwriting it —
which is the 5A concurrency contract continuing to hold.

## Idempotency

Korvi's existing doctrine, with four new scopes:

    purchasing-supplier-create
    purchasing-supplier-update
    purchasing-order-create
    purchasing-receipt-create

Every retryable mutation carries an `operationId` and a canonical request
fingerprint. The canonical _form_ is decided in `@korvi/domain`; the SHA-256 is
taken in `apps/api/src/purchasing/fingerprint.ts`, because `node:crypto` in the
domain would break ADR-0001 — and because what counts as the same intent is a
domain rule while hashing it is not.

- The actor is bound into every fingerprint, so one user cannot replay a
  colleague's operation id and be handed their document.
- Lines are sorted by identity before hashing **and** before writing, so a
  reordered retry replays rather than conflicting, and the replay presents its
  lines exactly as the first response did.
- Quantities are re-parsed to canonical integer text, so `007` and `7` are one
  intent.
- UUIDs are canonicalized (trimmed, lower-cased, shape-checked), so a re-spelled
  retry is a replay.
- `operationId` stays opaque merchant text and is **never** UUID-normalized.
- The reservation and the business mutation commit together, so a rolled-back
  receipt frees its operation id.

For a receipt replay specifically: stock does not move twice, the accumulator
does not advance twice, and the revision does not step twice.

### The committed answer is stored, not recomputed

`resultId` alone keeps the replay promise only for as long as nothing else
changes — and in purchasing, later change is the normal case. Reconstructing a
replay by reading the documents back returns _today's_ state:

| Operation                                  | Later legitimate mutation     | What a document read-back would wrongly report |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------- |
| Receipt A → `partially_received`           | Receipt B completes the order | `received` — a status A never produced         |
| Purchase order create → `open`, 0 received | Goods arrive                  | `received`, accumulators full, remaining 0     |
| Supplier create                            | A rename or a deactivation    | the new name and the new active state          |
| Supplier update A                          | A second update B             | B's values reported as A's answer              |

So the answer is **frozen at commit time**. The 5B forward migration adds a
nullable `resultSnapshot JSONB` to `idempotency_keys`, and each of the four
purchasing mutations writes its exact returned payload there **in the same
transaction as the mutation itself**. A replay reconstructs from that snapshot
and never from a live document.

That makes it evidence rather than a cache: there is no window in which a
committed purchasing operation lacks its snapshot, no way for a rolled-back one
to leave a stale one, and nothing to invalidate. The reservation, the documents,
the stock effect and the snapshot all commit or all roll back together.

Only `replayed` legitimately differs between the first answer and its replay —
the caller is being shown a record, not being told one was made. Every other
field is identical.

Deliberate boundaries:

- **Nullable, no backfill.** Operations that committed before the column existed
  have no recorded answer, and inventing one would be worse than admitting it.
  A snapshot is never fabricated for a pre-5B operation.
- **Purchasing scopes only.** The 5A stock scopes are untouched; a live proof
  asserts they still store no snapshot at all.
- **A null on a purchasing scope is a fault, not a fallback.** The reader
  refuses rather than quietly reading the document back, because that fallback
  is exactly the defect this mechanism removes.
- **Narrowed, not cast.** JSONB returns `unknown`; typed readers check every
  field, so a malformed snapshot fails loudly at the boundary instead of
  travelling outwards as a valid answer.

Changed intent under a reused operation id remains an `idempotency-conflict`
in every scope — stable replay widens what is _returned_, never what counts as
the same request.

## Row level security

All five tables are ENABLE + FORCE, with a `USING` and a `WITH CHECK` policy on
`tenantId = current_tenant_id()`. Proved live as a `NOSUPERUSER NOBYPASSRLS`
role: tenant A cannot see or mutate tenant B's suppliers, orders, order lines,
receipts or receipt lines, cannot receive against tenant B's order, and cannot
inject tenant B's product or branch identity into its own documents. Every
cross-tenant identity fails closed and answers identically to a missing one, so
no endpoint becomes a probe for what exists.

## Permissions

Three new permissions, added to `PERMISSIONS` and the catalogue:

| Permission           | Grants                                              |
| -------------------- | --------------------------------------------------- |
| `purchasing.read`    | list and read suppliers, orders and receipts        |
| `purchasing.manage`  | create and update suppliers, create purchase orders |
| `purchasing.receive` | book a receipt — the only one that moves stock      |

Canonical grants: owner, admin and manager receive all three; cashier receives
none. A till neither orders from suppliers nor signs for a delivery.

`manage` and `receive` are separate because committing the shop to a purchase
and asserting that goods physically arrived are separate acts with separate
consequences, and a merchant may reasonably grant one without the other.

Existing tenants receive the grants through migration
`20260828120000_purchasing_receiving`, which grants only to `isSystem = TRUE`
manager, admin and owner roles — never to a merchant's own custom role, whatever
they named it. Future tenants receive them from `ROLE_PERMISSIONS` through
canonical provisioning. Authorization is permission-based at runtime and never
role-name based.

The backfill lifts FORCE on `roles` and `role_permissions` inside the
migration's own transaction and restores it before `COMMIT`, following the
pattern Strike 4A established and Strike 5A reused. It has to: those tables are
FORCE-RLS, the migration runs as the owner with no `app.tenant_id`, and the
`INSERT … SELECT` would otherwise silently affect zero rows while reporting
success. The rehearsal suite proves the grants landed, that FORCE is restored in
both the catalogue and in behaviour, and that the ids minted are distinct
UUIDv7s.

## Atomicity

These commit as **one** PostgreSQL transaction, or none of them do:

- the idempotency reservation
- the receipt header
- the receipt lines
- the purchase-order line accumulators
- the purchase-order status
- the inventory movements
- the inventory balance mutations
- the balance revisions
- the audit event

The proof injects a fault from the database — a trigger that refuses the
purchasing audit insert, which is the last write of the transaction — and then
asserts that no receipt, no receipt line, no accumulated quantity, no status
change, no movement, no balance change and no idempotency key survives. The fault
lives in the database rather than in a parameter on the authority, so there is no
test-only branch in production code.

## Historical immutability

No endpoint deletes a supplier, a purchase order or a receipt. Every foreign key
that represents historical business evidence is `ON DELETE NO ACTION`:

| From                     | To                                 | Why                                                                     |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------- |
| `purchase_orders`        | `suppliers`                        | deleting a supplier must not erase what was bought from them            |
| `purchase_orders`        | `branches`                         | nor an administrative branch tidy-up                                    |
| `purchase_order_lines`   | `products`                         | nor a product cleanup                                                   |
| `purchase_receipts`      | `purchase_orders`                  | a receipt is not a detail of its order; its movements are in the ledger |
| `purchase_receipts`      | `branches`, `suppliers`            | the same reasoning                                                      |
| `purchase_receipt_lines` | `purchase_order_lines`, `products` | the same reasoning                                                      |

`CASCADE` is used only _within_ a document — order → its own lines, receipt →
its own lines — and from `tenants`, which is the established tenant-lifecycle
doctrine and outside this branch-history rule.

Corrections happen through explicit compensating business operations, never
silent edits to history.

## API surface

Backend authority only. No UI, and no DELETE route anywhere.

    GET    /v1/admin/purchasing/suppliers                       purchasing.read
    GET    /v1/admin/purchasing/suppliers/:supplierId           purchasing.read
    POST   /v1/admin/purchasing/suppliers                       purchasing.manage
    PATCH  /v1/admin/purchasing/suppliers/:supplierId           purchasing.manage
    GET    /v1/admin/purchasing/orders                          purchasing.read
    GET    /v1/admin/purchasing/orders/:purchaseOrderId         purchasing.read
    POST   /v1/admin/purchasing/orders                          purchasing.manage
    GET    /v1/admin/purchasing/orders/:id/receipts             purchasing.read
    POST   /v1/admin/purchasing/receipts                        purchasing.receive

Every mutation route requires a session, requires the exact permission, derives
the tenant and actor from the principal, canonicalizes UUID identity at the
door, refuses forbidden authority fields **by name**, returns a stable typed
refusal status with an actionable Arabic message, and never reveals another
tenant's existence.

Forbidden on every purchasing body: `tenantId`, `actorUserId`, `userId`,
`status`, `purchaseOrderStatus`, `receivedQuantityScaled`,
`remainingQuantityScaled`, the before/after quantity and revision fields,
`movementKind`, `kind`, `occurredAt`, `receivedAt`, `orderedAt`, audit fields,
any balance, and `unitCostMinor` / `costMinor` — the last two because 5B has no
costing and a body carrying one is a mistake worth naming rather than ignoring.

Additionally forbidden on a **receipt** body: `supplierId`, `branchId`,
`productId`. Those are derived from the locked order. On an _order_ body they
are legitimate input, which is why the two lists differ.

Additionally forbidden on a **supplier update** body: `supplierId`. The path
owns the identity, and a body carrying a second one would be two sources of
truth for which supplier is being changed. Refused by name rather than left to
`.strict()` as a generic unknown key.

### A read filter is not an authority claim

Mutation bodies and read query strings are **separate lists**, because they
answer different questions. A `status` in a mutation body is an attempt to
declare an order finished; a `status` in a query string is a filter over rows
the caller may already read and asserts nothing at all. Conflating the two made
`GET /orders?status=open` unreachable — a legitimate filter rejected before its
schema could parse it.

A query may therefore never carry **identity** — `tenantId`, `tenant`,
`actorUserId`, `userId`, `sessionId` — and nothing else is named. Tenancy comes
from the session and RLS enforces it underneath; naming these keeps a probe
legible in the logs rather than hidden behind a generic parse failure.

Everything else a query may carry is bounded by the strict Zod schemas: an
unknown key, an out-of-range limit, or a status outside the three the lifecycle
defines is `invalid_query` — a schema failure, distinct from `forbidden_field`.
The proofs assert the _reason_, not merely the 400, so re-forbidding the filter
wholesale would fail the suite rather than pass it.

Quantities cross the wire as decimal strings in both directions. A JSON `number`
loses whole units past 2^53, which a warehouse quantity in grams reaches.

## Live C0 proofs

Run against a fresh PostgreSQL database as a `NOSUPERUSER NOBYPASSRLS` role,
with all migrations applied from zero.

|       | Proof                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A     | application role is NOSUPERUSER / NOBYPASSRLS                                                                                       |
| B     | every new table has ENABLE + FORCE RLS; `roles`/`role_permissions` FORCE restored in catalogue and behaviour                        |
| C     | cross-tenant reads and writes are isolated and fail closed                                                                          |
| D     | creating a purchase order changes 0 movements, 0 balances, 0 revisions                                                              |
| E     | a partial receipt writes receipt, lines, accumulators, status, movements, balance, exactly-one revision step, audit and idempotency |
| F     | the final receipt moves the order to `received`                                                                                     |
| G     | replaying a receipt changes nothing twice                                                                                           |
| H     | the same operation id with changed intent conflicts, for receipts and orders alike                                                  |
| I     | two concurrent receipts cannot over-receive; a single over-sized receipt writes nothing                                             |
| J     | a multi-line receipt is the same operation whatever order the lines arrive in                                                       |
| K     | a unit product refuses a fractional accepted quantity, at ordering and at receiving                                                 |
| L     | a weighted product accepts a scaled fractional quantity                                                                             |
| M     | an inactive branch and an inactive supplier are refused for a new order                                                             |
| N     | inactive and untracked products are refused, including when tracking is turned off after the order                                  |
| O     | a receipt waits for an in-flight branch deactivation and then refuses                                                               |
| P     | a receipt waits for an in-flight `trackInventory` change and then refuses                                                           |
| Q     | a late failure rolls everything back, and frees the operation id                                                                    |
| R/S/T | sale, original-sale return and 5A adjustment/count/transfer suites remain green; receiving steps the same revision counter          |
| U     | the permission migration upgrades an existing pre-5B tenant correctly                                                               |
| V     | cashier and custom roles receive no purchasing authority                                                                            |
| W     | purchasing evidence blocks destructive branch, supplier, product and order deletion                                                 |
| X     | UUID case variants name one thing, not two — in duplicate detection, in identity, and in the fingerprint                            |
| Y     | zero unhandled promise rejections or errors across the run                                                                          |

Stable-replay proofs, each performing a **later legitimate mutation** between
the original operation and its retry — without that intervening change they
would pass against either implementation and prove nothing:

|     | Proof                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| A   | a supplier create replays its own answer after the supplier is renamed _and_ deactivated                                       |
| B   | a supplier update replays its own answer after a second update                                                                 |
| C   | a purchase order create still reports `open`, 0 received and full remaining after the order has been fully received            |
| D   | receipt A still reports `partially_received` after receipt B closed the order, with byte-identical line evidence and revisions |
| D   | that replay adds 0 receipts, 0 receipt lines, 0 movements, 0 balance quantity, 0 revision, 0 accumulator and 0 audit rows      |
| E   | changed intent under a reused operation id still conflicts, in all four scopes                                                 |
| —   | the snapshot is written in the mutation's own transaction, and the 5A stock scopes still store none                            |

Each of A–D also asserts that the _live_ document really did move on, so the
equality being checked is the snapshot holding rather than the later mutation
having silently failed.

Concurrency tests are time-bounded so a deadlock fails the test rather than
hanging the suite. No test uses a sleep as a correctness mechanism.

## Human Gate

`npm run verify` is necessary and not sufficient for this strike.

A C0 strike is not approved by its writer. Strike 5B is **not closed** until
independent diff review and the Human Gate have both passed. Nothing in this
document is a claim that the capability is production ready, that costing exists,
or that any ZATCA purchasing obligation is met.
