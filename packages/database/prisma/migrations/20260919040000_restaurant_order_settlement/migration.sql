-- Korvi POS — atomic restaurant-order settlement bridge.
-- Historical order lines keep trackInventory NULL rather than inventing whether
-- stock tracking was enabled when they were opened. New application writes
-- record it. A sale link is nullable for all direct/historical sales.

BEGIN;

ALTER TABLE "restaurant_order_lines"
  ADD COLUMN "trackInventory" BOOLEAN;

ALTER TABLE "sales"
  ADD COLUMN "restaurantOrderId" UUID;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_tenantId_restaurantOrderId_fkey"
  FOREIGN KEY ("tenantId", "restaurantOrderId")
  REFERENCES "restaurant_orders"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE UNIQUE INDEX "sales_tenantId_restaurantOrderId_key"
  ON "sales"("tenantId", "restaurantOrderId");

COMMIT;
