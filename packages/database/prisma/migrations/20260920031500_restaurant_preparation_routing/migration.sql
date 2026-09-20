-- Korvi POS — Restaurant preparation stations and deterministic routing.
-- Operational only: these tables have no price, VAT, invoice, QR, ICV, PIH or fiscal fields.

BEGIN;

CREATE TABLE "restaurant_preparation_stations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "restaurant_preparation_stations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_stations_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_stations_code_nonempty"
    CHECK ("code" = btrim("code") AND char_length("code") BETWEEN 1 AND 40),
  CONSTRAINT "restaurant_preparation_stations_name_nonempty"
    CHECK ("nameAr" = btrim("nameAr") AND char_length("nameAr") BETWEEN 1 AND 80),
  CONSTRAINT "restaurant_preparation_stations_sort_nonnegative" CHECK ("sortOrder" >= 0)
);

CREATE UNIQUE INDEX "restaurant_preparation_stations_tenantId_id_key"
  ON "restaurant_preparation_stations"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_preparation_stations_tenantId_branchId_id_key"
  ON "restaurant_preparation_stations"("tenantId", "branchId", "id");
CREATE UNIQUE INDEX "restaurant_preparation_stations_tenantId_branchId_code_key"
  ON "restaurant_preparation_stations"("tenantId", "branchId", "code");
CREATE INDEX "restaurant_preparation_stations_tenantId_branchId_active_sort_idx"
  ON "restaurant_preparation_stations"("tenantId", "branchId", "isActive", "sortOrder");

CREATE TABLE "restaurant_preparation_routes" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "stationId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_preparation_routes_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_routes_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_routes_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_routes_tenantId_branchId_stationId_fkey"
    FOREIGN KEY ("tenantId", "branchId", "stationId")
    REFERENCES "restaurant_preparation_stations"("tenantId", "branchId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_preparation_routes_tenantId_id_key"
  ON "restaurant_preparation_routes"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_preparation_routes_tenantId_branchId_productId_stationId_key"
  ON "restaurant_preparation_routes"("tenantId", "branchId", "productId", "stationId");
CREATE INDEX "restaurant_preparation_routes_tenantId_branchId_stationId_productId_idx"
  ON "restaurant_preparation_routes"("tenantId", "branchId", "stationId", "productId");
CREATE INDEX "restaurant_preparation_routes_tenantId_branchId_productId_idx"
  ON "restaurant_preparation_routes"("tenantId", "branchId", "productId");

ALTER TABLE "restaurant_preparation_stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_preparation_stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_preparation_stations_isolation"
  ON "restaurant_preparation_stations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_preparation_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_preparation_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_preparation_routes_isolation"
  ON "restaurant_preparation_routes"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
