# ADR-0038 — Retail Packaging, Barcode and Contextual Price Authority

Status: **ACCEPTED FOR MASTERMIND V2-3**
Date: 2026-09-25
Strike: **V2-3 — Retail Packaging + Price Lists**
Branch: `mastermind/v2-strengthening`
Issue: **#76**

## Context

Korvi already has one tenant-owned Product identity, one stock/cost ledger in scaled product
quantity, multiple tenant-unique ProductBarcode rows, a current Product.priceMinor, ProductPrice
history, deterministic server-owned checkout pricing, immutable SaleLine financial/cost facts,
purchasing/receiving in base product quantity, and a durable offline catalogue/checkout queue.

Those primitives are real authority, but they do not yet establish grocery/wholesale packaging
or contextual price lists.

In particular:

- ProductBarcode can identify a Product but not a carton/pack selling unit;
- no package-to-base conversion authority exists;
- ProductPrice is base/current price history, not a retail/wholesale price-list engine;
- checkout uses one Product price and one product quantity for both commercial pricing and stock;
- SaleLine does not explain which package or contextual price authority was used;
- purchasing/receiving has only base product quantities;
- direct checkout does not own customer identity today, so customer-specific price selection
  cannot be truthfully activated by this strike.

V2-3 must extend these authorities without creating package stock, package costing, fractional
money, client-authored price, or a second barcode/product truth.

## Decision

### 1. Scope

V2-3 establishes shared Retail / Grocery / Wholesale authority for:

- fixed packages/cartons of unit products;
- package-aware use of the existing ProductBarcode authority;
- deterministic retail/wholesale price contexts;
- package-aware checkout, historical SaleLine snapshots and original-sale returns;
- package-aware purchasing/receiving;
- governed catalogue/price administration;
- cached operator intent and stale-price protection for the existing offline queue.

Weighted products remain sold by their existing base weighted quantity in V2-3. A future ADR may
define fixed pre-packed weighted goods if commercially required.

Customer-specific price-list assignment is architected as a future resolver seam only. It is not
an active V2-3 operator capability because current direct checkout deliberately persists
customerId = null.

No provider or paid external service is required.

### 2. One product/base stock truth

Product remains the stock and costing identity.

There is never:

- an inventory balance per package;
- a cost pool per package;
- a package Product shadow row;
- a separate package stock ledger.

Every package converts deterministically to one positive base Product quantity.

Inventory movements, costing, counts, transfers and valuation continue to use base product
quantity only.

### 3. Product package identity

A ProductPackage is tenant-owned commercial-unit metadata for one Product.

Required authoritative fields:

- package id;
- tenant id;
- product id;
- merchant code;
- Arabic/optional English name;
- unit label;
- baseQuantityScaled;
- active lifecycle flag;
- revision;
- created/updated facts.

V2-3 packages are allowed only for Product.productType = unit.

baseQuantityScaled:

- is positive;
- is a multiple of QUANTITY_SCALE (1000);
- states how many base product units one package represents.

Examples:

- base each: no package row, factor 1000;
- pack of 6: factor 6000;
- carton of 24: factor 24000.

Packages reference the base Product directly. Packages do not reference other packages, so there
is no conversion graph, cycle or cumulative rounding path.

The conversion factor is immutable after package creation. If commercial packaging changes from
12 to 24 units, the old package is deactivated and a new package identity is created. This
preserves cached/offline meaning and historical explainability.

Names/lifecycle may change under optimistic revision + audit; finalized transactions never read
them back for historical truth.

### 4. Barcode authority

V2-3 reuses ProductBarcode. No second barcode table is introduced.

ProductBarcode gains nullable packageId:

- packageId = null means the barcode identifies the base Product selling unit;
- packageId != null means the barcode identifies that exact ProductPackage.

The existing unique (tenantId, barcode) constraint remains the ambiguity authority: one scan
within one merchant resolves to at most one commercial selling unit.

Composite tenant/product/package references prove that a package barcode cannot point to a
package belonging to another Product or tenant.

Existing pre-V2-3 barcode rows remain base-unit barcodes with packageId = null.

isPrimary remains display/search metadata and never financial authority.

### 5. Commercial quantity versus inventory quantity

Package sales require two quantities because package price cannot safely be converted into a
fractional base-unit price.

For checkout/sale:

- commercialQuantityScaled = count of the selected selling unit, scaled by 1000;
- inventoryQuantityScaled = exact base Product quantity consumed;
- package sale requires whole commercial package counts;
- inventoryQuantityScaled =
  commercialQuantityScaled * package.baseQuantityScaled / QUANTITY_SCALE;
- base Product sale has factor QUANTITY_SCALE, therefore both quantities are identical.

Money is priced using commercial quantity and price per commercial selling unit.
Stock/cost uses inventory quantity.

No division of a package price into a base-unit price is allowed.

### 6. Price authorities

The existing Product.priceMinor remains the current default base-unit retail price.

