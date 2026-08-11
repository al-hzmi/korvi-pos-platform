-- Immutable, explainable drawer-close snapshot. Historical closed shifts retain
-- NULL closer/breakdown values because those facts were not recorded.
ALTER TABLE "shifts"
  ADD COLUMN "cashSalesMinor" BIGINT,
  ADD COLUMN "cashRefundsMinor" BIGINT,
  ADD COLUMN "paidInMinor" BIGINT,
  ADD COLUMN "paidOutMinor" BIGINT,
  ADD COLUMN "closedByUserId" UUID;

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closedBy_tenant_fkey"
  FOREIGN KEY ("tenantId", "closedByUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_reconciliation_magnitudes"
  CHECK (("cashSalesMinor" IS NULL OR "cashSalesMinor" >= 0)
     AND ("cashRefundsMinor" IS NULL OR "cashRefundsMinor" >= 0)
     AND ("paidInMinor" IS NULL OR "paidInMinor" >= 0)
     AND ("paidOutMinor" IS NULL OR "paidOutMinor" >= 0));

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_new_close_snapshot_consistency"
  CHECK ("status" <> 'closed' OR "closedByUserId" IS NULL OR
    ("declaredCashMinor" IS NOT NULL AND "expectedCashMinor" IS NOT NULL
     AND "varianceMinor" = "declaredCashMinor" - "expectedCashMinor"
     AND "cashSalesMinor" IS NOT NULL AND "cashRefundsMinor" IS NOT NULL
     AND "paidInMinor" IS NOT NULL AND "paidOutMinor" IS NOT NULL
     AND "expectedCashMinor" = "openingFloatMinor" + "cashSalesMinor"
       - "cashRefundsMinor" + "paidInMinor" - "paidOutMinor"));
