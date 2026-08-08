-- Korvi POS — Strike 2A: SaaS foundation.
--
-- Forward only. This migration creates the new tables and extends Row-Level
-- Security to every one of them. It drops nothing and rewrites no data: the
-- Phase 0 tables (tenants, products, global_catalog_items) already exist, so
-- the new columns are added rather than the tables recreated.
--
-- The tenancy model is unchanged from ADR-0004. `current_tenant_id()` reads
-- `app.tenant_id`, which `withTenant()` establishes with SET LOCAL inside the
-- transaction. That is the single tenancy mechanism; nothing here introduces a
-- weaker second one.
--
-- Every tenant-owned table below gets ENABLE + FORCE and one policy carrying
-- both USING and WITH CHECK. FORCE is the part usually missed: without it the
-- table owner bypasses every policy, and the application role is very often
-- the owner. USING alone would govern reads only, leaving an UPDATE free to
-- reassign a visible row to another tenant.
--
-- Tenant-consistent foreign keys
-- -----------------------------
-- RLS protects a row. It does not protect a *reference*: a sale owned by
-- tenant A, visible only to A, could still name a branch owned by tenant B,
-- because a plain foreign key to branches(id) proves the branch exists and
-- nothing else. The result reads correctly to A — right up to the point where
-- a report joins through it.
--
-- Every tenant-owned parent therefore carries a unique key on
-- ("tenantId", "id"), and every child references that pair rather than the id
-- alone. The child's own "tenantId" appears on both sides of the reference, so
-- PostgreSQL rejects a cross-tenant parent at INSERT and at UPDATE, without a
-- trigger, a check function, or anything the application can forget.
--
-- The cost is the delete action on the nullable references. ON DELETE SET NULL
-- would null every column of the composite key, "tenantId" included, and that
-- column is NOT NULL. Those references therefore refuse the delete instead of
-- nulling it: the column stays nullable, but a category, customer, product,
-- invoice or user that is still referenced cannot be deleted. For records a
-- tax authority may ask about that is the better answer anyway, and every one
-- of these tables carries an isActive flag for what the merchant usually means.
--
-- The refusing action is NO ACTION rather than RESTRICT, and the difference
-- matters exactly once: deleting a tenant. RESTRICT is checked immediately, so
-- it fires even when the referencing row is being deleted by the same
-- statement — which is precisely what tenant offboarding does, cascading from
-- tenants into all 29 tables at once. NO ACTION defers the check to the end of
-- the statement, so a dangling reference is still an error and a wholesale
-- cascade still succeeds.
--
-- Reference to a global table (permissions, global_catalog_items) stays a
-- single-column key: those rows have no tenant to be consistent with.

