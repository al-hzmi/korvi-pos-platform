-- Korvi POS — open restaurant order authority.
-- These rows are operational, non-fiscal evidence. Price/tax/product fields on
-- lines are server-authored catalogue snapshots; opening an order creates no
-- invoice, stock movement, tender, tax submission or accounting entry.

BEGIN;

CREATE UNIQUE INDEX "restaurant_tables_tenantId_branchId_id_key"
  ON "restaurant_tables"("tenantId", "branchId", "id");

CREATE TABLE "restaurant_orders" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tableId" UUID,
  "orderType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "priceMode" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "openedAt" TIMESTAMPTZ NOT NULL,
  "closedAt" TIMESTAMPTZ,
  "closedReason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "restaurant_orders_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_orders_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_orders_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_orders_tenantId_userId_fkey"
    FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_orders_tenantId_tableId_fkey"
    FOREIGN KEY ("tenantId", "tableId") REFERENCES "restaurant_tables"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_orders_tenantId_branchId_tableId_fkey"
    FOREIGN KEY ("tenantId", "branchId", "tableId")
    REFERENCES "restaurant_tables"("tenantId", "branchId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "restaurant_orders_type_valid"
    CHECK ("orderType" IN ('dine-in', 'takeaway', 'delivery')),
  CONSTRAINT "restaurant_orders_table_semantics"
    CHECK (
      ("orderType" = 'dine-in' AND "tableId" IS NOT NULL)
      OR ("orderType" IN ('takeaway', 'delivery') AND "tableId" IS NULL)
    ),
  CONSTRAINT "restaurant_orders_status_valid"
    CHECK ("status" IN ('open', 'cancelled', 'settled')),
  CONSTRAINT "restaurant_orders_revision_positive" CHECK ("revision" >= 1),
  CONSTRAINT "restaurant_orders_price_mode_valid"
    CHECK ("priceMode" IN ('tax-inclusive', 'tax-exclusive')),
  CONSTRAINT "restaurant_orders_currency_isoish"
    CHECK ("currency" = btrim("currency") AND char_length("currency") = 3),
  CONSTRAINT "restaurant_orders_lifecycle_consistent"
    CHECK (
      ("status" = 'open' AND "closedAt" IS NULL AND "closedReason" IS NULL)
      OR ("status" = 'cancelled' AND "closedAt" IS NOT NULL AND "closedReason" IS NOT NULL)
      OR ("status" = 'settled' AND "closedAt" IS NOT NULL AND "closedReason" IS NULL)
    ),
  CONSTRAINT "restaurant_orders_closed_reason_bounded"
    CHECK (
      "closedReason" IS NULL
      OR ("closedReason" = btrim("closedReason") AND char_length("closedReason") BETWEEN 1 AND 200)
    )
);

CREATE UNIQUE INDEX "restaurant_orders_tenantId_id_key"
  ON "restaurant_orders"("tenantId", "id");
CREATE INDEX "restaurant_orders_tenantId_branchId_status_openedAt_idx"
  ON "restaurant_orders"("tenantId", "branchId", "status", "openedAt");
CREATE INDEX "restaurant_orders_tenantId_tableId_status_idx"
  ON "restaurant_orders"("tenantId", "tableId", "status");
CREATE INDEX "restaurant_orders_tenantId_terminalId_status_idx"
  ON "restaurant_orders"("tenantId", "terminalId", "status");

CREATE UNIQUE INDEX "restaurant_orders_one_open_table_key"
  ON "restaurant_orders"("tenantId", "tableId")
  WHERE "status" = 'open' AND "tableId" IS NOT NULL;

CREATE TABLE "restaurant_order_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "productType" TEXT NOT NULL,
  "unitPriceMinor" BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "preparationNote" TEXT,
  "preparationOptions" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_order_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_order_lines_tenantId_orderId_fkey"
    FOREIGN KEY ("tenantId", "orderId") REFERENCES "restaurant_orders"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_order_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "restaurant_order_lines_line_number_positive" CHECK ("lineNumber" >= 1),
  CONSTRAINT "restaurant_order_lines_product_type_valid"
    CHECK ("productType" IN ('unit', 'weighted')),
  CONSTRAINT "restaurant_order_lines_price_nonnegative" CHECK ("unitPriceMinor" >= 0),
  CONSTRAINT "restaurant_order_lines_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "restaurant_order_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "restaurant_order_lines_unit_whole"
    CHECK ("productType" <> 'unit' OR MOD("quantityScaled", 1000) = 0),
  CONSTRAINT "restaurant_order_lines_note_bounded"
    CHECK ("preparationNote" IS NULL OR char_length("preparationNote") BETWEEN 1 AND 500),
  CONSTRAINT "restaurant_order_lines_options_bounded"
    CHECK ("preparationOptions" IS NULL OR char_length("preparationOptions") BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX "restaurant_order_lines_tenantId_id_key"
  ON "restaurant_order_lines"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_order_lines_tenantId_orderId_lineNumber_key"
  ON "restaurant_order_lines"("tenantId", "orderId", "lineNumber");
CREATE INDEX "restaurant_order_lines_tenantId_orderId_idx"
  ON "restaurant_order_lines"("tenantId", "orderId");
CREATE INDEX "restaurant_order_lines_tenantId_productId_idx"
  ON "restaurant_order_lines"("tenantId", "productId");

ALTER TABLE "restaurant_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_orders_isolation" ON "restaurant_orders";
CREATE POLICY "restaurant_orders_isolation" ON "restaurant_orders"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_order_lines_isolation" ON "restaurant_order_lines";
CREATE POLICY "restaurant_order_lines_isolation" ON "restaurant_order_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
