-- Korvi POS — KDS operational lifecycle.
-- This table is explicitly non-fiscal: it contains no price, VAT, invoice, QR, ICV or PIH fields.

BEGIN;

CREATE UNIQUE INDEX "restaurant_orders_tenantId_branchId_id_key"
  ON "restaurant_orders"("tenantId", "branchId", "id");

CREATE TABLE "restaurant_preparation_tasks" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "stationId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "orderLineId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "orderRevision" BIGINT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "preparationNote" TEXT,
  "preparationOptions" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "queuedAt" TIMESTAMPTZ NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "readyAt" TIMESTAMPTZ,
  "servedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "restaurant_preparation_tasks_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_tasks_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_tasks_station_fkey"
    FOREIGN KEY ("tenantId", "branchId", "stationId")
    REFERENCES "restaurant_preparation_stations"("tenantId", "branchId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_tasks_order_fkey"
    FOREIGN KEY ("tenantId", "branchId", "orderId")
    REFERENCES "restaurant_orders"("tenantId", "branchId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_tasks_product_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_preparation_tasks_order_revision_positive" CHECK ("orderRevision" >= 1),
  CONSTRAINT "restaurant_preparation_tasks_revision_positive" CHECK ("revision" >= 1),
  CONSTRAINT "restaurant_preparation_tasks_line_positive" CHECK ("lineNumber" >= 1),
  CONSTRAINT "restaurant_preparation_tasks_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "restaurant_preparation_tasks_status_known"
    CHECK ("status" IN ('queued', 'preparing', 'ready', 'served')),
  CONSTRAINT "restaurant_preparation_tasks_timestamps_match_status"
    CHECK (
      ("status" = 'queued' AND "startedAt" IS NULL AND "readyAt" IS NULL AND "servedAt" IS NULL)
      OR ("status" = 'preparing' AND "startedAt" IS NOT NULL AND "readyAt" IS NULL AND "servedAt" IS NULL)
      OR ("status" = 'ready' AND "startedAt" IS NOT NULL AND "readyAt" IS NOT NULL AND "servedAt" IS NULL)
      OR ("status" = 'served' AND "startedAt" IS NOT NULL AND "readyAt" IS NOT NULL AND "servedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "restaurant_preparation_tasks_tenantId_id_key"
  ON "restaurant_preparation_tasks"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_preparation_tasks_tenantId_branchId_id_key"
  ON "restaurant_preparation_tasks"("tenantId", "branchId", "id");
CREATE UNIQUE INDEX "restaurant_preparation_tasks_snapshot_key"
  ON "restaurant_preparation_tasks"(
    "tenantId", "branchId", "orderId", "orderRevision", "stationId", "orderLineId"
  );
CREATE INDEX "restaurant_preparation_tasks_station_queue_idx"
  ON "restaurant_preparation_tasks"("tenantId", "branchId", "stationId", "status", "queuedAt");
CREATE INDEX "restaurant_preparation_tasks_order_revision_idx"
  ON "restaurant_preparation_tasks"("tenantId", "branchId", "orderId", "orderRevision");

ALTER TABLE "restaurant_preparation_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_preparation_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_preparation_tasks_isolation" ON "restaurant_preparation_tasks";
CREATE POLICY "restaurant_preparation_tasks_isolation" ON "restaurant_preparation_tasks"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
