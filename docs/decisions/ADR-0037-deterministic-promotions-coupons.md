# ADR-0037 — Deterministic Promotions and Coupon Authority

Status: **ACCEPTED FOR MASTERMIND V2-2**
Date: 2026-09-25
Strike: **V2-2 — Deterministic Promotions + Coupons Engine**
Branch: `mastermind/v2-strengthening`
Issue: **#75**

## Context

Korvi already owns deterministic integer-money pricing, line/basket manual discounts,
role-derived discount ceilings, immutable sale-line financial snapshots, atomic checkout,
idempotency, stock/cost truth and original-sale return proration.

Those primitives are necessary but they are not a promotion engine.

A promotion is merchant policy applied by the server. A coupon is an instrument that may
activate a promotion under bounded lifecycle/redemption rules. Neither is equivalent to a
cashier-authored manual discount, a tender, store credit or wallet balance.

V2-2 must extend the existing sale/pricing authority without creating a parallel money
engine and without letting the client decide eligibility, discount totals, tax impact or
redemption state.

## Decision

### 1. Scope

V2-2 establishes a shared deterministic promotion/coupon authority for direct Retail /
Grocery / Wholesale checkout.

Restaurant open-order settlement remains out of scope in this strike because the current
restaurant order authority snapshots price before settlement and deliberately refuses
checkout-time discounts. Promotions must not bypass that historical/order boundary.

No provider or paid external service is required.

### 2. Promotion identity and lifecycle

A promotion is tenant-owned policy with immutable identity and mutable versioned
configuration.

Required authoritative fields:

- tenant;
- promotion id;
- merchant-visible code/name;
- status: `draft | active | paused | archived`;
- activation mode: `automatic | coupon`;
- deterministic priority;
- stacking mode: `stackable | exclusive`;
- activation window;
- effect: fixed amount or percentage basis points;
- minimum eligible subtotal;
- target scope;
- revision;
- created/updated audit facts.

V2-2 target scope is deliberately bounded to:

- whole basket; or
- an explicit product allow-list.

Category/tag/segment predicates are future extensions and must not be inferred from
current mutable catalogue metadata for historical sales.

### 2A. Activation mode

Activation is explicit authority, not inferred from whether coupon rows happen to exist.

- `automatic`: the active promotion is considered for every eligible online direct checkout.
- `coupon`: the promotion is considered only when the server resolves a presented active coupon bound to it.

A coupon-mode promotion must never be auto-applied merely because it is active. An automatic
promotion may not be activated by a coupon in V2-2. Changing activation mode increments promotion
revision.

### 3. Coupon instrument

A coupon is not money.

A coupon is a tenant-owned activation instrument bound to exactly one promotion.

Canonical code rules:

- server normalizes by trim + uppercase;
- accepted alphabet is bounded ASCII `A-Z 0-9 -`;
- normalized code is unique per tenant;
- client never supplies promotion id as authority when redeeming a code.

Coupon lifecycle:

- `active | paused | retired`;
- optional activation/expiry window;
- optional total redemption limit;
- no mutable “remaining balance” semantics;
- no gift-card/wallet/store-credit behavior.

A usage limit is proven from immutable redemption facts. A denormalized count may be used
only as an optimization if it reconciles to the ledger; it is never sole financial truth.

### 4. Eligibility authority

The client may submit coupon code(s) and cart intent only.

The server derives:

- products;
- current prices;
- VAT;
- promotion definitions;
- promotion revision;
- coupon identity/status;
- active window;
- usage availability;
- eligible product set;
- eligible subtotal;
- resulting allocation.

No client-supplied:

- discount amount;
- promotion priority;
- eligibility flag;
- usage counter;
- revision;
- taxable base;
- VAT result

is authoritative.

### 5. Deterministic selection and stacking

Eligible promotions are evaluated from one server-authored snapshot.

Ordering is deterministic:

1. higher `priority` first;
2. lower immutable promotion id as tie-breaker.

If one or more eligible `exclusive` promotions exist, the first promotion under that
ordering is the only promotion applied.

Otherwise, eligible `stackable` promotions apply sequentially in the same ordering.

Each promotion applies to the remaining eligible base after earlier promotion allocations.
No step may discount below zero.

A bounded maximum number of applied promotions is enforced to keep execution and receipt
evidence finite.

### 6. Manual discount boundary

Manual discounts and promotion/coupon discounts are separate authorities.

In V2-2 a checkout that requests any manual line/basket discount while a promotion or
coupon is applied is refused.

This is intentional:

- manual discount is an operator act governed by `sale.discount` and the actor's role
  ceiling;
- promotion discount is merchant policy governed by promotion configuration;
- merging both into one discount figure would make authorization, audit and return
  explanation ambiguous.

A later ADR may define a governed composition rule. V2-2 does not guess one.

### 7. Pricing and VAT

Promotion allocation is integer money only.

Promotion effects are converted into exact per-line fixed allocations before VAT.

The existing pricing/VAT engine remains authoritative for:

- line totals;
- VAT extraction/addition;
- VAT buckets;
- invoice totals;
- fiscalization inputs.

Promotion logic may decide only the deterministic discount allocation supplied into that
engine; it does not implement a second VAT calculator.

