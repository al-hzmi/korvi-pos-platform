# ADR-0036 — No-Receipt Return / Exchange Authority

Status: **ACCEPTED FOR MASTERMIND V2 IMPLEMENTATION**
Program: Mastermind V2-1
Date: 2026-09-24

Builds on:

- ADR-0002 financial arithmetic;
- ADR-0004 tenant isolation/RLS;
- ADR-0013 transactional authority;
- ADR-0015 tender/settlement authority;
- ADR-0016 original-sale returns/refunds;
- ADR-0017 shift close/reconciliation;
- ADR-0024 inventory/purchasing authority.

## 1. Context

Korvi currently has a mature original-sale return/refund engine.

That engine is deliberately sale-linked:

- original sale snapshot is price/tax authority;
- cumulative proration returns exact historical money facts;
- stock reversal is proven from the original sale's inventory effect;
- return/refund writes are one commercial transaction;
- the sale row serializes concurrent returns.

A customer without a receipt provides none of those facts.

Therefore a no-receipt return **cannot** be implemented by passing a current product row into the existing return engine and pretending it is the historical sale.

That would fabricate:

- original price;
- original VAT treatment;
- original discount;
- original tender;
- original stock movement;
- original cost provenance.

The Master Product Directive accepts no-receipt return/exchange as a separately governed capability. It must therefore have a separate authority and separate semantics.

## 2. Decision

### 2.1 A no-receipt operation is not an original-sale refund

Korvi introduces a distinct commercial operation:

**Unreceipted Return / Exchange Case**

It records a merchant-authorized customer-service decision about goods presented without provable sale history.

It does **not**:

- identify or reconstruct an original sale;
- issue an original-sale refund;
- claim historical VAT/discount/tender facts;
- create a ZATCA credit note merely because goods were accepted;
- mutate an existing sale/invoice.

Original-sale returns remain unchanged under ADR-0016.

### 2.2 Initial safe commercial scope

V2-1 will support a conservative first scope:

1. known Korvi catalogue products only;
2. positive bounded quantity;
3. manager-or-higher explicit permission;
4. accepted goods may be returned to sellable inventory only when the product tracks inventory;
5. the inventory intake carries **unknown cost provenance** unless an independent authoritative cost fact is available;
6. compensation is **exchange-only** in the initial release;
7. no cash refund;
8. no residual customer balance;
9. no gift card/store-credit balance;
10. no tax-credit-note claim.

The exchange value may be used only against a linked replacement sale whose amount due is at least the exchange allowance.

No cash change may be produced from the exchange allowance.

If the replacement sale is smaller than the approved allowance, the operation is refused rather than silently forfeiting or creating a residual balance.

### 2.3 Why exchange-only first

Cash refund without original-sale evidence creates a materially different accounting/risk/compliance problem.

Persistent store credit creates an explicit customer financial ledger, which belongs to the accepted Loyalty/Credit program and must not be smuggled in as a mutable balance.

Exchange-only allows Korvi to provide the operational capability while keeping:

- original-sale tax history untouched;
- cash drawer truth intact;
- no residual liability;
- no invented historical facts.

A later ADR may add cash compensation or persistent credit only after its accounting/regulatory and ledger authority are explicit.

## 3. Authority model

### 3.1 Permission

Add a dedicated permission:

`sale.exchange.no-receipt`

Default roles:

- cashier — no;
- manager — yes;
- admin — yes;
- owner — yes.

Do not reuse `sale.refund` as the sole authority. No-receipt exchange is a different and higher-risk act.

### 3.2 Product identity

The server resolves products inside the authenticated tenant.

Client-supplied:

- productId may identify intent;
- tenantId is never authority;
- price/VAT/cost/stock facts are never accepted from the client.

Unknown/free-text products are out of V2-1 scope.

### 3.3 Exchange allowance

The server snapshots current catalogue reference facts at approval time.

