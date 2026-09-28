-- Mastermind V2-3 — immutable return base-quantity snapshot.
--
-- Existing return lines predate packaging, so their commercial quantity and
-- inventory/base quantity are the same historical fact. Backfill only that
-- proven identity; no current package row is consulted.
BEGIN;

ALTER TABLE "return_lines"
  ADD COLUMN "inventoryQuantityScaled" BIGINT;

UPDATE "return_lines"
   SET "inventoryQuantityScaled" = "quantityScaled"
 WHERE "inventoryQuantityScaled" IS NULL;

ALTER TABLE "return_lines"
  ALTER COLUMN "inventoryQuantityScaled" SET NOT NULL;

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_inventory_quantity_positive"
  CHECK ("inventoryQuantityScaled" > 0);

COMMIT;
