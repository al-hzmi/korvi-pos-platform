# ADR-0022 — Product Bootstrap Authority

**Status:** Accepted for Strike 4D-4  
**Date:** 2026-08-16

## Decision

Korvi exposes one authenticated merchant catalogue write at `POST /v1/admin/products` so a newly established Owner can satisfy onboarding's evidence-derived `active-product` check without database access, seeded demo data, or a persisted onboarding-complete flag.

The route requires the existing `product.write` permission. Tenant identity and actor identity come only from the authenticated principal. The request may describe catalogue data; it may not name a tenant, actor, active state, inventory quantity, price-history row, lifecycle state, role or permission.

## Exact representations

Money crosses HTTP and the domain as a decimal string of integer minor units and is stored as PostgreSQL `BIGINT`. No float or decimal arithmetic is introduced.

VAT is an integer number of basis points and is validated by the existing `BasisPoints` domain type. If the request omits VAT, the authority uses the tenant's persisted `defaultVatBasisPoints` while holding the settings row with `FOR SHARE`.

SKU, names, unit label and barcode are NFKC-normalised and bounded before persistence. SKU is canonicalised to upper case. A price such as `1.5`, `1e3`, `01`, a negative value, or an over-bounded integer is refused rather than coerced.

## Atomic write

One tenant-scoped transaction writes:

1. the active `products` row;
2. the optional primary `product_barcodes` row;
3. the initial immutable `product_prices` history row;
4. the `product.created` audit event.

Any refusal rolls all four back.

SKU and barcode races are decided by PostgreSQL unique constraints with `ON CONFLICT DO NOTHING`, not by a preflight SELECT. A concurrent loser is reported as `sku-taken` or `barcode-taken` and leaves no partial product.

## Tenant settings are authority

The request cannot set `trackInventory`. The new product inherits the tenant's persisted `trackInventory` setting.

If `requireBarcode` is true, a product without a barcode is refused. If `allowWeightedItems` is false, a weighted product is refused. These are checked against the settings row inside the same transaction that writes the product.

## Onboarding semantics

The authority does not set onboarding state. `readTenantOnboardingReadiness` continues to derive `active-product` from current catalogue truth. Creating an active product makes that evidence true; a later catalogue change may make it false again.

`active-product` is configuration readiness, not a promise that inventory is currently available. A tracked product may legitimately have zero stock before receiving inventory. Inventory receipt, purchasing and stock-opening authority remain later phases and are not fabricated here.

## Out of scope

Strike 4D-4 does **not** add:

- inventory balances or movements;
- purchasing, suppliers or receiving;
- category CRUD;
- price editing or closing a previous price-history row;
- product deactivation/editing;
- images;
- bulk import;
- global catalogue writes;
- persisted onboarding completion.

Those require their own authority and invariants. This strike creates only the minimum real catalogue truth required to remove the onboarding dead end.

## Release evidence

The strike must prove at minimum:

- anonymous and `product.read`-only callers cannot write;
- tenant/actor/activation/inventory authority fields are rejected;
- money remains an integer string end to end;
- VAT defaults and overrides remain integer basis points;
- barcode-required and weighted-item settings are enforced;
- Product + barcode + price history + audit commit atomically;
- duplicate barcode rollback leaves no product behind;
- concurrent duplicate SKU creation yields exactly one product;
- RLS and tenant-scoped uniqueness still hold;
- onboarding's `active-product` evidence changes from false to true from the real row;
- full Korvi verification remains green.
