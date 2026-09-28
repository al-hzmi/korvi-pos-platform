-- Mastermind V2-3 — require the existing immutable return base-quantity snapshot.
--
-- ADR-0038 migration 20260925150000 already created return_lines.inventoryQuantityScaled.
-- Legacy return rows predate package commerce, so their commercial and base
-- inventory quantities are the same proven historical fact. Backfill only that
-- identity; never consult current package/catalogue policy.
BEGIN;

UPDATE "return_lines"
   SET "inventoryQuantityScaled" = "quantityScaled"
 WHERE "inventoryQuantityScaled" IS NULL;

ALTER TABLE "return_lines"
  ALTER COLUMN "inventoryQuantityScaled" SET NOT NULL;

COMMIT;