ProductPrice remains base Product price history. V2-3 strengthens it as the history behind
Product.priceMinor rather than overloading it with contexts/packages.

Contextual price lists use separate tenant-owned authorities:

- PriceList;
- PriceListEntry.

PriceList required fields:

- id, tenant;
- merchant code/name;
- context: retail | wholesale;
- lifecycle: draft | active | paused | archived;
- revision;
- created/updated facts.

At most one active PriceList exists for a tenant/context.

PriceListEntry targets exactly one Product plus optional ProductPackage:

- packageId = null: base-product price in that list;
- packageId != null: exact package price in that list;
- priceMinor is integer minor units;
- entry revision/audit are explicit.

VAT is not a price-list field. Product VAT remains the canonical tax classification.

### 7. Deterministic price precedence

The client may request only a price context, never a price/list id or amount.

Direct checkout context defaults to retail.

For retail:

1. exact active retail list entry for selected package, if present;
2. active retail base-product entry multiplied by package factor, if present;
3. Product.priceMinor multiplied by package factor.

For a base Product, factor is one.

For wholesale:

1. exact active wholesale list entry for selected package;
2. active wholesale base-product entry multiplied by package factor;
3. otherwise REFUSE as price-context-incomplete.

Wholesale never silently falls back to retail.

The server selects the active list and proves the selected entry/revision under tenant scope.
The browser cannot select an arbitrary PriceList id.

### 8. Permissions

Package/barcode catalogue administration remains under product.write.

V2-3 adds:

- price-list.manage — configure contextual price policy;
- sale.price-context — explicitly select a non-default price context at checkout.

System manager/admin/owner receive both. System cashier does not receive them by default.
A merchant may later grant a custom role according to existing RBAC authority.

Applying the default retail context requires no extra price-context permission.

### 9. Checkout intent and authority

CheckoutLineInput gains optional packageId.

CheckoutInput gains priceContext, default retail.

The client may state:

- Product id;
- optional package id;
- commercial quantity;
- allowed price context.

The server derives/revalidates:

- package ownership/status/factor;
- inventoryQuantityScaled;
- price-list identity/status/revision;
- selected entry/fallback;
- unit price;
- VAT;
- stock sufficiency;
- final money.

Package/context identity participates in idempotency fingerprinting and pricing stale
preconditions.

Cart identity becomes (productId, packageId) within one sale price context. A base unit and carton
of the same Product are distinct commercial lines even though they consume one stock truth.

### 10. Immutable SaleLine truth

A finalized SaleLine continues to snapshot the canonical money/VAT/cost facts and additionally
records enough V2-3 provenance to explain the commercial sale without current catalogue policy:

- commercial quantity (existing quantityScaled semantics for new V2-3 lines);
- inventoryQuantityScaled;
- package id pointer, nullable;
- package code/name/unit label snapshot, nullable;
- packageBaseQuantityScaled, nullable/base factor;
- priceContext;
- pricing provenance:
  - product-base;
  - price-list-base;
  - price-list-package;
- selected PriceList id/code/revision when applicable.

unitPriceMinor is the price per commercial selling unit.

For legacy rows without inventoryQuantityScaled/package provenance, inventory quantity is treated
as equal to quantityScaled, preserving existing meaning.

Cost known/unknown quantity reconciliation is against inventoryQuantityScaled, not commercial
package count.

### 11. Original-sale returns

Returns never re-resolve package conversion or current price lists.

Return money continues to prorate from immutable original SaleLine financial truth.

For V2-3 lines:

- requested return quantity is commercial quantity;
- package returns must be whole package counts;
- base stock restored is derived only from the original immutable package/base quantity snapshot;
- ReturnLine snapshots the resulting inventoryQuantityScaled;
- cost restoration uses the original SaleLine cost basis and returned inventory proportion.

Changing/deactivating a current package or price list cannot change a historical return.

No-receipt exchange remains a product/base-policy authority under ADR-0036 and does not infer an
unknown historical package.

### 12. Purchasing and receiving

Purchasing may name an optional package when creating a PurchaseOrderLine.

The server snapshots:

- package id/code/unit label;
- packageBaseQuantityScaled;
- commercial ordered quantity;
- authoritative ordered base quantity.

The existing orderedQuantityScaled/receivedQuantityScaled stock accumulators remain base
quantities.

A V2-3 PurchaseOrderLine uses one commercial package selection for that Product line. The current
one-product-per-order-line invariant is retained; V2-3 does not add multiple package lines for the
same Product to one PO.

Receipt input continues to reference PurchaseOrderLine. For a package-backed line, accepted
quantity is commercial package quantity and must be whole packages; the server converts it using
the immutable PO-line package snapshot.

Stock/cost receiving still records only base quantity and trusted total inventory value.
Package purchase presentation never creates a second cost basis.

### 13. Base price history

V2-3 product price administration becomes a real governed update authority:

