-- Korvi POS — Gate 40: durable ZATCA invoice reporting / clearance state machine.
--
-- The sealed invoice bytes, hash, UUID and Production-CSID handle are frozen before
-- the first outbound byte may leave Korvi. A request is marked in-flight first;
-- transport ambiguity is therefore reconciled, never blindly retried.

BEGIN;

CREATE TABLE "zatca_invoice_submissions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "environment" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "invoiceUuid" UUID NOT NULL,
  "invoiceHash" BYTEA NOT NULL,
  "sealedInvoiceXml" BYTEA NOT NULL,
  "secretProvider" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "queuedAt" TIMESTAMP(3) NOT NULL,
  "requestStartedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "httpStatus" INTEGER,
  "authorityStatus" TEXT,
  "clearedInvoiceXml" BYTEA,
  "rejectionCode" TEXT,
  "uncertaintyReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_invoice_submissions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_submissions_invoice_fkey"
    FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_submissions_terminal_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "zatca_invoice_submissions_environment"
    CHECK ("environment" IN ('sandbox', 'simulation', 'production')),
  CONSTRAINT "zatca_invoice_submissions_mode"
    CHECK ("mode" IN ('reporting', 'clearance')),
  CONSTRAINT "zatca_invoice_submissions_state"
    CHECK ("state" IN ('pending', 'in-flight', 'accepted', 'rejected', 'uncertain')),
  CONSTRAINT "zatca_invoice_submissions_attempt_count"
    CHECK ("attemptCount" IN (0, 1)),
  CONSTRAINT "zatca_invoice_submissions_hash_length"
    CHECK (octet_length("invoiceHash") = 32),
  CONSTRAINT "zatca_invoice_submissions_xml_length"
    CHECK (octet_length("sealedInvoiceXml") BETWEEN 16 AND 3145728),
  CONSTRAINT "zatca_invoice_submissions_secret_handle"
    CHECK (
      length(btrim("secretProvider")) BETWEEN 1 AND 500 AND
      length(btrim("secretId")) BETWEEN 1 AND 2048
    ),
  CONSTRAINT "zatca_invoice_submissions_http_status"
    CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
  CONSTRAINT "zatca_invoice_submissions_authority_status"
    CHECK ("authorityStatus" IS NULL OR "authorityStatus" IN ('REPORTED', 'CLEARED')),
  CONSTRAINT "zatca_invoice_submissions_uncertainty_reason"
    CHECK (
      "uncertaintyReason" IS NULL OR
      "uncertaintyReason" IN ('credential-store', 'transport', 'response-invalid')
    ),
  CONSTRAINT "zatca_invoice_submissions_exact_seconds"
    CHECK (
      date_trunc('second', "queuedAt") = "queuedAt" AND
      ("requestStartedAt" IS NULL OR date_trunc('second', "requestStartedAt") = "requestStartedAt") AND
      ("resolvedAt" IS NULL OR date_trunc('second', "resolvedAt") = "resolvedAt")
    ),
  CONSTRAINT "zatca_invoice_submissions_temporal_order"
    CHECK (
      ("requestStartedAt" IS NULL OR "requestStartedAt" >= "queuedAt") AND
      ("resolvedAt" IS NULL OR ("requestStartedAt" IS NOT NULL AND "resolvedAt" >= "requestStartedAt"))
    ),
  CONSTRAINT "zatca_invoice_submissions_state_shape"
    CHECK (
      (
        "state" = 'pending' AND "attemptCount" = 0 AND
        "requestStartedAt" IS NULL AND "resolvedAt" IS NULL AND "httpStatus" IS NULL AND
        "authorityStatus" IS NULL AND "clearedInvoiceXml" IS NULL AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'in-flight' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NULL AND "httpStatus" IS NULL AND
        "authorityStatus" IS NULL AND "clearedInvoiceXml" IS NULL AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'accepted' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "httpStatus" IS NOT NULL AND
        "authorityStatus" IS NOT NULL AND "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL AND
        (
          ("mode" = 'reporting' AND "authorityStatus" = 'REPORTED' AND "clearedInvoiceXml" IS NULL) OR
          ("mode" = 'clearance' AND "authorityStatus" = 'CLEARED' AND
            octet_length("clearedInvoiceXml") BETWEEN 16 AND 3145728)
        )
      ) OR (
        "state" = 'rejected' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "httpStatus" IS NOT NULL AND
        "authorityStatus" IS NULL AND "clearedInvoiceXml" IS NULL AND
        "rejectionCode" IS NOT NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'uncertain' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND
        "authorityStatus" IS NULL AND "clearedInvoiceXml" IS NULL AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "zatca_invoice_submissions_tenantId_id_key"
  ON "zatca_invoice_submissions"("tenantId", "id");
CREATE UNIQUE INDEX "zatca_invoice_submissions_tenantId_invoiceId_mode_key"
  ON "zatca_invoice_submissions"("tenantId", "invoiceId", "mode");
CREATE INDEX "zatca_invoice_submissions_tenantId_terminalId_state_idx"
  ON "zatca_invoice_submissions"("tenantId", "terminalId", "state");
CREATE INDEX "zatca_invoice_submissions_tenantId_state_queuedAt_idx"
  ON "zatca_invoice_submissions"("tenantId", "state", "queuedAt");

CREATE FUNCTION zatca_invoice_submission_guard() RETURNS trigger AS $$
DECLARE
  source_invoice_type TEXT;
  source_terminal_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA invoice submission evidence cannot be deleted' USING ERRCODE = '23514';
  END IF;

  SELECT invoice."invoiceType", sale."terminalId"
    INTO source_invoice_type, source_terminal_id
    FROM "invoices" AS invoice
    JOIN "sales" AS sale
      ON sale."tenantId" = invoice."tenantId"
     AND sale."id" = invoice."saleId"
   WHERE invoice."tenantId" = NEW."tenantId"
     AND invoice."id" = NEW."invoiceId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZATCA submission requires an existing tenant-owned invoice'
      USING ERRCODE = '23514';
  END IF;

  IF source_terminal_id <> NEW."terminalId" THEN
    RAISE EXCEPTION 'ZATCA submission terminal contradicts immutable invoice sale terminal'
      USING ERRCODE = '23514';
  END IF;

  IF (source_invoice_type = 'simplified' AND NEW."mode" <> 'reporting')
     OR (source_invoice_type = 'standard' AND NEW."mode" <> 'clearance') THEN
    RAISE EXCEPTION 'ZATCA submission mode contradicts immutable invoice type'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD."id" <> NEW."id"
     OR OLD."tenantId" <> NEW."tenantId"
     OR OLD."invoiceId" <> NEW."invoiceId"
     OR OLD."terminalId" <> NEW."terminalId"
     OR OLD."environment" <> NEW."environment"
     OR OLD."mode" <> NEW."mode"
     OR OLD."invoiceUuid" <> NEW."invoiceUuid"
     OR OLD."invoiceHash" <> NEW."invoiceHash"
     OR OLD."sealedInvoiceXml" <> NEW."sealedInvoiceXml"
     OR OLD."secretProvider" <> NEW."secretProvider"
     OR OLD."secretId" <> NEW."secretId"
     OR OLD."queuedAt" <> NEW."queuedAt"
     OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'ZATCA invoice submission immutable request identity cannot change'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."state" = 'pending' AND NEW."state" = 'in-flight') OR
    (OLD."state" = 'in-flight' AND NEW."state" IN ('accepted', 'rejected', 'uncertain')) OR
    (OLD."state" = 'uncertain' AND NEW."state" IN ('accepted', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'illegal ZATCA invoice submission state transition % -> %', OLD."state", NEW."state"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zatca_invoice_submission_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "zatca_invoice_submissions"
  FOR EACH ROW EXECUTE FUNCTION zatca_invoice_submission_guard();

ALTER TABLE "zatca_invoice_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_invoice_submissions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zatca_invoice_submissions_isolation" ON "zatca_invoice_submissions";
CREATE POLICY "zatca_invoice_submissions_isolation" ON "zatca_invoice_submissions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
