# KORVI STRIKE 5C — COSTING AUTHORITY

Status: **ACTIVE C0 IMPLEMENTATION CONTRACT**

Authority: ADR-0024 §8, as corrected by ADR-0025, plus the mandatory release gates. This document narrows implementation semantics; it does not widen Stage 5 scope.

## 1. Mission

Add exact inventory valuation to Korvi without creating a second stock truth, inventing historical acquisition cost, weakening sale/return atomicity, or allowing the browser to state derived financial facts.

`inventory_movements` remains the causal stock ledger. `inventory_balances` remains the only stock quantity truth. Costing adds valuation state and immutable valuation evidence that are synchronized to the stock revision inside the same PostgreSQL transaction.

## 2. Non-goals

Strike 5C does **not** implement supplier invoices/AP, accounting/GL posting, landed-cost allocation, purchase tax/VAT documents, retail margin UI, historical cost reconstruction, standard costing, FIFO/LIFO lot accounting, offline costing, or 5D UX.

No retail selling price is ever used as acquisition cost.

## 3. Numeric doctrine

- Quantity: signed PostgreSQL `BIGINT`, scaled by 1000.
- Money/value: PostgreSQL `BIGINT` minor units.
- Internal JavaScript/TypeScript arithmetic: `bigint` only.
- No float, `Decimal`, `parseFloat`, `Number` financial arithmetic, exponent notation, or silent rounding.
- Allocation remainder doctrine: cumulative prefix allocation. The final quantity owns the exact residual minor units.

For a value of 100 over three equal units, consumption is exactly `33 + 33 + 34 = 100`.

## 4. Historical provenance

Every pre-5C stock movement and historical sale/return/receipt line is migrated as explicit `historical-unknown` cost provenance with zero invented value.

Existing positive on-hand quantity is **not** evidence of acquisition value. Migration seeds only the valuation cursor (`stockRevision`) and a zero known-cost pool.

A migration must never infer cost from selling price, purchase-order reference, supplier identity, current catalogue state, or any other proxy.

## 5. Current valuation state

`inventory_cost_balances` stores only the known-cost subset of the current positive stock for one `(tenant, branch, product)`:

- `knownQuantityScaled`
- `knownValueMinor`
- `stockRevision`
- `costRevision`

It deliberately does not duplicate total stock quantity. Current unknown positive stock is derived as:

`max(inventory_balances.quantityScaled, 0) - knownQuantityScaled`

A cost row whose `stockRevision` differs from the locked stock balance revision is an internal invariant failure. Korvi fails loudly; it never guesses or repairs the valuation cursor silently.

## 6. Movement evidence

Every post-5C stock movement carries immutable cost evidence:

- known quantity consumed/received,
- unknown quantity consumed/received,
- known value,
- provenance (`unknown`, `recorded`, `mixed`; historical rows remain `historical-unknown`).

For every movement:

`knownQuantity + unknownQuantity = abs(stock movement quantity)`

Value cannot exist without known quantity.

`inventory_valuation_events` is append-only evidence. It is not a second stock ledger.

## 7. Outflow doctrine

All ordinary stock outflows consume:

1. current positive unknown stock first,
2. then recorded-cost stock,
3. any permitted oversell beyond positive on-hand as unknown.

Korvi never fabricates COGS for negative stock.

The known-cost amount removed from the pool is calculated by exact integer prefix allocation. Final consumption leaves no residual value when the final known quantity is exhausted.

## 8. Known/mixed inflow doctrine

A positive stock movement may carry an explicit incoming basis only when the trusted server authority has independent evidence for it. The basis is:

- `knownQuantityScaled`,
- `unknownQuantityScaled`,
- `knownValueMinor`.

The quantities must reconcile exactly to the stock movement.

If stock before the inflow is negative, incoming unknown quantity fills the deficit first. Any remaining deficit then consumes the known segment, with exact prefix allocation of the attributable known value. That known value becomes immutable `deficit-catchup` evidence; it does not remain an inventory asset for quantity that merely neutralized prior negative stock.

Only the known quantity/value that remains above zero is added to the current known-cost pool.

## 9. Checkout / sale basis

Checkout remains one transaction.

For each tracked sale line, the sale stock movement is valued under the locked branch cost pool. The resulting movement basis is frozen onto the corresponding `sale_line` in the same transaction:

- `costKnownQuantityScaled`
- `costUnknownQuantityScaled`
- `costValueMinor`
- `costProvenance`

The movement points to that sale line through `sourceLineId`.

A new untracked sale line has explicit `unknown` inventory-cost provenance, not a fabricated value. Historical pre-5C lines remain `historical-unknown`.

## 10. Original-sale returns

A return never consults today's average/current cost pool to decide what basis comes back.

The original sale line is the authority. The return engine allocates the exact portion of the original sale-line basis attributable to the cumulative returned quantity. Repeated partial returns use cumulative prefix allocation, so the final return receives the exact residual value and the sum of all returned known value equals the original sale-line known value.

The allocated return basis is:

1. frozen on the `return_line`, and
2. passed as the trusted incoming basis of the return stock movement.