1. lock Product/current open ProductPrice;
2. validate expected revision/current price authority;
3. close the prior ProductPrice history row;
4. insert the new ProductPrice row;
5. update Product.priceMinor mirror;
6. audit;
7. commit atomically.

Only one open current ProductPrice history row may exist per tenant/Product.

For legacy Products lacking recorded price history, migration may create a legacy-current row
effective from migration time with explicit legacy provenance. It must not pretend to know when
that price historically began.

### 14. Price-list administration concurrency

Price-list/package policy mutation is tenant scoped, optimistic-revisioned and audited.

Activation/refusal rules are database-backed where practical:

- at most one active list per context;
- cross-tenant/product/package entries refused;
- archived policies do not become active by direct row manipulation;
- active list selection cannot race into two active authorities for one context.

Finalized sale snapshots make later list edits historically harmless.

### 15. Offline boundary

V2-3 must not weaken the existing ordinary offline sale path.

The durable catalogue is extended so a cached Product can carry the active package selling options
and server-resolved retail/wholesale price facts required by its supported contexts.

The existing limitation remains explicit: the browser cache contains products the terminal has
actually synchronized/seen; V2-3 does not falsely claim a complete merchant catalogue sync.

Offline cart/queue intent persists:

- package id;
- commercial quantity;
- selected price context;
- server-issued price-authority/stale precondition when one was available.

The client never persists an authoritative conversion or price that can force server acceptance.

Reconnect replays the same immutable commercial intent. The server re-resolves package/context and
may refuse stale/inactive/incomplete pricing rather than silently substituting another commercial
promise.

A future signed full-catalogue offline pricing snapshot may strengthen availability. V2-3 does not
invent a new trust model.

### 16. Migration compatibility

Existing data stays valid:

- Product remains base identity;
- existing ProductBarcode rows become base-unit barcodes (packageId null);
- existing Product.priceMinor remains current default retail authority;
- existing ProductPrice rows remain base price history;
- existing SaleLine/PurchaseOrderLine/PurchaseReceiptLine rows retain pre-V2-3 semantics through
  nullable/additive snapshot columns;
- existing product imports continue to create base Products and one base barcode.

V2-3 does not rewrite historical sale, return, receipt or cost facts to fabricate package
provenance.

Package/price-list bulk import may be added only through the Migration Engine with explicit mapping;
absence of such mapping does not cause heuristic package creation from SKU/barcode text.

### 17. ZATCA/tax boundary

Packages and price lists are commercial selection/conversion policy.

The existing pricing/VAT engine remains the only tax arithmetic authority.

The existing invoice/fiscalization path receives the finalized commercial line quantity,
commercial unit price, net/VAT/total and description snapshots.

Inventory quantity and package conversion are not separate tax documents.

Production ZATCA remains fail-closed exactly as before.

## Data model direction

V2-3 adds or extends:

- product_packages;
- product_barcodes.packageId (nullable extension of existing authority);
- price_lists;
- price_list_entries;
- additive package/context/inventory-quantity snapshots on sale_lines;
- additive package/base-quantity snapshots on purchase_order_lines and purchase_receipt_lines;
- explicit base-price history provenance/current-row guard where required.

No package inventory, package costing or duplicate product table is introduced.

## Implementation order

1. pure package conversion + price-resolution domain contract and adversarial/property tests;
2. schema/migration/FORCE-RLS/backward-compatibility guards;
3. package/barcode/price-list repositories and administration authority;
4. package-aware product search/read model;
5. server checkout preview + checkout integration;
6. immutable SaleLine provenance and original-sale return integration;
7. purchasing/receiving package integration;
8. offline catalogue/draft/queue integration;
9. Arabic RTL Control + Cashier UX;
10. PostgreSQL live RLS/concurrency/migration proof;
11. browser proof;
12. full CI;
13. exact-head governance reconciliation.

## Definition of Done

V2-3 is not complete until repository evidence proves:

- one base stock/cost truth under package sales/receipts;
- exact package conversion with no fractional money authority;
- unambiguous package-aware barcode resolution;
- deterministic retail/wholesale price precedence;
- wholesale missing-price refusal rather than retail fallback;
- negative price-context authorization;
- immutable package/price-list SaleLine snapshots;
- original-sale returns restore exact base stock/cost from historical snapshots;
- package-aware purchasing/receiving;
- backward-compatible legacy rows/migrations/imports;
- FORCE-RLS/cross-tenant isolation;
- optimistic/concurrent price-list administration safety;
- offline intent preservation/stale-price refusal;
- Arabic RTL operator workflow;
- PostgreSQL live proof;
- browser proof;
- full CI;
- exact-head evidence.

## Consequences

This ADR deliberately chooses flat packages and two proven checkout contexts over a broad unit-of-
measure graph or customer-pricing CRM layer.

Nested package graphs, weighted fixed packs, supplier-specific UOM conversion, arbitrary named
customer price lists and customer auto-assignment can build on these base/package and price-list
snapshots later, but may not bypass the one stock/cost truth or immutable sale provenance.
