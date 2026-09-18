-- Korvi POS — Restaurant floor authority.
-- Zones/tables are operational merchant data. They are tenant + branch scoped,
-- protected by FORCE RLS, and never carry fiscal semantics.
-- Existing sales remain tableId = NULL; historical table assignment is never guessed.

BEGIN;

CREATE TABLE "restaurant_zones" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "nameAr" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "restaurant_zones_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_zones_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_zones_name_nonempty"
    CHECK ("nameAr" = btrim("nameAr") AND char_length("nameAr") BETWEEN 1 AND 80),
  CONSTRAINT "restaurant_zones_sort_nonnegative" CHECK ("sortOrder" >= 0)
);

CREATE UNIQUE INDEX "restaurant_zones_tenantId_id_key"
  ON "restaurant_zones"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_zones_tenantId_branchId_id_key"
  ON "restaurant_zones"("tenantId", "branchId", "id");
CREATE INDEX "restaurant_zones_tenantId_branchId_active_sort_idx"
  ON "restaurant_zones"("tenantId", "branchId", "isActive", "sortOrder");

CREATE TABLE "restaurant_tables" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "zoneId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "capacity" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "restaurant_tables_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_tables_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_tables_tenantId_branchId_zoneId_fkey"
    FOREIGN KEY ("tenantId", "branchId", "zoneId")
    REFERENCES "restaurant_zones"("tenantId", "branchId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_tables_code_nonempty"
    CHECK ("code" = btrim("code") AND char_length("code") BETWEEN 1 AND 40),
  CONSTRAINT "restaurant_tables_name_nonempty"
    CHECK ("nameAr" = btrim("nameAr") AND char_length("nameAr") BETWEEN 1 AND 80),
  CONSTRAINT "restaurant_tables_capacity_positive"
    CHECK ("capacity" IS NULL OR "capacity" > 0)
);

CREATE UNIQUE INDEX "restaurant_tables_tenantId_id_key"
  ON "restaurant_tables"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_tables_tenantId_branchId_code_key"
  ON "restaurant_tables"("tenantId", "branchId", "code");
CREATE INDEX "restaurant_tables_tenantId_branchId_zoneId_active_idx"
  ON "restaurant_tables"("tenantId", "branchId", "zoneId", "isActive");

ALTER TABLE "sales" ADD COLUMN "tableId" UUID;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_tenantId_tableId_fkey"
  FOREIGN KEY ("tenantId", "tableId")
  REFERENCES "restaurant_tables"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "sales_tenantId_tableId_idx" ON "sales"("tenantId", "tableId");

ALTER TABLE "restaurant_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_zones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_zones_isolation" ON "restaurant_zones"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_tables_isolation" ON "restaurant_tables"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
