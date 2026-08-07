-- Korvi POS — Row-Level Security foundation.
--
-- Defence in depth. `WHERE tenantId = ?` in a repository is necessary but not
-- sufficient: it protects only the queries that remember to include it. One
-- forgotten clause, one raw query written under time pressure, one ORM helper
-- that builds its own SQL, and a merchant sees another merchant's sales.
--
-- RLS moves the boundary into the database, where it applies to every statement
-- on the connection regardless of which code path produced it.
--
-- Tenant context travels as the `app.tenant_id` setting, established with
-- SET LOCAL inside the transaction. SET LOCAL is what makes this safe under a
-- connection pool: the value dies with the transaction, so a pooled connection
-- can never carry one tenant's context into another tenant's request.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "tenants" (
  "id"        UUID PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "vatNumber" VARCHAR(15),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "products" (
  "id"             UUID PRIMARY KEY,
  "tenantId"       UUID NOT NULL,
  "sku"            TEXT NOT NULL,
  "nameAr"         TEXT NOT NULL,
  "nameEn"         TEXT,
  "barcode"        TEXT,
  "priceMinor"     BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "codeReverse"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "products_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- A rate outside 0..10000 bp is a data-entry error every time. The domain
  -- refuses it (BasisPoints) and so does the column: two independent guards,
  -- because a bad rate reaches a printed invoice (ADR-0002).
  CONSTRAINT "products_vat_basis_points_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  -- Money is a non-negative integer count of halalas. Never a float.
  CONSTRAINT "products_price_minor_non_negative" CHECK ("priceMinor" >= 0)
);

CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");
CREATE INDEX "products_tenantId_barcode_idx" ON "products"("tenantId", "barcode");
CREATE INDEX "products_tenantId_codeReverse_idx" ON "products"("tenantId", "codeReverse");

-- Shared infrastructure, not tenant data. See ADR-0004 before adding another.
CREATE TABLE "global_catalog_items" (
  "barcode"        TEXT PRIMARY KEY,
  "nameAr"         TEXT NOT NULL,
  "nameEn"         TEXT,
  "vatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "global_catalog_vat_basis_points_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000)
);

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

-- Returns the current tenant, or NULL when none is set.
--
-- STABLE, not IMMUTABLE: the value changes between transactions, and marking it
-- IMMUTABLE would let the planner cache one tenant's value into another's plan.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- Policies — deny by default
-- ---------------------------------------------------------------------------

-- ENABLE turns policies on. FORCE additionally applies them to the table's
-- owner, which is the part people forget: without FORCE, the role that owns the
-- table bypasses every policy, and the application role is very often the owner.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;

-- With RLS enabled and no permissive policy matching, Postgres returns nothing
-- and rejects writes. That is the deny-by-default baseline; each policy below
-- opens exactly one door.

CREATE POLICY "tenants_isolation" ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

-- USING governs which rows are visible to SELECT/UPDATE/DELETE.
-- WITH CHECK governs which rows may be written. Both are required: USING alone
-- would let a caller UPDATE a visible row and hand it to another tenant.
CREATE POLICY "products_isolation" ON "products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- global_catalog_items deliberately carries no RLS: it is shared reference
-- data, identical for every merchant, and none of it is anyone's private
-- information (ADR-0004). Enabling RLS here would need a policy that permits
-- everything, which is a misleading way to write "not protected".
