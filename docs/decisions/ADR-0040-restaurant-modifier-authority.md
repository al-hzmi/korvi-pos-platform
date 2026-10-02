# ADR-0040 — Restaurant Modifier Authority

Status: Accepted for STRIKE V2-5  
Date: 2026-10-01  
Branch: `mastermind/v2-strengthening`

## Context

Korvi already has authoritative restaurant order snapshots, dine-in/takeaway/delivery,
zones/tables, table occupancy and transfer, preparation routing, KDS, recipes/BOM, production,
waste and canonical checkout settlement.

A restaurant order line also carries bounded free-text `preparationOptions`, but that field is
operational instruction only. It is not a governed menu-option or pricing authority.

Korvi has two valid restaurant sale paths today:

1. direct restaurant checkout without a durable `RestaurantOrder`; and
2. settlement of an existing server-authored open `RestaurantOrder`.

V2-5 must serve both paths through one modifier authority. Supporting modifiers only on open
orders would make quick takeaway checkout a weaker pricing path and would violate One Platform /
One Truth.

V2-5 therefore adds governed modifier policy and immutable modifier pricing history without
forking checkout, VAT, promotions, stock, cost, recipe or ZATCA truth.

## Decision

### 1. Modifier policy is merchant configuration

A modifier group defines:

- stable tenant-scoped identity and code;
- Arabic/English display name;
- minimum and maximum selections;
- deterministic display order;
- active lifecycle;
- optimistic revision.

A modifier option belongs to exactly one group and defines:

- stable tenant-scoped identity and code;
- Arabic/English display name;
- a non-negative integer per-unit price delta in halalas;
- deterministic display order;
- active lifecycle;
- optimistic revision.

Products are attached to modifier groups through an explicit tenant-scoped mapping. Groups may
be reused across products.

Configuration uses lifecycle and revisions. Physical deletion may not erase a policy object that
historical order/sale snapshots reference.

### 2. The client selects identities, never prices

For a restaurant line the client may submit selected modifier option IDs only.

The server must:

1. resolve the active groups attached to that Product;
2. resolve active options under those groups;
3. prove every selected option belongs to an active attached group;
4. prove every active attached group's min/max selection rule;
5. reject duplicate, unknown, inactive or out-of-policy selections;
6. deterministically order the accepted selections;
7. calculate the modifier delta using integer money only.

The client may never submit modifier names, price deltas, revisions, totals or tax facts as
authority.

### 3. One resolver serves direct checkout and open orders

The same deterministic modifier resolver is used for:

- direct restaurant checkout pricing; and
- RestaurantOrder create / editable-line replacement.

The resolver returns immutable policy facts: group/option identity, code, name, revision,
ordering and per-unit price delta.

An open-order settlement never re-runs current modifier policy. It consumes the exact
server-authored RestaurantOrderLine snapshot already accepted for that order revision.

A direct checkout resolves current modifier policy before finalization and snapshots the same
facts directly onto the finalized SaleLine.

### 4. Menu policy is serialized against authoritative pricing

Optimistic revision alone is not enough under PostgreSQL READ COMMITTED: group, option and
product-attachment rows could otherwise be read from different policy revisions while an
administrator changes menu configuration.

V2-5 therefore owns a tenant-scoped restaurant-menu policy lock:

`korvi:restaurant-menu-policy:<tenantId>`

- authoritative modifier resolution used for pricing takes the shared transaction lock;
- configuration insert/update/delete/attachment mutation takes the matching exclusive
  transaction lock;
- deterministic row ordering remains mandatory;
- administration retains optimistic revisions so stale human edits are refused explicitly.

No checkout/order transaction may commit a mixed-revision modifier policy snapshot.

### 5. Modifier effects are non-negative only

`priceDeltaMinor >= 0`.

Negative modifier deltas would create a second discount authority and overlap Korvi's governed
discount/promotion rules. They are deliberately outside this strike.

A zero-price option is valid and covers governed choices that do not change price.

### 6. Modifier price inherits the parent line VAT rate

V2-5 does not create independently taxed sub-lines.

For one commercial unit:

`unitPriceMinor = baseUnitPriceMinor + modifierTotalMinor`

The resulting unit price flows into the existing canonical cart/VAT engine. Modifier delta uses
the parent product's VAT rate; there is no modifier-specific tax engine.

### 7. RestaurantOrderLine owns editable operational history

A newly priced RestaurantOrderLine persists:

- `baseUnitPriceMinor`;
- `modifierTotalMinor`;
- final `unitPriceMinor`;
- exact selected modifier snapshots.

Each selection snapshot contains group/option identity, code, Arabic name, revision, ordering and
per-unit delta.

An unfired open-order line may change selections only through the governed replace-lines
authority. A retained line keeps its historical base product price while a newly requested
modifier set is resolved against current menu policy.

Once preparation has been fired for that line, quantity, preparation instructions and modifier
selection remain operational history and cannot be rewritten.

### 8. SaleLine is final financial history

Every finalized restaurant sale carrying modifiers persists the same financial decomposition:

