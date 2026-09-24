# KORVI — MASTERMIND V2-0 CURRENT REPOSITORY GAP AUDIT

Status: **UPDATED REPOSITORY-GROUNDED AUDIT — V2-1 CLOSED**
Date: 2026-09-25
Branch: `mastermind/v2-strengthening`
Base acquisition SHA: `61dbb34dea08809756fd767b907b0e852b7e5978`

## Audit law

This document does not reuse the historical 88/100 score.

It classifies selected high-value accepted capabilities from the current repository state.

Legend:

- **PRESENT** — repository contains current product/domain/database/operator implementation evidence.
- **PARTIAL** — foundations exist, but accepted capability is not complete.
- **ABSENT / ACCEPTED** — product constitution accepts it, but no current implementation authority was found in the audited surfaces.
- **EXTERNAL** — depends on real provider/merchant/transaction activation.

## 1. Returns / refunds

### Original-sale return/refund — PRESENT

Current evidence includes:

- ADR-0016;
- domain return/proration authority;
- API return service/routes/tests;
- PostgreSQL return repository/migration/live proof;
- cashier return workflow.

Key current law:

- original sale snapshot is pricing/tax authority;
- cumulative proration preserves exact historical totals;
- return serializes on the sale transaction boundary;
- stock reversal is based on original sale stock effect;
- refund is cash or recorded electronic approval reference;
- cardholder data is refused.

### No-receipt return/exchange — PRESENT / V2-1 CLOSED

V2-1 is now a separate authority from original-sale returns.

Repository evidence includes:

- ADR-0036 no-receipt return/exchange contract;
- deterministic current-policy valuation domain and unit tests;
- dedicated `sale.exchange.no-receipt` permission;
- explicit internal `exchange_allowance` tender boundary;
- PostgreSQL case/line persistence, FORCE-RLS, immutability, idempotency and deterministic locking;
- canonical stock/cost intake with unknown cost provenance;
- atomic reuse of the canonical sale authority for replacement merchandise;
- strict API schemas that reject client-authored price/VAT/cost/ceiling/allowance-tender facts;
- negative authorization and tenant-isolation tests;
- live PostgreSQL concurrency/rollback/replay/immutability proof;
- Arabic RTL online-only cashier workflow;
- actual Chrome operator proof.

Scope law:

- no original sale fact is inferred;
- no cash refund is issued from this capability;
- no store-credit counter/balance was invented;
- current catalogue facts are policy inputs only, never historical evidence;
- accepted tracked stock returns as sellable with historical cost **unknown**;
- replacement sale tax/fiscalization remains the ordinary sale authority;
- no synthetic credit note or original invoice provenance exists;
- V2-1 is Retail scope and is deliberately online-authoritative.

Verified implementation HEAD:

`a1d640f3b3d30faf4c4c04e90c1c5fa04412971a`

Evidence:

- CI `36070419973` — **SUCCESS**;
- PostgreSQL 17 / RLS live proof `36070419982` — **SUCCESS**;
- Chrome cashier proof `36070420015` — **SUCCESS**;
- independent PR CI `36070424151` — **SUCCESS**.

**V2-1 gap is closed. Next strike: V2-2.**

## 2. Promotions / coupons

### Discount authority — PRESENT FOUNDATION

Current repository includes deterministic discount authority/tests under pricing/sale.

### General promotion engine — PARTIAL / ACCEPTED

No dedicated promotion/coupon/voucher domain or persistence model was found in the audited tree/schema.

The accepted product scope requires:

- eligibility;
- priority;
- exclusivity;
- stacking;
- deterministic allocation;
- tax/refund snapshots;
- explainability;
- coupons/vouchers.

Current discount authority should be reused as a primitive, not replaced.

**Recommended V2-2.**

## 3. Loyalty / customer financial instruments

### Loyalty ledger/rewards — ABSENT / ACCEPTED

No loyalty domain/module was found in the current domain export tree.

### Gift card / wallet — ABSENT / ACCEPTED

No dedicated explicit-value ledger authority found.

### Customer credit/balance — NOT CLOSED

Schema contains limited uses of the word "credit", but no audited dedicated customer-credit ledger authority was found.

The constitution requires these to exist only as explicit financial ledgers.

**Do not build mutable counters.**

Recommended after promotion/retail parity foundations.

## 4. Batch / lot / expiry

### Batch/lot/expiry inventory authority — ABSENT / ACCEPTED

No dedicated batch/lot/expiry domain/persistence implementation was found in the audited source tree.

