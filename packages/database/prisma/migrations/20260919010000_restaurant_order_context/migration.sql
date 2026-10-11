-- Korvi POS — Post-V1 Restaurant foundation: immutable service mode on finalized sales.
--
-- Additive and intentionally nullable. Existing sales predate this fact and
-- must remain "unknown", not be rewritten as takeaway or any other invented
-- operational history. This is operational metadata only; no fiscal table,
-- invoice identifier, VAT field, ICV/PIH or ZATCA artifact is touched.

BEGIN;

ALTER TABLE "sales"
  ADD COLUMN "orderType" TEXT;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_order_type_valid"
  CHECK (
    "orderType" IS NULL
    OR "orderType" IN ('dine-in', 'takeaway', 'delivery')
  );

COMMIT;
