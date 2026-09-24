# KORVI — MASTERMIND V2-0 CURRENT REPOSITORY GAP AUDIT

Status: **INITIAL REPOSITORY-GROUNDED AUDIT**
Date: 2026-09-24
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

### No-receipt return/exchange — ABSENT / ACCEPTED

The Master Product Directive explicitly treats this as a separately governed accepted capability.

The current return engine is sale-referenced by design. The audited return authority requires original sale/line facts.

No separate no-receipt/exchange domain, DB authority, route or cashier workflow was found in the current tree.

**Recommended first C0 strike: V2-1.**

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

## 10. V2-1 architecture discovery targets

Before any implementation, Mastermind must inspect and reconcile:

- ADR-0016 return semantics;
- current return domain/proration;
- ReturnRepository transaction/number/idempotency/stock/drawer authority;
- current permission catalogue;
- sale/return audit model;
- pricing/VAT modes;
- stock receiving/adjustment provenance;
- refund/tender authority;
- ZATCA credit-note boundary;
- cashier return workflow;
- historical product snapshots.

No-receipt return must not pretend to have historical sale price/tax evidence that does not exist.

The architecture must explicitly decide whether the merchant policy supports:

- refund at current/authorized reference price;
- exchange/store credit only;
- inventory disposition;
- tax-document treatment;
- manager override;
- fraud/risk controls.

Until those facts are defined, implementation is blocked.