If the branch is negative when goods return, §8 deficit catch-up semantics apply atomically.

## 11. Transfers

A branch transfer remains one transaction with two stock legs.

The source outflow is valued by the source locked pool. Its exact movement basis is passed unchanged as the destination inflow basis. The transfer cannot create known quantity or known value.

If the destination is already negative, part of the incoming basis may be recognized as deficit catch-up rather than current inventory asset, but the source movement basis and destination movement evidence still reconcile exactly. No value is silently lost: any known value not retained as destination asset is preserved as immutable catch-up evidence.

Opposite-direction transfers retain the 5A canonical stock lock discipline. Cost rows are subordinate to already-locked stock rows and cannot introduce a second global lock order.

## 12. Purchase receipt valuation

A purchase order still moves no stock and carries no cost authority.

A receipt line may optionally state **one exact total inventory value for the accepted quantity**: `inventoryValueMinor`, as canonical non-negative minor-unit integer text.

This is not a unit price, supplier invoice, tax amount, or retail price. It is the total acquisition value that the merchant is explicitly establishing for the quantity physically accepted on that receipt line.

Rules:

- omitted value => accepted quantity enters with explicit `unknown` cost;
- present value => the accepted quantity enters as known cost with exactly that total value;
- the accepted quantity remains server-validated and over-receipt protected under the locked PO line;
- `inventoryValueMinor` is included in the canonical idempotency fingerprint;
- a replay returns the exact committed result snapshot;
- a caller may submit `inventoryValueMinor` only with both `purchasing.receive` and `inventory.cost.manage` authority;
- a caller with `purchasing.receive` only can still receive goods without value, preserving 5B separation of duties.

Receipt document, receipt-line evidence, PO accumulator/status, stock movement, stock balance/revision, cost pool/revision, valuation event, audit and idempotency snapshot all commit or roll back together.

## 13. Explicit prospective bootstrap

A separately permissioned `inventory.cost.manage` authority may establish known value for currently unknown **positive** stock.

The caller may state:

- branch,
- product,
- total value to assign,
- operation id,
- the observed stock revision,
- the observed cost revision,
- the observed unknown positive quantity.

The three observed facts are stale-read preconditions, not client authority.
The caller may **not** state the resulting quantity to value. Under stock and
cost row locks, the server derives:

`unknownPositiveQuantity = max(stockQuantity, 0) - knownQuantity`

The server compares both locked revisions and the derived unknown quantity with
the submitted observations before applying value. Any mismatch is
`cost-state-changed`: the idempotency reservation and every tentative write
roll back, the caller must refresh, and a new human decision receives a new
operation id. If there is no unknown positive quantity, the operation is
refused. Bootstrap does not move stock and does not increment stock revision.
It increments cost revision exactly once, updates the known-cost pool, appends
one immutable `bootstrap` valuation event, writes audit evidence and commits
the idempotency result atomically.

Same operation + same intent, including identical observation preconditions,
replays. Same operation + changed intent conflicts.

## 14. Permissions

- `inventory.cost.read`: view valuation facts/read models.
- `inventory.cost.manage`: establish prospective valuation through approved authority.

Cashier never receives either permission by default.

Receipt quantity authority remains `purchasing.receive`. Cost-bearing receipt input additionally requires `inventory.cost.manage`.

## 15. RLS / tenant isolation

`inventory_cost_balances` and `inventory_valuation_events` are tenant-owned commercial/financial data and must use `ENABLE RLS` + `FORCE RLS` with tenant policies.

All tenant references are composite where an entity identity crosses tables. Fresh database proof must run as `NOSUPERUSER NOBYPASSRLS`.

## 16. Required C0 proof

Strike 5C cannot close without evidence for all applicable release gates, including at minimum:

- exact integer remainder conservation,
- complete known-pool exhaustion with zero residual,
- mixed known/unknown outflow,
- permitted oversell with no fabricated cost,
- negative-stock deficit catch-up,
- sale-line basis freeze,
- repeated partial return restoring original basis exactly,
- transfer conservation including mixed basis and negative destination,
- receipt with known cost,
- receipt without known cost,
- receiving over-receipt concurrency,
- rollback after late failure leaving no stock/cost/document/idempotency residue,
- bootstrap idempotency and changed-intent conflict,
- stale bootstrap refusal after unknown inflow, outflow, known-cost receipt and
  sibling bootstrap, with no pool/evidence/audit/idempotency residue,
- fresh post-conflict decision and frozen same-observation ambiguous retry,
- bootstrap concurrency against sale/receipt/transfer,
- cross-tenant/RLS probes,
- forward migration from the 11-migration state,
- clean fresh database with exactly 12 migrations and drift none,
- `git diff --check`, dependency/audit gates, build, typecheck and tests,
- full `npm run verify` green,
- independent C0 review and Human Gate.

## 17. Closure discipline

Temporary implementation/materialization workflows or scripts are not product architecture and must be removed before Strike 5C closure.

No PASS is inferred from code existing. A gate is PASS only with evidence. Strike 5C remains open until every required C0 blocker is closed and independently reviewed.
