-- Korvi POS — Strike 3B-1b · returns and refunds
--
-- Forward only. The four committed migrations are history and are not touched.
--
-- `returns`, `return_lines` and `refunds` already exist: the SaaS foundation
-- created them with RLS ENABLEd and FORCEd, deny-by-default policies and
-- composite tenant-consistent foreign keys. They were a sketch — enough shape
-- to reserve the names, not enough to be a commercial document. This migration
-- grows them into one, and adds nothing that would let a return be written
-- without a branch, a till, a drawer, a number and an operator.
--
-- Nothing is dropped. Every column added to a table that may already hold rows
-- is added nullable or with a default, backfilled from facts that already
-- exist, and constrained afterwards.

-- --------------------------------------------------------------------------
-- Sale lines: the one immutable fact a return engine needs and did not have
-- --------------------------------------------------------------------------
--
-- Whether a line was sold by the unit or by weight decides whether half of it
-- may come back. Reading it from `products` at return time would mean a
-- catalogue edit could change what a historical sale means — reclassify a
-- product as weighted and last year's unit sales become fractionally
-- returnable. So it is snapshotted, like the price and the name beside it.
--
-- Nullable on purpose. Rows written before this migration cannot be improved
-- retroactively: today's editable catalogue is NOT historical evidence. A
-- product may have been reclassified since the sale, so copying its current
-- type here would silently rewrite what a historical sale means. Existing
-- rows therefore remain NULL. NULL means "no immutable fact proves the type";
-- the return engine allows only the entire remaining quantity for such a line,
-- because a full remainder needs no unit-vs-weight interpretation. Partial
-- returns require a real immutable snapshot written by the sale path.
ALTER TABLE "sale_lines" ADD COLUMN "productType" TEXT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_type"
  CHECK ("productType" IS NULL OR "productType" IN ('unit', 'weighted'));

-- --------------------------------------------------------------------------
-- Returns: a document, not a note
-- --------------------------------------------------------------------------

ALTER TABLE "returns" ADD COLUMN "terminalId" UUID;
ALTER TABLE "returns" ADD COLUMN "shiftId" UUID;
ALTER TABLE "returns" ADD COLUMN "sequence" INTEGER;
ALTER TABLE "returns" ADD COLUMN "returnNumber" TEXT;
ALTER TABLE "returns" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'SAR';
ALTER TABLE "returns" ADD COLUMN "grossMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN "lineDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN "basketDiscountMinor" BIGINT NOT NULL DEFAULT 0;

-- Any row that predates this migration carried net, VAT and total and nothing
-- else. Gross is set to the total, which is what an undiscounted return's
-- extended price was; there were no discounts to describe, and inventing a
-- split would be a claim about a document nobody wrote.
UPDATE "returns" SET "grossMinor" = "totalMinor" WHERE "grossMinor" = 0;

-- net + VAT = total is already enforced by returns_reconciles, and it is
-- deliberately the only money identity asserted here. `gross - discounts`
-- equals the total under tax-inclusive pricing and the net under
-- tax-exclusive, so a constraint asserting either would be wrong for half of
-- Korvi's tenants — the same reason `sale_lines` only checks net + VAT.

ALTER TABLE "returns" ADD CONSTRAINT "returns_amounts_non_negative"
  CHECK ("grossMinor" >= 0 AND "lineDiscountMinor" >= 0 AND "basketDiscountMinor" >= 0
         AND "netMinor" >= 0 AND "vatMinor" >= 0);

-- A return worth nothing is not a return. It would consume a number and a
-- drawer movement and reconcile against nothing.
ALTER TABLE "returns" ADD CONSTRAINT "returns_total_positive" CHECK ("totalMinor" > 0);

ALTER TABLE "returns" ADD CONSTRAINT "returns_status"
  CHECK ("status" IN ('finalized', 'voided'));

-- A number is issued per branch and never reused. Both halves are unique so a
-- concurrent allocation collides here rather than producing two documents with
-- one number.
CREATE UNIQUE INDEX "returns_tenantId_branchId_sequence_key"
  ON "returns"("tenantId", "branchId", "sequence");
CREATE UNIQUE INDEX "returns_tenantId_returnNumber_key"
  ON "returns"("tenantId", "returnNumber");

CREATE INDEX "returns_tenantId_branchId_issuedAt_idx"
  ON "returns"("tenantId", "branchId", "issuedAt");
CREATE INDEX "returns_tenantId_shiftId_idx" ON "returns"("tenantId", "shiftId");

