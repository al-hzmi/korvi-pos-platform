# ADR-0024 — Inventory & Purchasing Authority

Status: **ACCEPTED FOR STAGE 5 IMPLEMENTATION**

## Context

Korvi already has the beginnings of one stock truth: `inventory_balances`, append-style `inventory_movements`, and sale/return transactions that post stock in the same PostgreSQL transaction as the commercial document. That foundation is useful, but it is not yet a complete inventory/purchasing authority.

Stage 5 must add merchant-facing adjustments, counts, transfers, suppliers, purchase orders, receiving, costing foundations and branch stock without creating a second stock truth or weakening existing sale/return guarantees.

## Decision

### 1. One stock truth

`inventory_movements` is the causal stock ledger and `inventory_balances` is its transactional materialized balance. No purchasing, counting, transfer, sale, return or UI module may maintain an independent stock quantity.

A balance mutation and the movement(s) that explain it commit atomically. A movement without its balance effect, or a balance change without its causal movement, is invalid.

### 2. Stage 5 is delivered in four bounded strikes

- **5A Stock Ledger Integrity** — authoritative manual adjustments, stock counts and atomic branch transfers; idempotency, audit, lock order, RLS, negative-stock policy and live concurrency proof.
- **5B Purchasing & Receiving** — suppliers, purchase orders, partial receiving and receipt-to-stock atomicity. Receiving is the only purchasing action that changes stock.
- **5C Costing Authority** — exact integer valuation foundation, explicit provenance for unknown historical cost, deterministic moving-cost/consumption rules, and sale/return valuation integration. No float/decimal arithmetic.
- **5D Inventory/Purchasing UX** — bounded operational UI over the server authorities; no client-derived balances, received quantities, costs, status transitions or completion flags.

The strikes may be merged only when their applicable release gates pass. Roadmap sequencing may defer a strike but cannot delete it.

### 3. Quantity and money

Stock quantity remains signed `BIGINT` scaled by 1000. Money remains `BIGINT` minor units. JavaScript floating-point arithmetic is forbidden for stock, cost, valuation, purchasing totals and allocation.

Unit products accept only whole-unit scaled quantities. Weighted products may use the fixed 1000 scale. No input is silently rounded.

### 4. Mutation authority and idempotency

Every merchant-triggered stock mutation is session-derived and permission-checked on the server. The browser cannot provide `tenantId`, actor identity, current balance, resulting balance, movement kind, completion state or audit facts as authority.

Every retryable mutation carries an operation id and canonical request fingerprint. Same operation + same intent replays the committed result; same operation + different intent conflicts. The idempotency reservation and business mutation commit together.

Sale and original-sale return idempotency remain unchanged.

### 5. Adjustments and counts

A manual adjustment is an explicit signed delta with a bounded reason and actor. A stock count records the counted absolute quantity as evidence, but the server derives the delta under the balance row lock. The client never submits the authoritative adjustment delta for a count.

`inventory_balances` carries a monotonic integer revision that increments with every committed balance mutation, including sale and return movements. Inventory reads expose that revision. A count submission must carry the revision of the balance snapshot that was physically counted. Under the balance lock the server compares the submitted expected revision with current truth before deriving the delta. A mismatch is a conflict that requires the caller to refresh/recount; Korvi never silently overwrites a sale, return, transfer or adjustment that occurred during a count. An absent balance is snapshot revision zero; finalization materializes/locks the zero row and still detects any concurrent first movement.

If negative stock is disabled, the mutation itself enforces the floor under concurrency. A preflight read is not sufficient.

### 6. Transfers

A completed transfer is one atomic operation with two causal legs: negative at source and positive at destination, for the same product and exact quantity. Partial one-sided transfers are forbidden.

When more than one balance row is locked, rows are acquired in a deterministic canonical order so opposite-direction concurrent transfers cannot deadlock by design. Missing balance rows are materialized as zero before canonical locking so row absence cannot bypass the lock order.

A transfer cannot target the same branch, a missing/inactive branch, an unavailable product, or an untracked product. A physical transfer never drives the source below zero, regardless of checkout oversell policy; nonexistent stock cannot be moved between branches.

### 7. Purchasing and receiving

Purchase orders do not change stock. A receipt changes stock only for quantities actually accepted.

Supplier, PO, PO line, receipt and receipt-line identities are tenant-consistent through composite foreign keys and strict RLS. Partial receipts are first-class. Received quantities are accumulated under locked PO-line authority; over-receipt is refused unless a later explicit product rule is designed and approved.

Receiving, receipt evidence, PO received quantities, stock movements, balances, audit and idempotency commit atomically.

### 8. Costing

Costing is a C0 financial authority and is not inferred from retail selling price.

Historical stock/movements that predate recorded costing must retain an explicit `unknown` provenance. Migrations may not fabricate opening cost. A merchant/admin bootstrap or receiving/valuation operation may establish recorded cost prospectively under a separately tested authority.

The costing strike must conserve total integer inventory value across allocations and must prove rounding/remainder behavior with adversarial tests. When the final quantity is consumed, no unexplained residual value may remain.

Returns must restore the cost basis attributable to the original sale rather than using today's average cost.

### 9. Existing sale/return behavior is preserved

Checkout continues to post sale stock movements inside the sale transaction, and original-sale returns continue to post reversal stock movements inside the return transaction. Stage 5 may refactor shared stock primitives only if regression tests prove these transaction boundaries remain atomic and idempotent.

### 10. Audit and immutability

Privileged inventory/purchasing mutations emit audit events with operation/document references and safe metadata. Audit never contains credentials or secrets.

Finalized movement/receipt/transfer/count evidence is append-only through the trusted authority path. Corrections happen through explicit compensating business operations, never silent edits to history.

## Permissions

Authority decisions are permission-based, not role-name based. Existing `inventory.read` and `inventory.adjust` remain. Stage 5 may add narrowly scoped permissions such as transfer and purchasing permissions when the operation cannot be safely represented by an existing permission. Existing tenants must receive new system-role grants through a forward migration; future tenants receive them from the canonical provisioning permission map.

## Gates

5A/5C are C0 for data/financial integrity and require real PostgreSQL concurrency, rollback, idempotency, RLS and adversarial proof. 5B receiving is C0 at the stock/cost boundary even if supplier/PO CRUD is C1. 5D is C1 UX and cannot add authority.

`npm run verify` is necessary but not sufficient for these strikes.

## Non-goals

This ADR does not implement restaurant ingredient depletion, omnichannel reservation, offline stock mutation, supplier-network marketplace behavior, accounting/GL posting, or regulatory purchasing documents. Those remain in their roadmap domains and must consume this authority rather than fork it.
