-- Korvi POS — Strike 3B-1c · shift close and drawer reconciliation
--
-- Forward only and additive. The five committed migrations are history and are
-- not touched. Every column added is nullable, so a shift closed before this
-- migration stays exactly as it was: an absent reconciliation is an absent
-- fact, and this migration fabricates none.

-- --------------------------------------------------------------------------
-- Shifts: the immutable reconciliation snapshot
-- --------------------------------------------------------------------------

ALTER TABLE "shifts" ADD COLUMN "cashSalesMinor" BIGINT;
ALTER TABLE "shifts" ADD COLUMN "cashRefundsMinor" BIGINT;
ALTER TABLE "shifts" ADD COLUMN "paidInMinor" BIGINT;
ALTER TABLE "shifts" ADD COLUMN "paidOutMinor" BIGINT;
ALTER TABLE "shifts" ADD COLUMN "closedByUserId" UUID;

-- Tenant-consistent, like every other reference in this schema: the key is
-- (tenantId, id), so PostgreSQL refuses a close attributed to another
-- merchant's user even if the application is wrong (ADR-0004).
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenantId_closedByUserId_fkey"
  FOREIGN KEY ("tenantId", "closedByUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "shifts_tenantId_closedByUserId_idx"
  ON "shifts"("tenantId", "closedByUserId");

-- A count of the notes in a drawer cannot be negative.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_declared_non_negative"
  CHECK ("declaredCashMinor" IS NULL OR "declaredCashMinor" >= 0);

-- The snapshot holds magnitudes. A signed refund total invites the reader to
-- add it, and one double negation turns a shortfall into a surplus of twice
-- the size.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_reconciliation_non_negative"
  CHECK (
    ("cashSalesMinor" IS NULL OR "cashSalesMinor" >= 0) AND
    ("cashRefundsMinor" IS NULL OR "cashRefundsMinor" >= 0) AND
    ("paidInMinor" IS NULL OR "paidInMinor" >= 0) AND
    ("paidOutMinor" IS NULL OR "paidOutMinor" >= 0)
  );

-- The cash equation, asserted by the database as well as by the domain.
-- Written so it applies only to rows that carry a snapshot, which leaves any
-- pre-existing closed shift untouched.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_expected_equation"
  CHECK (
    "cashSalesMinor" IS NULL OR
    "expectedCashMinor" = "openingFloatMinor" + "cashSalesMinor" - "cashRefundsMinor"
                          + "paidInMinor" - "paidOutMinor"
  );

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_variance_equation"
  CHECK (
    "varianceMinor" IS NULL OR "declaredCashMinor" IS NULL OR "expectedCashMinor" IS NULL OR
    "varianceMinor" = "declaredCashMinor" - "expectedCashMinor"
  );

-- A partial reconciliation must not be representable. Either the snapshot is
-- whole or it is absent; there is no state in between for a later write to
-- fill in.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_reconciliation_complete"
  CHECK (
    ("cashSalesMinor" IS NULL AND "cashRefundsMinor" IS NULL
     AND "paidInMinor" IS NULL AND "paidOutMinor" IS NULL)
    OR
    ("cashSalesMinor" IS NOT NULL AND "cashRefundsMinor" IS NOT NULL
     AND "paidInMinor" IS NOT NULL AND "paidOutMinor" IS NOT NULL
     AND "declaredCashMinor" IS NOT NULL AND "expectedCashMinor" IS NOT NULL
     AND "varianceMinor" IS NOT NULL AND "closedAt" IS NOT NULL
     AND "closedByUserId" IS NOT NULL AND "status" = 'closed')
  );

-- A named closer means a close this architecture performed, and that close
-- always leaves a whole snapshot behind. Legacy rows have neither.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closer_has_snapshot"
  CHECK ("closedByUserId" IS NULL OR "cashSalesMinor" IS NOT NULL);

-- A closing time belongs only to a closed shift. The converse is deliberately
-- not asserted: a shift closed before this migration may predate closedAt.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_at_consistency"
  CHECK ("closedAt" IS NULL OR "status" = 'closed');

-- --------------------------------------------------------------------------
-- Cash movements: what a manual movement must carry
-- --------------------------------------------------------------------------
--
-- The existing cash_movements_sign already keeps sale/pay-in non-negative and
-- refund/pay-out non-positive. These narrow that for the two kinds an operator
-- creates by hand, where a zero would be a movement that did not happen.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_manual_magnitude"
  CHECK (
    ("kind" <> 'pay-in' OR "amountMinor" > 0) AND
    ("kind" <> 'pay-out' OR "amountMinor" < 0)
  );

-- The float is the starting balance, not money that arrived.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_opening_float_zero"
  CHECK ("kind" <> 'opening-float' OR "amountMinor" = 0);

-- A hand-written movement without a person is unauditable, and one without a
-- reason is unexplainable. Both are the point of recording it at all.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_manual_actor"
  CHECK ("kind" NOT IN ('pay-in', 'pay-out') OR "actorUserId" IS NOT NULL);

-- Trimmed at the edge and stored trimmed, so the constraint can say the row
-- carries a real reason rather than three spaces.
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_manual_reason"
  CHECK (
    "kind" NOT IN ('pay-in', 'pay-out') OR
    ("reason" IS NOT NULL AND btrim("reason") = "reason" AND "reason" <> ''
     AND char_length("reason") <= 200)
  );

ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_actorUserId_fkey"
  FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "cash_movements_tenantId_shiftId_kind_idx"
  ON "cash_movements"("tenantId", "shiftId", "kind");
CREATE INDEX "cash_movements_tenantId_actorUserId_idx"
  ON "cash_movements"("tenantId", "actorUserId");