-- Tenant-consistent, like every other reference in this schema: the key is
-- (tenantId, id), so PostgreSQL refuses a return that points at another
-- merchant's till, drawer or operator even if the application is wrong
-- (ADR-0004).
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_terminalId_fkey"
  FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_shiftId_fkey"
  FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenantId_actorUserId_fkey"
  FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Return lines: enough to print a credit note from the return alone
-- --------------------------------------------------------------------------

ALTER TABLE "return_lines" ADD COLUMN "lineNumber" INTEGER;
ALTER TABLE "return_lines" ADD COLUMN "productId" UUID;
ALTER TABLE "return_lines" ADD COLUMN "sku" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "nameEn" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "productType" TEXT;
ALTER TABLE "return_lines" ADD COLUMN "vatBasisPoints" INTEGER;
ALTER TABLE "return_lines" ADD COLUMN "grossMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_lines" ADD COLUMN "lineDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_lines" ADD COLUMN "basketDiscountMinor" BIGINT NOT NULL DEFAULT 0;

-- Copied from the sale line the return already points at, which is itself a
-- snapshot. The copy is what lets a credit note be produced from the return
-- document without joining back through a sale.
UPDATE "return_lines" AS rl
   SET "lineNumber"     = sl."lineNumber",
       "productId"      = sl."productId",
       "sku"            = sl."sku",
       "nameAr"         = sl."nameAr",
       "nameEn"         = sl."nameEn",
       "productType"    = sl."productType",
       "vatBasisPoints" = sl."vatBasisPoints",
       "grossMinor"     = rl."totalMinor"
  FROM "sale_lines" AS sl
 WHERE sl."tenantId" = rl."tenantId"
   AND sl."id" = rl."saleLineId"
   AND rl."sku" IS NULL;

ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_amounts_non_negative"
  CHECK ("grossMinor" >= 0 AND "lineDiscountMinor" >= 0 AND "basketDiscountMinor" >= 0
         AND "netMinor" >= 0 AND "vatMinor" >= 0);
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_product_type"
  CHECK ("productType" IS NULL OR "productType" IN ('unit', 'weighted'));
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_vat_rate_bounded"
  CHECK ("vatBasisPoints" IS NULL OR ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000));

-- One row per sale line per return. Two rows for one line would each pass a
-- remaining-quantity check that their sum fails — the same defect the checkout
-- refuses when a basket names one product twice.
CREATE UNIQUE INDEX "return_lines_tenantId_returnId_saleLineId_key"
  ON "return_lines"("tenantId", "returnId", "saleLineId");

CREATE INDEX "return_lines_tenantId_productId_idx"
  ON "return_lines"("tenantId", "productId");

ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_tenantId_productId_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Refunds: a settlement record, in the same vocabulary as a tender
-- --------------------------------------------------------------------------
--
-- `method` becomes `kind` so a refund and a tender describe money with the
-- same words. A rename carries every row across; nothing is dropped and
-- nothing is rewritten.
ALTER TABLE "refunds" RENAME COLUMN "method" TO "kind";
ALTER TABLE "refunds" RENAME CONSTRAINT "refunds_method" TO "refunds_kind";

ALTER TABLE "refunds" ADD COLUMN "scheme" TEXT;

-- 'electronic' is what a till writes from now on: a refund approved somewhere
-- else and recorded here. The older values stay legal so committed rows remain
-- readable, exactly as the settlement strike did for tenders.
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_kind";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_kind"
  CHECK ("kind" IN ('cash', 'electronic', 'card', 'mada', 'transfer'));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_scheme_values"
  CHECK ("scheme" IS NULL OR "scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other'));

-- An electronic refund names its scheme, and nothing else may carry one.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_scheme_electronic_only"
  CHECK (("kind" = 'electronic') = ("scheme" IS NOT NULL));

-- The reference points at an approval that happened elsewhere. It is the only
-- thing tying this row to that event, so an electronic refund must have one —
-- and it is operator-supplied, so it is bounded.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_electronic_reference"
  CHECK ("kind" <> 'electronic' OR ("reference" IS NOT NULL AND btrim("reference") <> ''));
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reference_bounded"
  CHECK ("reference" IS NULL OR char_length("reference") <= 64);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cash_no_reference"
  CHECK ("kind" <> 'cash' OR "reference" IS NULL);

-- One refund per return document. Korvi has no way to prove that two external
-- approvals against one return are not the same approval counted twice, so it
-- refuses to hold both.
DROP INDEX IF EXISTS "refunds_tenantId_returnId_idx";
CREATE UNIQUE INDEX "refunds_tenantId_returnId_key" ON "refunds"("tenantId", "returnId");