The only filename match discovered outside schema wording was acquisition/pilot documentation.

The Master Product Directive explicitly accepts batch/lot/expiry where required.

**Recommended V2-4.**

## 5. Retail / grocery packaging and price lists

### Core product/catalog/inventory — PRESENT

Current product/catalogue, migration, inventory, purchasing and costing authorities are substantial.

### Unit/carton/packaging hierarchy — NOT FOUND AS CLOSED AUTHORITY

No dedicated packaging/carton model was identified in current schema/path audit.

### Retail/wholesale/customer/context price-list engine — NOT FOUND AS CLOSED AUTHORITY

No dedicated `PriceList` schema authority was found.

These remain accepted Retail/Grocery parity requirements.

**Recommended V2-3.**

## 6. Restaurant

### Current strong foundations — PRESENT

Current source contains:

- restaurant order context;
- dine-in/takeaway/delivery order type;
- floor zones/tables;
- table occupancy/transfer authority;
- open orders;
- settlement;
- preparation routing;
- KDS;
- recipe/BOM;
- production;
- waste;
- server-authored order line snapshots.

### Modifiers/options — PARTIAL

Current restaurant order lines include bounded `preparationOptions` text, but no dedicated Modifier domain/schema authority was found.

This is not equivalent to a governed modifier/options/bundle pricing engine.

### Dining modes — PRESENT FOUNDATION

`dine-in | takeaway | delivery` exists in current order authority.

### Tables/zones — PRESENT FOUNDATION

Current DB/order/UI paths include restaurant table/zone support.

### Broader waiter/kiosk/QR/online/delivery adapters — ACCEPTED, NOT CLOSED

These remain later product scope.

**Recommended V2-5 for modifiers/operator parity before kiosk/QR.**

## 7. Attention / intelligence layer

No dedicated current Attention Center, Explainable Reorder, Expiry Intelligence, Branch Rebalancing or Watchdog authority was identified in this initial path audit.

These remain accepted Korvi Advantage engines.

They should consume trusted domain facts and recommend/explain; they must not become transactional authority.

## 8. External/provider-dependent scope

Still external/deferred:

- Production ZATCA activation;
- real PSP acquiring adapters;
- real delivery platform connections;
- real Salla/Zid activation;
- production monitoring/provider evidence;
- real merchant production pilot.

Adapter architecture may advance internally, but no provider-dependent production claim may be fabricated.

## 9. Priority decision

Initial evidence supports this order:

1. **V2-1 No-receipt return/exchange**
2. **V2-2 Deterministic promotions/coupons**
3. **V2-3 Retail packaging + price lists**
4. **V2-4 Batch/lot/expiry**
5. **V2-5 Restaurant modifiers/operator parity**
6. **V2-6 Loyalty/credit explicit ledgers**
7. **V2-7 Attention Center**
8. **V2-8 Explainable Reorder / Expiry Intelligence**
9. **V2-9 Omnichannel adapter contracts**
10. **V2-10 Kiosk/QR/customer display**

## 10. V2-1 closure reconciliation

The V2-1 discovery targets were reconciled in ADR-0036 and the implementation at
`a1d640f3b3d30faf4c4c04e90c1c5fa04412971a`.

Resolved decisions:

- original-sale return semantics remain owned by ADR-0016 and are not reused when historical evidence is absent;
- no-receipt scope is exchange-only;
- current-policy reference value is bounded and explicitly non-historical;
- cash refund/store credit are outside V2-1;
- stock disposition is sellable for accepted tracked products;
- missing historical cost enters costing as unknown;
- manager-class permission, reason/evidence, audit and immutable snapshots govern abuse risk;
- operation-id fingerprinting owns replay/conflict behavior;
- PostgreSQL owns tenant isolation and transaction/concurrency truth;
- offline execution is prohibited in this strike;
- tax/ZATCA authority belongs only to the new replacement sale, never to invented historical provenance.

The former implementation block is therefore removed.

## 11. Next audit target — V2-2

The next repository audit must begin from the existing deterministic discount/sale/return primitives and establish an architecture contract for:

- promotion eligibility;
- priority and exclusivity;
- stacking;
- deterministic allocation;
- VAT interaction;
- immutable sale snapshots;
- return/refund treatment of promotion allocations;
- coupon/voucher identity, lifecycle and redemption idempotency;
- tenant isolation, concurrency, permissions and audit;
- offline/replay semantics.

No coupon UI should precede the shared deterministic authority.
