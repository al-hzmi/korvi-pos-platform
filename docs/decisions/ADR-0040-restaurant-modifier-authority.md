# ADR-0040 — Restaurant Modifier Authority

Status: Accepted for STRIKE V2-5 foundation  
Date: 2026-10-01  
Branch: `mastermind/v2-strengthening`

## Context

Korvi already has authoritative restaurant order snapshots, dining modes, tables/zones,
preparation routing, KDS, recipes, production and waste. A restaurant order line currently
also carries bounded free-text `preparationOptions`, but that text is operational instruction
only. It is not a governed menu-option or pricing authority.

V2-5 closes that gap without forking checkout, tax, stock or recipe truth.

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
- a non-negative integer price delta in halalas;
- deterministic display order;
- active lifecycle;
- optimistic revision.

Products are attached to modifier groups through an explicit tenant-scoped mapping. Groups may
be reused across products.

### 2. The client selects identities, never prices

The operator may submit selected modifier option IDs for a restaurant order line.

The server must:

1. resolve the groups attached to that product;
2. resolve active options;
3. prove every selected option belongs to an active attached group;
4. prove every active group's min/max selection rule;
5. reject duplicate, unknown, inactive or out-of-policy selections;
6. calculate the modifier delta using integer money only.

The client may never submit modifier names, price deltas, revisions, totals or tax facts as
authority.

### 3. V2-5 modifier effects are non-negative only

`priceDeltaMinor >= 0`.

Negative modifier deltas would create a second discount authority and overlap Korvi's governed
discount/promotion rules. They are deliberately outside this strike.

A zero-price option is valid and covers instructions such as size/preparation choices that do
not change price.

### 4. Modifier price inherits the parent line tax rate

V2-5 does not create independently taxed sub-lines. The modifier delta is part of the
restaurant item's final unit price and therefore uses the parent product's VAT rate.

### 5. Restaurant order line owns the historical price snapshot

For a newly priced restaurant line:

`unitPriceMinor = baseUnitPriceMinor + modifierTotalMinor`

The order line persists all three values.

Each selected option is persisted as an immutable snapshot containing the group/option identity,
code, name, revision, price delta and ordering facts used at that moment.

Checkout continues to consume the server-authored open-order line snapshot. It must not
re-evaluate current modifier policy when the order settles.

Returns continue from the finalized SaleLine financial truth; current modifier configuration is
never replayed to explain a historical refund.

### 6. Preparation/KDS receives a server-authored modifier summary

The existing free-text `preparationOptions` remains a legacy/operator instruction field and is
not priced.

When a line is fired to preparation, Korvi snapshots a bounded server-authored modifier summary
alongside the existing note/options fields so the kitchen sees the governed selections.

Once a line has been fired, changing its modifier selections is forbidden by the same historical
operational rule that already freezes quantity and preparation instructions.

### 7. Modifier options are not stock or recipe identities

Selecting a modifier does not directly mutate stock or cost in V2-5.

Recipe/BOM remains Korvi's ingredient authority. Modifier-dependent recipe substitution or
ingredient deltas require a later explicit architecture decision; V2-5 must not infer them.

### 8. Configuration authority

A dedicated `restaurant.menu.manage` permission governs modifier configuration and is granted
to the default manager/admin/owner roles. Cashiers may select configured options while operating
orders through `sale.create`; that does not grant menu-administration authority.

### 9. Tenant isolation and history

All new tenant-owned rows carry `tenantId`, composite tenant foreign keys and FORCE RLS.

Existing restaurant order rows migrate with:

- `baseUnitPriceMinor = unitPriceMinor`;
- `modifierTotalMinor = 0`;
- no modifier selections.

Historical migrations are never rewritten.

## Deliberately deferred

V2-5 modifier foundation does not yet claim:

- meal/bundle composition;
- negative modifier pricing;
- modifier-specific VAT;
- modifier-driven ingredient/recipe consumption;
- courses or seat-level split/merge;
- kiosk/QR/online ordering adapters.

Those capabilities must compose with this authority rather than bypass it.

## Required evidence before V2-5 closure

- pure deterministic modifier-selection tests;
- schema/RLS/tenant-isolation tests;
- live PostgreSQL configuration and order-snapshot proof;
- negative authorization for menu administration;
- optimistic revision/concurrency proof for configuration;
- actual Chrome Control configuration + cashier selection + open-order/KDS + settlement proof;
- exact-head CI and installed-client regression gates.