These facts are explicitly named **current policy reference facts**, not historical sale facts.

For each accepted line store at least:

- product id;
- SKU;
- Arabic/English name snapshot;
- product type;
- quantity;
- current unit reference price;
- current VAT basis points as a descriptive snapshot;
- current track-inventory flag;
- approved allowance amount.

The current VAT snapshot does not turn the intake case into a tax credit note.

### 3.4 Allowance ceiling

The default server ceiling is the current product reference total for the accepted quantity.

A manager may approve an allowance from 0 up to that ceiling.

The server never accepts an allowance above the computed ceiling.

Future merchant policy configuration may tighten the ceiling; it may not bypass the server maximum without a separately reviewed product decision.

### 3.5 Replacement sale

The allowance is consumed only by a linked replacement sale.

The replacement sale:

- is a normal new sale;
- carries its own current pricing/VAT facts;
- remains immutable after finalization;
- must be at least the allowance amount;
- may collect the remaining amount through normal cash/electronic tenders.

The exchange allowance is a dedicated bounded settlement component linked to the no-receipt case.

It is not a general reusable tender and cannot be supplied by an arbitrary client without server proof of the case.

## 4. Transaction model

The authoritative commit must be atomic across:

1. no-receipt case finalization;
2. accepted lines;
3. inventory intake movements where applicable;
4. exchange allowance consumption;
5. replacement sale finalization;
6. normal replacement-sale stock decrement;
7. cash/electronic tenders for any remaining due;
8. audit events;
9. idempotency result.

A crash may not leave:

- stock accepted without the linked finalized case;
- an allowance consumed without a sale;
- a sale finalized without consuming the allowance;
- a case finalized twice.

Implementation may refactor repository internals to permit composition inside one PostgreSQL transaction, but it may not create a second sale arithmetic engine.

## 5. Inventory truth

### 5.1 Intake

For a tracked product accepted as sellable:

- create a causal stock movement of type/reason dedicated to unreceipted exchange intake;
- increment authoritative branch stock;
- increment balance revision;
- preserve exact quantity scale.

### 5.2 Cost

Because no sale/receipt/purchase provenance proves the returned item's historical cost:

- accepted intake quantity enters as unknown cost provenance;
- never copy current product cost as though it were historical acquisition cost;
- never record zero as known cost.

This must integrate with existing known/unknown costing conservation.

### 5.3 Non-tracked products

No inventory movement is created when the snapshotted product did not track inventory at approval time.

The case still records the goods/customer-service event.

## 6. Pricing and tax truth

The no-receipt case has an allowance value, not a reconstructed historical refund.

The replacement sale calculates price/VAT under the normal current sale authority.

The exchange allowance must be represented in sale settlement/accounting semantics without rewriting line VAT or pretending the original transaction is known.

No ZATCA credit note is emitted solely from the unreceipted intake case.

Any future official regulatory treatment is a separate Compliance decision and must remain fail-closed if external authority is required.

## 7. Shift and drawer

A V2-1 exchange requires an open usable shift/terminal under the same server-authoritative rules as sale checkout.

The exchange allowance itself does not move physical cash.

Only real cash tenders/change on the replacement sale affect the drawer.

No-receipt V2-1 never pays cash out of the drawer.

## 8. Idempotency and concurrency

Use a dedicated operation scope such as:

`no-receipt-exchange`

Fingerprint material intent including:

- terminal;
- accepted product lines/quantities;
- approved line/total allowance;
- replacement cart intent;
- real tenders;
- merchant reason code.

Exclude server-derived facts.

The same operation ID + same intent replays the completed result.

Same ID + different intent is refused.

Inventory rows/balances and any sequence authority must be locked in deterministic order consistent with current inventory/sale doctrines.

## 9. Numbering and document identity

The no-receipt case receives its own per-branch document series, distinct from:

- sale receipt/invoice number;
- original-sale return number.