-- ---------------------------------------------------------------------------
-- Phase 0 tables: additive changes only
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" TEXT;
UPDATE "tenants" SET "slug" = "id"::text WHERE "slug" IS NULL;
ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "categoryId" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT 'unit';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unitLabel" TEXT NOT NULL DEFAULT 'each';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "trackInventory" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
-- The single `barcode` column becomes the product_barcodes table; the column is
-- kept so existing rows are not lost, and is migrated by application tooling.
CREATE INDEX IF NOT EXISTS "products_tenantId_isActive_idx" ON "products"("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS "products_tenantId_nameAr_idx" ON "products"("tenantId", "nameAr");
-- The tenant-consistency key on the Phase 0 catalogue table. Every child that
-- points at a product points at (tenantId, id), so a barcode, a price row or a
-- sale line cannot name a product belonging to another merchant.
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenantId_id_key" ON "products"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "products_tenantId_categoryId_idx" ON "products"("tenantId", "categoryId");

ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_tenantId_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

CREATE TABLE "branches" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "branches_tenantId_id_key" ON "branches"("tenantId", "id");
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches"("tenantId", "code");
CREATE INDEX "branches_tenantId_isActive_idx" ON "branches"("tenantId", "isActive");

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "passwordHash" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");
CREATE INDEX "users_tenantId_isActive_idx" ON "users"("tenantId", "isActive");

CREATE TABLE "tenant_memberships" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "defaultBranchId" UUID,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_memberships_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_memberships_tenantId_defaultBranchId_fkey" FOREIGN KEY ("tenantId", "defaultBranchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tenant_memberships_tenantId_userId_key" ON "tenant_memberships"("tenantId", "userId");
CREATE INDEX "tenant_memberships_tenantId_status_idx" ON "tenant_memberships"("tenantId", "status");

CREATE TABLE "permissions" (
  "key" TEXT PRIMARY KEY,
  "descriptionAr" TEXT NOT NULL,
  "descriptionEn" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "roles" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "maxDiscountBasisPoints" INTEGER NOT NULL DEFAULT 0,
  "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "roles_max_discount_range"
    CHECK ("maxDiscountBasisPoints" >= 0 AND "maxDiscountBasisPoints" <= 10000),
  CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roles_tenantId_id_key" ON "roles"("tenantId", "id");
CREATE UNIQUE INDEX "roles_tenantId_key_key" ON "roles"("tenantId", "key");

CREATE TABLE "role_permissions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "permissionKey" TEXT NOT NULL,
  CONSTRAINT "role_permissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "role_permissions_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "role_permissions_tenantId_roleId_permissionKey_key"
  ON "role_permissions"("tenantId", "roleId", "permissionKey");
CREATE INDEX "role_permissions_tenantId_roleId_idx" ON "role_permissions"("tenantId", "roleId");

CREATE TABLE "user_roles" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  CONSTRAINT "user_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_roles_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_roles_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_roles_tenantId_userId_roleId_key" ON "user_roles"("tenantId", "userId", "roleId");
CREATE INDEX "user_roles_tenantId_userId_idx" ON "user_roles"("tenantId", "userId");

CREATE TABLE "terminals" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "deviceKey" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "terminals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "terminals_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "terminals_tenantId_id_key" ON "terminals"("tenantId", "id");
CREATE UNIQUE INDEX "terminals_tenantId_code_key" ON "terminals"("tenantId", "code");
CREATE INDEX "terminals_tenantId_branchId_isActive_idx" ON "terminals"("tenantId", "branchId", "isActive");

CREATE TABLE "tenant_settings" (
  "tenantId" UUID PRIMARY KEY,
  "vertical" TEXT NOT NULL DEFAULT 'retail',
  "priceMode" TEXT NOT NULL DEFAULT 'tax-inclusive',
  "defaultVatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "enableProductImages" BOOLEAN NOT NULL DEFAULT FALSE,
  "requireBarcode" BOOLEAN NOT NULL DEFAULT TRUE,
  "allowWeightedItems" BOOLEAN NOT NULL DEFAULT FALSE,
  "trackInventory" BOOLEAN NOT NULL DEFAULT TRUE,
  "allowNegativeStock" BOOLEAN NOT NULL DEFAULT FALSE,
  "receiptHeaderAr" TEXT,
  "receiptFooterAr" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_settings_vat_range"
    CHECK ("defaultVatBasisPoints" >= 0 AND "defaultVatBasisPoints" <= 10000),
  CONSTRAINT "tenant_settings_price_mode"
    CHECK ("priceMode" IN ('tax-inclusive', 'tax-exclusive')),
  CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "categories" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "categories_tenantId_id_key" ON "categories"("tenantId", "id");
CREATE UNIQUE INDEX "categories_tenantId_nameAr_key" ON "categories"("tenantId", "nameAr");
CREATE INDEX "categories_tenantId_isActive_sortOrder_idx" ON "categories"("tenantId", "isActive", "sortOrder");

ALTER TABLE "products"
  ADD CONSTRAINT "products_tenantId_categoryId_fkey"
  FOREIGN KEY ("tenantId", "categoryId") REFERENCES "categories"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "products"
  ADD CONSTRAINT "products_product_type"
  CHECK ("productType" IN ('unit', 'weighted'));

CREATE TABLE "product_barcodes" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "barcode" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_barcodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_barcodes_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Unique within a tenant, not globally: two merchants may legitimately carry
-- the same EAN, and a global constraint would block the second onboarding.
CREATE UNIQUE INDEX "product_barcodes_tenantId_barcode_key" ON "product_barcodes"("tenantId", "barcode");
CREATE INDEX "product_barcodes_tenantId_productId_idx" ON "product_barcodes"("tenantId", "productId");

CREATE TABLE "product_prices" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "priceMinor" BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_prices_non_negative" CHECK ("priceMinor" >= 0),
  CONSTRAINT "product_prices_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "product_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_prices_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_prices_tenantId_productId_effectiveFrom_idx"
  ON "product_prices"("tenantId", "productId", "effectiveFrom");

-- The natural key is the primary key: there is exactly one balance per
-- (tenant, branch, product), and giving the row a surrogate id would invite a
-- second balance for the same product to exist without violating anything.
CREATE TABLE "inventory_balances" (
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("tenantId", "branchId", "productId"),
  CONSTRAINT "inventory_balances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_balances_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_balances_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "inventory_balances_tenantId_branchId_idx" ON "inventory_balances"("tenantId", "branchId");

CREATE TABLE "inventory_movements" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "reason" TEXT,
  "sourceType" TEXT,
  "sourceId" UUID,
  "actorUserId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_movements_kind"
    CHECK ("kind" IN ('sale', 'return', 'adjustment', 'receipt', 'transfer')),
  CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_movements_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_movements_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "inventory_movements_tenantId_branchId_productId_occurredAt_idx"
  ON "inventory_movements"("tenantId", "branchId", "productId", "occurredAt");
CREATE INDEX "inventory_movements_tenantId_sourceType_sourceId_idx"
  ON "inventory_movements"("tenantId", "sourceType", "sourceId");

CREATE TABLE "customers" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "vatNumber" VARCHAR(15),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");
CREATE UNIQUE INDEX "customers_tenantId_phone_key" ON "customers"("tenantId", "phone");
CREATE INDEX "customers_tenantId_isActive_idx" ON "customers"("tenantId", "isActive");
CREATE INDEX "customers_tenantId_nameAr_idx" ON "customers"("tenantId", "nameAr");

CREATE TABLE "shifts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "openingFloatMinor" BIGINT NOT NULL,
  "declaredCashMinor" BIGINT,
  "expectedCashMinor" BIGINT,
  "varianceMinor" BIGINT,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shifts_status" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "shifts_opening_float_non_negative" CHECK ("openingFloatMinor" >= 0),
  CONSTRAINT "shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_terminalId_fkey" FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "shifts_tenantId_id_key" ON "shifts"("tenantId", "id");
CREATE INDEX "shifts_tenantId_branchId_status_idx" ON "shifts"("tenantId", "branchId", "status");
CREATE INDEX "shifts_tenantId_terminalId_status_idx" ON "shifts"("tenantId", "terminalId", "status");
CREATE INDEX "shifts_tenantId_openedAt_idx" ON "shifts"("tenantId", "openedAt");

CREATE TABLE "cash_movements" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reason" TEXT,
  "actorUserId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_movements_kind"
    CHECK ("kind" IN ('sale', 'refund', 'pay-in', 'pay-out', 'opening-float')),
  -- The sign carries meaning, and the domain enforces the same rule.
  CONSTRAINT "cash_movements_sign" CHECK (
    ("kind" IN ('sale', 'pay-in') AND "amountMinor" >= 0) OR
    ("kind" IN ('refund', 'pay-out') AND "amountMinor" <= 0) OR
    ("kind" = 'opening-float')
  ),
  CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cash_movements_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "cash_movements_tenantId_shiftId_occurredAt_idx"
  ON "cash_movements"("tenantId", "shiftId", "occurredAt");

CREATE TABLE "sales" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "customerId" UUID,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "sequence" INTEGER NOT NULL,
  "priceMode" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "grossMinor" BIGINT NOT NULL,
  "lineDiscountMinor" BIGINT NOT NULL,
  "basketDiscountMinor" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "tenderedMinor" BIGINT NOT NULL,
  "changeMinor" BIGINT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_status" CHECK ("status" IN ('finalized', 'voided')),
  CONSTRAINT "sales_price_mode" CHECK ("priceMode" IN ('tax-inclusive', 'tax-exclusive')),
  CONSTRAINT "sales_total_positive" CHECK ("totalMinor" > 0),
  -- The reconciliation invariant, enforced by the database as well as the
  -- domain: net + vat = total, and tendered - change = total.
  CONSTRAINT "sales_reconciles" CHECK (
    "netMinor" + "vatMinor" = "totalMinor" AND
    "tenderedMinor" - "changeMinor" = "totalMinor"
  ),
  CONSTRAINT "sales_change_non_negative" CHECK ("changeMinor" >= 0),
  CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_terminalId_fkey" FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sales_tenantId_id_key" ON "sales"("tenantId", "id");
CREATE UNIQUE INDEX "sales_tenantId_operationId_key" ON "sales"("tenantId", "operationId");
CREATE UNIQUE INDEX "sales_tenantId_branchId_sequence_key" ON "sales"("tenantId", "branchId", "sequence");
CREATE INDEX "sales_tenantId_branchId_issuedAt_idx" ON "sales"("tenantId", "branchId", "issuedAt");
CREATE INDEX "sales_tenantId_shiftId_idx" ON "sales"("tenantId", "shiftId");
CREATE INDEX "sales_tenantId_status_issuedAt_idx" ON "sales"("tenantId", "status", "issuedAt");
CREATE INDEX "sales_tenantId_customerId_idx" ON "sales"("tenantId", "customerId");

CREATE TABLE "sale_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "productId" UUID,
  "lineNumber" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "unitPriceMinor" BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "lineDiscountMinor" BIGINT NOT NULL,
  "basketDiscountMinor" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  CONSTRAINT "sale_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "sale_lines_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "sale_lines_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "sale_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_lines_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sale_lines_tenantId_id_key" ON "sale_lines"("tenantId", "id");
CREATE UNIQUE INDEX "sale_lines_tenantId_saleId_lineNumber_key"
  ON "sale_lines"("tenantId", "saleId", "lineNumber");
CREATE INDEX "sale_lines_tenantId_saleId_idx" ON "sale_lines"("tenantId", "saleId");
CREATE INDEX "sale_lines_tenantId_productId_idx" ON "sale_lines"("tenantId", "productId");

CREATE TABLE "sale_discounts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "lineNumber" INTEGER,
  "kind" TEXT NOT NULL,
  "inputValue" BIGINT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reason" TEXT,
  "grantedByUserId" UUID,
  CONSTRAINT "sale_discounts_scope" CHECK ("scope" IN ('line', 'basket')),
  CONSTRAINT "sale_discounts_kind" CHECK ("kind" IN ('fixed', 'percentage')),
  CONSTRAINT "sale_discounts_non_negative" CHECK ("amountMinor" >= 0),
  CONSTRAINT "sale_discounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_discounts_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sale_discounts_tenantId_saleId_idx" ON "sale_discounts"("tenantId", "saleId");

CREATE TABLE "tenders" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "changeMinor" BIGINT NOT NULL DEFAULT 0,
  "reference" TEXT,
  CONSTRAINT "tenders_kind" CHECK ("kind" IN ('cash', 'card', 'mada', 'transfer')),
  CONSTRAINT "tenders_amount_non_negative" CHECK ("amountMinor" >= 0),
  -- Only cash returns change. A card terminal has no mechanism to hand money
  -- back, so a non-zero change on a non-cash tender is a data error.
  CONSTRAINT "tenders_change_cash_only" CHECK ("changeMinor" = 0 OR "kind" = 'cash'),
  CONSTRAINT "tenders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenders_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tenders_tenantId_saleId_idx" ON "tenders"("tenantId", "saleId");
CREATE INDEX "tenders_tenantId_kind_idx" ON "tenders"("tenantId", "kind");

CREATE TABLE "invoices" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL UNIQUE,
  "invoiceNumber" TEXT NOT NULL,
  "invoiceType" TEXT NOT NULL DEFAULT 'simplified',
  "sellerName" TEXT NOT NULL,
  "sellerVatNumber" VARCHAR(15) NOT NULL,
  "buyerName" TEXT,
  "buyerVatNumber" VARCHAR(15),
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_type" CHECK ("invoiceType" IN ('simplified', 'standard')),
  CONSTRAINT "invoices_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoices_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoices_tenantId_id_key" ON "invoices"("tenantId", "id");
CREATE UNIQUE INDEX "invoices_tenantId_saleId_key" ON "invoices"("tenantId", "saleId");
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNumber_key" ON "invoices"("tenantId", "invoiceNumber");
CREATE INDEX "invoices_tenantId_issuedAt_idx" ON "invoices"("tenantId", "issuedAt");

CREATE TABLE "invoice_tax_breakdown" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  CONSTRAINT "invoice_tax_breakdown_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "invoice_tax_breakdown_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoice_tax_breakdown_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoice_tax_breakdown_tenantId_invoiceId_vatBasisPoints_key"
  ON "invoice_tax_breakdown"("tenantId", "invoiceId", "vatBasisPoints");
CREATE INDEX "invoice_tax_breakdown_tenantId_invoiceId_idx"
  ON "invoice_tax_breakdown"("tenantId", "invoiceId");

CREATE TABLE "returns" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "reason" TEXT,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "actorUserId" UUID NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "returns_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "returns_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "returns_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "returns_tenantId_id_key" ON "returns"("tenantId", "id");
CREATE UNIQUE INDEX "returns_tenantId_operationId_key" ON "returns"("tenantId", "operationId");
CREATE INDEX "returns_tenantId_saleId_idx" ON "returns"("tenantId", "saleId");
CREATE INDEX "returns_tenantId_issuedAt_idx" ON "returns"("tenantId", "issuedAt");

CREATE TABLE "return_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "returnId" UUID NOT NULL,
  "saleLineId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  CONSTRAINT "return_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "return_lines_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "return_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_lines_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_lines_tenantId_saleLineId_fkey" FOREIGN KEY ("tenantId", "saleLineId") REFERENCES "sale_lines"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "return_lines_tenantId_returnId_idx" ON "return_lines"("tenantId", "returnId");
CREATE INDEX "return_lines_tenantId_saleLineId_idx" ON "return_lines"("tenantId", "saleLineId");

CREATE TABLE "refunds" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "returnId" UUID NOT NULL,
  "invoiceId" UUID,
  "method" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reference" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refunds_method" CHECK ("method" IN ('cash', 'card', 'mada', 'transfer')),
  CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0),
  CONSTRAINT "refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "refunds_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "refunds_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "refunds_tenantId_returnId_idx" ON "refunds"("tenantId", "returnId");

CREATE TABLE "idempotency_keys" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "resultType" TEXT,
  "resultId" UUID,
  "requestHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "idempotency_keys_status"
    CHECK ("status" IN ('reserved', 'completed', 'failed')),
  CONSTRAINT "idempotency_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The reservation identity. A retry of the same operation collides here rather
-- than creating a second sale.
CREATE UNIQUE INDEX "idempotency_keys_tenantId_scope_operationId_key"
  ON "idempotency_keys"("tenantId", "scope", "operationId");
CREATE INDEX "idempotency_keys_tenantId_status_idx" ON "idempotency_keys"("tenantId", "status");
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

CREATE TABLE "audit_events" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "actorUserId" UUID,
  "branchId" UUID,
  "terminalId" UUID,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_events_tenantId_actorUserId_fkey" FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt");
CREATE INDEX "audit_events_tenantId_entityType_entityId_idx" ON "audit_events"("tenantId", "entityType", "entityId");
CREATE INDEX "audit_events_tenantId_eventType_occurredAt_idx"
  ON "audit_events"("tenantId", "eventType", "occurredAt");

-- ---------------------------------------------------------------------------
-- Row-Level Security — deny by default on every tenant-owned table
-- ---------------------------------------------------------------------------
--
-- Each policy is dropped and recreated rather than created blindly. `tenants`
-- and `products` already carry a policy from the Phase 0 migration, and
-- PostgreSQL has no CREATE POLICY ... IF NOT EXISTS, so a bare CREATE would
-- abort this migration on any database that has already run Phase 0.
--
-- Recreating also means the policy body is whatever this file says, rather
-- than whatever happens to be there. If the migration were interrupted between
-- the drop and the create, the table would be left with RLS enabled and no
-- policy — which denies everything. That is the safe direction to fail.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenants_isolation" ON "tenants";
CREATE POLICY "tenants_isolation" ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branches_isolation" ON "branches";
CREATE POLICY "branches_isolation" ON "branches"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_isolation" ON "users";
CREATE POLICY "users_isolation" ON "users"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_memberships_isolation" ON "tenant_memberships";
CREATE POLICY "tenant_memberships_isolation" ON "tenant_memberships"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "roles_isolation" ON "roles";
CREATE POLICY "roles_isolation" ON "roles"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions_isolation" ON "role_permissions";
CREATE POLICY "role_permissions_isolation" ON "role_permissions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_roles_isolation" ON "user_roles";
CREATE POLICY "user_roles_isolation" ON "user_roles"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "terminals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terminals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "terminals_isolation" ON "terminals";
CREATE POLICY "terminals_isolation" ON "terminals"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_settings_isolation" ON "tenant_settings";
CREATE POLICY "tenant_settings_isolation" ON "tenant_settings"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "categories_isolation" ON "categories";
CREATE POLICY "categories_isolation" ON "categories"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "products_isolation" ON "products";
CREATE POLICY "products_isolation" ON "products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "product_barcodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_barcodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_barcodes_isolation" ON "product_barcodes";
CREATE POLICY "product_barcodes_isolation" ON "product_barcodes"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "product_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_prices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_prices_isolation" ON "product_prices";
CREATE POLICY "product_prices_isolation" ON "product_prices"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_balances_isolation" ON "inventory_balances";
CREATE POLICY "inventory_balances_isolation" ON "inventory_balances"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_movements_isolation" ON "inventory_movements";
CREATE POLICY "inventory_movements_isolation" ON "inventory_movements"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers_isolation" ON "customers";
CREATE POLICY "customers_isolation" ON "customers"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "shifts_isolation" ON "shifts";
CREATE POLICY "shifts_isolation" ON "shifts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cash_movements_isolation" ON "cash_movements";
CREATE POLICY "cash_movements_isolation" ON "cash_movements"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_isolation" ON "sales";
CREATE POLICY "sales_isolation" ON "sales"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_lines_isolation" ON "sale_lines";
CREATE POLICY "sale_lines_isolation" ON "sale_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_discounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_discounts_isolation" ON "sale_discounts";
CREATE POLICY "sale_discounts_isolation" ON "sale_discounts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenders_isolation" ON "tenders";
CREATE POLICY "tenders_isolation" ON "tenders"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoices_isolation" ON "invoices";
CREATE POLICY "invoices_isolation" ON "invoices"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "invoice_tax_breakdown" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_tax_breakdown" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_tax_breakdown_isolation" ON "invoice_tax_breakdown";
CREATE POLICY "invoice_tax_breakdown_isolation" ON "invoice_tax_breakdown"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "returns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "returns_isolation" ON "returns";
CREATE POLICY "returns_isolation" ON "returns"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "return_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "return_lines_isolation" ON "return_lines";
CREATE POLICY "return_lines_isolation" ON "return_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refunds_isolation" ON "refunds";
CREATE POLICY "refunds_isolation" ON "refunds"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_keys_isolation" ON "idempotency_keys";
CREATE POLICY "idempotency_keys_isolation" ON "idempotency_keys"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_events_isolation" ON "audit_events";
CREATE POLICY "audit_events_isolation" ON "audit_events"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Deliberately outside RLS
-- ---------------------------------------------------------------------------
--
-- permissions          The application's own vocabulary. Identical for every
--                      tenant, derived from nobody's data. Tenants bind these
--                      keys to their own roles through role_permissions, which
--                      IS tenant-owned and IS protected.
--
-- global_catalog_items The national barcode catalogue: shared reference data,
--                      identical for every merchant, none of it private
--                      (ADR-0004).
--
-- Enabling RLS on either would require a policy permitting everything, which
-- is a misleading way to write "not protected".
