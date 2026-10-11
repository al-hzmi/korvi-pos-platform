-- V2-5 forward-only alignment: restaurant_order_lines must reflect the
-- nullable commercial-unit/provenance snapshot fields already declared by
-- RestaurantOrderLine in schema.prisma. The original open-orders migration
-- predates retail packaging; retail packaging extended sale_lines but NOT
-- restaurant_order_lines. An ORM SELECT on an empty order set still selects
-- every model column and failed with PostgreSQL 42703.
--
-- Do not fabricate packaging, inventory conversion or price-list history for
-- preexisting restaurant orders. NULL = unknown/legacy; order settlement
-- continues to use quantityScaled where inventoryQuantityScaled is NULL.
BEGIN;

ALTER TABLE "restaurant_order_lines"
  ADD COLUMN "inventoryQuantityScaled" BIGINT,
  ADD COLUMN "packageCode" TEXT,
  ADD COLUMN "packageNameAr" TEXT,
  ADD COLUMN "packageUnitLabel" TEXT,
  ADD COLUMN "packageBaseQuantityScaled" BIGINT,
  ADD COLUMN "priceContext" TEXT,
  ADD COLUMN "pricingProvenance" TEXT,
  ADD COLUMN "priceListCode" TEXT,
  ADD COLUMN "priceListRevision" BIGINT;

ALTER TABLE "restaurant_order_lines"
  ADD CONSTRAINT "restaurant_order_lines_inventory_quantity_positive"
    CHECK ("inventoryQuantityScaled" IS NULL OR "inventoryQuantityScaled" > 0),
  ADD CONSTRAINT "restaurant_order_lines_package_base_quantity_positive"
    CHECK (
      "packageBaseQuantityScaled" IS NULL
      OR ("packageBaseQuantityScaled" > 1000 AND MOD("packageBaseQuantityScaled", 1000) = 0)
    ),
  ADD CONSTRAINT "restaurant_order_lines_price_context_valid"
    CHECK ("priceContext" IS NULL OR "priceContext" IN ('retail', 'wholesale')),
  ADD CONSTRAINT "restaurant_order_lines_pricing_provenance_valid"
    CHECK (
      "pricingProvenance" IS NULL
      OR "pricingProvenance" IN ('product-base', 'price-list-base', 'price-list-package')
    ),
  ADD CONSTRAINT "restaurant_order_lines_price_list_revision_positive"
    CHECK ("priceListRevision" IS NULL OR "priceListRevision" > 0);

-- All nine additions remain nullable: never rewrite an existing row to
-- imply a historical package, inventory conversion or price-policy revision.
-- Existing FORCE RLS, FKs, modifier reconciliation and immutable sale
-- history are unchanged.
COMMIT;