Recommended display:

`NR-<BRANCH>-<000001>`

This prevents a no-receipt case from being mistaken for a tax invoice or original-sale return.

## 10. Audit and risk evidence

Every committed case records:

- actor;
- branch;
- terminal;
- shift;
- UTC time;
- reason code;
- optional bounded note;
- accepted lines;
- reference-price snapshots;
- approved allowance;
- linked replacement sale;
- stock effect summary;
- idempotency operation.

Recommended reason vocabulary is closed/bounded, for example:

- customer-no-receipt;
- gift-return;
- receipt-unavailable;
- manager-exception;
- other.

Free-text note is supplemental, never the authority.

## 11. UI

Arabic-first cashier workflow:

1. choose **استبدال بدون فاتورة**;
2. manager authorization if current actor lacks permission;
3. scan/search returned product;
4. enter quantity;
5. show clearly:
   - no original invoice found/used;
   - current policy reference price;
   - maximum exchange allowance;
6. manager approves allowance;
7. build replacement basket;
8. require replacement sale >= allowance;
9. collect remaining due through normal tenders;
10. final confirmation summarizes:
    - returned items;
    - exchange allowance;
    - replacement sale;
    - additional amount paid;
    - inventory effect;
11. commit atomically.

The UI must never label the allowance as "refund of original invoice".

## 12. Offline behavior

V2-1 is **online-authoritative initially**.

Reason:

- high-risk manager exception;
- atomic composition across return intake + replacement sale + inventory;
- no existing bounded offline authority for this new operation.

Offline UI must state that no-receipt exchange requires connection.

A later offline capability requires a separate architecture proving bounded authorization, durable local state, conflict behavior and replay safety.

## 13. Data model direction

New tables/entities should be additive and tenant-scoped.

Expected logical entities:

- `no_receipt_exchange_cases`
- `no_receipt_exchange_lines`

Required database properties:

- tenant-consistent composite foreign keys;
- ENABLE + FORCE RLS;
- positive/bounded quantity;
- non-negative allowance;
- unique per-tenant operation ID;
- unique branch sequence/document number;
- immutable finalized status;
- linked replacement sale exactly once;
- no cross-tenant linkage.

The exact migration shape is implementation work and must follow forward-only migration rules.

## 14. Negative/adversarial tests

Must prove at minimum:

- cashier without permission refused;
- merchant admin cannot acquire Platform authority through route fields;
- cross-tenant product/case/sale IDs refused/non-enumerating;
- client-supplied price/VAT/allowance ceiling ignored/refused;
- allowance above server ceiling refused;
- replacement sale below allowance refused;
- exchange allowance cannot give change;
- no cash refund path exists;
- duplicate operation replays exactly;
- same operation/different intent conflicts;
- concurrent stock updates preserve revisions;
- unknown-cost provenance preserved;
- untracked product creates no stock movement;
- shift/terminal/branch mismatch refused;
- finalized case cannot be edited/reused;
- allowance cannot be consumed twice;
- failure rolls back case + stock + sale together.

## 15. Out of scope

Not part of V2-1:

- cash refund without receipt;
- persistent store credit;
- gift-card balance;
- loyalty points;
- free-text unknown products;
- damaged/quarantine warehouse workflow;
- ZATCA credit-note generation for unknown sale;
- offline no-receipt exchange;
- provider/PSP calls.

These are not forgotten. They require their own explicit authorities.

## 16. Definition of done

V2-1 closes only when:

- this ADR is implemented without weakening ADR-0016;
- forward-only migration exists;
- domain authority and tests exist;
- PostgreSQL transaction/RLS/concurrency proof exists;
- permission migration/provisioning proof exists;
- API negative/adversarial tests exist;
- Arabic cashier workflow exists;
- browser proof exists;
- full CI is green on exact V2-1 head;
- independent diff/evidence review passes.

No agent report alone closes the strike.