For a fixed basket effect, largest-remainder allocation is used across eligible remaining
line bases.

For a percentage effect, the percentage discount is computed on the aggregate eligible
remaining base, then allocated with the same deterministic money-allocation primitive.
This avoids line-by-line rounding drift.

### 8. Sale historical truth

A finalized sale snapshots promotion truth.

The sale must preserve:

- promotion application id;
- promotion id;
- promotion revision;
- promotion merchant code/name;
- priority;
- stacking mode;
- effect kind/input value;
- eligible base;
- granted amount;
- coupon id/code snapshot when applicable;
- per-sale-line allocation.

The mutable current promotion row is never consulted to explain or refund a finalized
sale.

Existing manual `SaleDiscount` facts remain manual-discount facts and are not overloaded
to impersonate promotion applications.

### 9. Returns and refunds

Returns never re-evaluate today's promotion policy.

Original-sale return/refund authority continues to prorate from immutable original sale
line financial facts.

Because promotion allocation is frozen into the sale line's final discounted financial
snapshot, a return refunds the amount that was actually sold, not the promotion that would
apply today.

A return does not automatically restore coupon availability in V2-2. Redemption is a
historical fact. Any future coupon reissue/reversal policy requires an explicit ledger rule
and separate ADR.

### 10. Redemption concurrency

Coupon redemption and sale finalization are one transaction.

The transaction must:

1. lock/revalidate every coupon/promotion instrument used;
2. prove tenant, status, active window and expected revision;
3. prove usage limit under the lock;
4. persist the sale and immutable promotion snapshots;
5. persist coupon redemption fact(s);
6. persist audit;
7. commit or roll back as one unit.

Concurrent requests for the final available redemption must produce at most one successful
new redemption.

A retry of the same completed checkout operation converges on the same sale through the
existing checkout idempotency authority.

### 11. Tenant isolation and least privilege

Promotion, coupon, application and redemption tables are tenant-owned and FORCE-RLS.

Cross-tenant promotion/coupon references are blocked by composite tenant foreign keys.

Configuration permissions are separate from redemption:

- manager/admin/owner-class promotion administration permission;
- ordinary cashier does not need authority to edit promotions;
- applying an active automatic promotion or presenting a valid coupon is not itself a
  manual-discount permission grant.

### 12. Offline boundary

V2-2 promotion/coupon checkout is online-authoritative.

The existing offline sale path must not guess:

- whether a campaign is still active;
- whether a coupon has remaining uses;
- whether another till consumed the final redemption;
- whether promotion revision changed.

Therefore a sale requiring promotion/coupon evaluation cannot be newly finalized offline
in V2-2.

Plain checkout without promotion/coupon keeps its existing offline behavior.

A future offline promotion ADR may add signed/versioned policy snapshots and bounded
reservation semantics. V2-2 does not invent them.

### 13. Audit

At minimum audit captures:

- promotion/coupon create/update/status change;
- coupon redemption through finalized sale;
- promotion revision used by each finalized sale;
- actor for administrative mutations.

Normal checkout audit continues to represent the sale completion itself.

### 14. ZATCA boundary

Promotion/coupon logic is commercial pricing policy only.

The resulting finalized sale line net/VAT/total values flow through the existing invoice
and ZATCA fiscalization authority.

A coupon is not tender and does not create a payment, credit note, wallet or tax document
of its own.

Production ZATCA remains fail-closed exactly as before.

## Data model direction

The V2-2 persistence model uses separate authorities:

- `promotions`;
- `promotion_products`;
- `coupons`;
- `sale_promotion_applications`;
- `sale_promotion_allocations`;
- `coupon_redemptions`.

Promotion/coupon configuration is versioned/mutable under explicit admin authority.
Sale applications, allocations and redemptions are finalized business facts and append-only.

## Implementation order

1. pure domain promotion evaluator and adversarial tests;
2. persistence schema/migration + FORCE-RLS;
3. repository read/configuration and atomic redemption commit boundary;
4. checkout integration without duplicating pricing/VAT;
5. admin API/permissions/audit;
6. cashier coupon/operator UX;
7. PostgreSQL live concurrency/RLS proof;
8. Chrome browser proof;
9. full CI;
10. exact-head governance reconciliation.

## Definition of Done

V2-2 is not complete until repository evidence proves:

- deterministic selection, exclusivity and stacking;
- exact integer allocation and VAT reconciliation;
- manual-discount boundary;
- coupon normalization/lifecycle;
- final-redemption concurrency;
- replay/idempotency;
- immutable sale promotion snapshots;
- original-sale return behavior from historical sale truth only;
- FORCE-RLS and cross-tenant isolation;
- negative administration authorization;
- online/offline boundary;
- Arabic RTL operator workflow;
- PostgreSQL live proof;
- browser proof;
- full CI;
- exact-head evidence.

## Consequences

This ADR intentionally chooses a smaller but financially authoritative V2-2 over a broad
marketing-rules DSL.

Future eligibility predicates, customer segments, BOGO/bundles, loyalty coupling and
restaurant-order promotions may build on the same application/redemption snapshot model,
but they may not bypass it.
