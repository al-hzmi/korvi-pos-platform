-- Korvi POS — Strike 3B-1a · commercial settlement
--
-- Two columns, and the constraints that make them mean something.
--
-- No new table. `tenders` and `sale_discounts` were created in the SaaS
-- foundation with RLS ENABLEd and FORCEd, deny-by-default policies, and
-- composite tenant-consistent foreign keys to `sales`. A settlement is a fact
-- about a sale, not an entity of its own, so it belongs on those rows — and
-- extending them inherits the whole tenancy boundary rather than re-deriving
-- it (ADR-0004).
--
-- Forward only. The two committed migrations are history and are not touched.

-- --------------------------------------------------------------------------
-- Tenders: how the money actually arrived
-- --------------------------------------------------------------------------

ALTER TABLE "tenders" ADD COLUMN "scheme" TEXT;

-- `electronic` is the kind a till may write from now on: a payment approved
-- somewhere else and recorded here as settled. The older kinds stay legal so
-- rows already committed remain readable; nothing produces them any more.
ALTER TABLE "tenders" DROP CONSTRAINT "tenders_kind";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_kind"
  CHECK ("kind" IN ('cash', 'card', 'mada', 'transfer', 'electronic'));

-- A closed list. The scheme is a label on a financial row and appears in every
-- report built on it, so it is not a free-text field an operator can invent.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_scheme_values"
  CHECK ("scheme" IS NULL OR "scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other'));

-- An electronic settlement names its scheme, and nothing else may carry one.
-- Written as an equality between two booleans so both directions hold: no
-- electronic tender without a scheme, no cash tender wearing one.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_scheme_electronic_only"
  CHECK (("kind" = 'electronic') = ("scheme" IS NOT NULL));

-- The reference points at an approval that happened elsewhere. It is the only
-- thing tying this row to that event, so an electronic tender must have one —
-- and it is operator-supplied, so it is bounded.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_electronic_reference"
  CHECK ("kind" <> 'electronic' OR ("reference" IS NOT NULL AND btrim("reference") <> ''));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_reference_bounded"
  CHECK ("reference" IS NULL OR char_length("reference") <= 64);

-- A tender of nothing is not a payment. The original constraint allowed zero,
-- which let a sale carry a line describing a method that was never used.
ALTER TABLE "tenders" DROP CONSTRAINT "tenders_amount_non_negative";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_amount_positive" CHECK ("amountMinor" > 0);

-- Change comes out of the drawer, so it can never exceed what went into it.
-- The existing tenders_change_cash_only says only cash may carry change; this
-- says it may not carry more than it was given.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_change_within_amount"
  CHECK ("changeMinor" <= "amountMinor");

-- A cash tender carries no approval code, because there is nothing external
-- to point at. Written so the legacy non-cash kinds stay readable.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_cash_no_reference"
  CHECK ("kind" <> 'cash' OR "reference" IS NULL);

-- The two composition rules the domain enforces, enforced again here.
--
-- Defence in depth, and the depth matters: the domain refuses these first, so
-- an ordinary checkout never meets a unique violation. What these stop is
-- everything that is not an ordinary checkout — a repair script, a migration,
-- an integration written against the tables.
--
-- One cash tender per sale: two cash lines is a drawer nobody can reconcile,
-- because the change has to come out of one of them and no fact says which.
CREATE UNIQUE INDEX "tenders_one_cash_per_sale"
  ON "tenders"("tenantId", "saleId") WHERE "kind" = 'cash';

-- One approval counted once: two rows pointing at one authorisation is a
-- double-count of somebody else's transaction.
CREATE UNIQUE INDEX "tenders_one_approval_per_sale"
  ON "tenders"("tenantId", "saleId", "scheme", "reference") WHERE "kind" = 'electronic';

CREATE INDEX "tenders_tenantId_scheme_idx" ON "tenders"("tenantId", "scheme");

-- --------------------------------------------------------------------------
-- Sale discounts: enough to explain a receipt years later
-- --------------------------------------------------------------------------

-- The receipt has to be explainable from what was written, not from replaying
-- today's pricing rules against a catalogue that has moved on.
ALTER TABLE "sale_discounts" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_input_non_negative"
  CHECK ("inputValue" >= 0);

-- A rate discount is basis points and cannot exceed the whole thing.
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_rate_bounded"
  CHECK ("kind" <> 'percentage' OR "inputValue" <= 10000);

-- A line discount names its line; a basket discount does not have one.
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_line_scope"
  CHECK (("scope" = 'line') = ("lineNumber" IS NOT NULL));

-- Who granted it, tenant-consistently. A discount attributed to a user in
-- another tenant is not an audit trail, and a plain reference to users(id)
-- would permit exactly that (ADR-0004).
ALTER TABLE "sale_discounts" ADD CONSTRAINT "sale_discounts_tenantId_grantedByUserId_fkey"
  FOREIGN KEY ("tenantId", "grantedByUserId") REFERENCES "users"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "sale_discounts_tenantId_grantedByUserId_idx"
  ON "sale_discounts"("tenantId", "grantedByUserId");