- `baseUnitPriceMinor`;
- `modifierTotalMinor`;
- final `unitPriceMinor`;
- immutable SaleLine modifier-selection snapshots.

For direct checkout these facts come from the current locked modifier resolution.

For open-order settlement they are copied from the immutable RestaurantOrderLine snapshots under
the existing order revision/settlement lock; current menu policy is not consulted.

This keeps SaleLine the final sale/refund financial authority. A historical sale remains
explainable even if menu configuration changes later or the operational order is eventually
archived.

Returns continue from finalized SaleLine money/stock/cost facts and never re-evaluate current
modifier policy.

### 9. Preparation/KDS receives a server-authored modifier summary

The existing free-text `preparationOptions` remains a non-priced operator instruction field.

When a line is fired to preparation, Korvi snapshots a bounded server-authored modifier summary
from the governed line selections alongside the existing preparation note/options fields.

KDS never interprets free text as pricing authority.

### 10. Modifier options are not stock or recipe identities

Selecting a modifier does not directly mutate stock or cost in V2-5.

Recipe/BOM remains Korvi's ingredient authority. Modifier-dependent ingredient substitution,
extra ingredient quantities or recipe deltas require a later explicit architecture decision.
V2-5 must not infer them.

### 11. Configuration authority

A dedicated `restaurant.menu.manage` permission governs modifier configuration and is granted
to the default manager/admin/owner roles.

Cashiers may select configured options while operating restaurant sales/orders through existing
sale/order authority; that does not grant menu-administration authority.

### 12. Tenant isolation and immutable history

Every new tenant-owned row carries `tenantId`, composite tenant foreign keys and FORCE RLS.

Historical selection rows are immutable after their parent financial/operational fact is locked.
Configuration rows referenced by history cannot be physically deleted to erase provenance.

Existing historical rows migrate exactly:

- RestaurantOrderLine `baseUnitPriceMinor = unitPriceMinor`;
- RestaurantOrderLine `modifierTotalMinor = 0`;
- SaleLine `baseUnitPriceMinor = unitPriceMinor`;
- SaleLine `modifierTotalMinor = 0`;
- no historical modifier selection is invented.

### 13. Offline boundary

A browser/native client never becomes modifier pricing authority.

A newly captured direct restaurant sale that requires governed modifier selections may not be
accepted from an offline replay without a future explicitly signed policy-snapshot architecture.

Plain restaurant/retail behavior that does not require modifier policy keeps its existing
separate offline rules.

Open-order modifier workflows remain server-authoritative.

### 14. Promotions, retail packaging and ZATCA remain separate authorities

V2-5 does not reinterpret V2-2 or V2-3.

- modifiers establish the restaurant item's effective unit price before canonical downstream
  cart pricing;
- discounts/promotions remain their existing separate authorities;
- retail package/wholesale price-list authority remains inapplicable to restaurant order
  settlement as today;
- Production ZATCA receives only finalized ordinary sale/tax truth and gains no modifier-specific
  fiscal side channel.

## Deliberately deferred

V2-5 does not claim:

- meal/bundle composition;
- negative modifier pricing;
- modifier-specific VAT;
- modifier-driven ingredient/recipe consumption;
- seat-level split/merge;
- kiosk/QR/online ordering adapters;
- offline signed modifier-policy snapshots.

Courses and broader waiter/operator parity may be addressed only if repository audit identifies
a concrete authority gap after modifier flow is complete.

## Required evidence before V2-5 closure

- pure deterministic modifier-selection tests for min/max, duplicates, unknown/inactive,
  unattached options, zero-price, positive deltas, ordering, overflow and negative refusal;
- valid forward-only migration rehearsal and schema invariants;
- FORCE-RLS / cross-tenant negative proof;
- live PostgreSQL menu-policy shared/exclusive lock and mixed-revision concurrency proof;
- negative authorization for `restaurant.menu.manage`;
- direct restaurant checkout modifier pricing + SaleLine immutable snapshot proof;
- RestaurantOrder create/replace modifier snapshot proof;
- fired-line modifier mutation refusal;
- KDS server-authored modifier summary proof;
- open-order settlement copies historical modifier facts without current-policy re-evaluation;
- original-sale return remains exact after menu policy changes;
- offline modifier-required direct checkout fail-closed proof;
- actual Chrome Control configuration + Cashier modifier selection + direct sale + open-order/KDS
  - settlement proof;
- exact-head CI, PostgreSQL, browser and installed-client regression gates;
- Gap Audit + Current Source of Truth reconciliation only after exact-head proof.

## Implementation checkpoint (2026-10-02)

The domain modifier evaluator, forward-only database schema and transaction-scoped
menu-policy read helper now exist. The read helper acquires the tenant's shared menu-policy
lock and derives modifier prices from server-loaded product/group/option policy.
Focused resolver unit proofs have been added.

This checkpoint is not V2-5 acceptance. Modifier configuration, direct checkout and
open-order writes must still be connected to the same commit-time authority; sale and
order-line selection snapshots, KDS, offline refusal and the live evidence above
must be verified before enabling merchant modifier configuration or declaring V2-5 complete.
