-- Korvi POS — Gate 40: durable ZATCA invoice submission authority.
--
-- The queue freezes the exact signed XML/hash/UUID and opaque Production-CSID
-- handle before the first outbound byte. A network ambiguity is durable and
-- cannot be silently retransmitted. Database constraints and the transition
-- guard independently enforce that uncertainty boundary.

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
  "rejectionCode" TEXT,
  "uncertaintyReason" TEXT,
  "clearedInvoiceXml" BYTEA,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_invoice_submissions_environment_check"
    CHECK ("environment" IN ('sandbox', 'simulation', 'production')),
  CONSTRAINT "zatca_invoice_submissions_mode_check"
    CHECK ("mode" IN ('reporting', 'clearance')),
  CONSTRAINT "zatca_invoice_submissions_hash_width_check"
    CHECK (octet_length("invoiceHash") = 32),
  CONSTRAINT "zatca_invoice_submissions_xml_bounds_check"
    CHECK (octet_length("sealedInvoiceXml") BETWEEN 16 AND 3145728),
  CONSTRAINT "zatca_invoice_submissions_secret_handle_check"
    CHECK (
      char_length(btrim("secretProvider")) BETWEEN 1 AND 500 AND
      char_length(btrim("secretId")) BETWEEN 1 AND 2048
    ),
  CONSTRAINT "zatca_invoice_submissions_state_check"
    CHECK ("state" IN ('pending', 'in-flight', 'accepted', 'rejected', 'uncertain')),
  CONSTRAINT "zatca_invoice_submissions_attempt_count_check"
    CHECK ("attemptCount" IN (0, 1)),
  CONSTRAINT "zatca_invoice_submissions_http_status_check"
    CHECK ("httpStatus" IS NULL OR "httpStatus" BETWEEN 100 AND 599),
  CONSTRAINT "zatca_invoice_submissions_authority_status_check"
    CHECK ("authorityStatus" IS NULL OR "authorityStatus" IN ('REPORTED', 'CLEARED')),
  CONSTRAINT "zatca_invoice_submissions_uncertainty_reason_check"
    CHECK (
      "uncertaintyReason" IS NULL OR
      "uncertaintyReason" IN ('credential-store', 'transport', 'response-invalid')
    ),
  CONSTRAINT "zatca_invoice_submissions_exact_seconds_check"
    CHECK (
      date_trunc('second', "queuedAt") = "queuedAt" AND
      ("requestStartedAt" IS NULL OR date_trunc('second', "requestStartedAt") = "requestStartedAt") AND
      ("resolvedAt" IS NULL OR date_trunc('second', "resolvedAt") = "resolvedAt")
    ),
  CONSTRAINT "zatca_invoice_submissions_time_order_check"
    CHECK (
      ("requestStartedAt" IS NULL OR "requestStartedAt" >= "queuedAt") AND
      ("resolvedAt" IS NULL OR ("requestStartedAt" IS NOT NULL AND "resolvedAt" >= "requestStartedAt"))
    ),
  CONSTRAINT "zatca_invoice_submissions_state_shape_check"
    CHECK (
      (
        "state" = 'pending' AND "attemptCount" = 0 AND
        "requestStartedAt" IS NULL AND "resolvedAt" IS NULL AND
        "httpStatus" IS NULL AND "authorityStatus" IS NULL AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL AND
        "clearedInvoiceXml" IS NULL
      ) OR (
        "state" = 'in-flight' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NULL AND
        "httpStatus" IS NULL AND "authorityStatus" IS NULL AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL AND
        "clearedInvoiceXml" IS NULL
      ) OR (
        "state" = 'accepted' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND
        "httpStatus" BETWEEN 200 AND 299 AND
        "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL AND
        (
          ("mode" = 'reporting' AND "authorityStatus" = 'REPORTED' AND "clearedInvoiceXml" IS NULL) OR
          ("mode" = 'clearance' AND "authorityStatus" = 'CLEARED' AND
            octet_length("clearedInvoiceXml") BETWEEN 16 AND 3145728)
        )
      ) OR (
        "state" = 'rejected' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND
        "httpStatus" IS NOT NULL AND "authorityStatus" IS NULL AND
        "rejectionCode" IS NOT NULL AND char_length(btrim("rejectionCode")) BETWEEN 1 AND 500 AND
        "uncertaintyReason" IS NULL AND "clearedInvoiceXml" IS NULL
      ) OR (
        "state" = 'uncertain' AND "attemptCount" = 1 AND
        "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL AND
        "authorityStatus" IS NULL AND "rejectionCode" IS NULL AND
        "uncertaintyReason" IS NOT NULL AND "clearedInvoiceXml" IS NULL
      )
    ),
  CONSTRAINT "zatca_invoice_submissions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_submissions_tenantId_invoiceId_fkey"
    FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_submissions_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "zatca_invoice_submissions_tenantId_id_key"
  ON "zatca_invoice_submissions"("tenantId", "id");
CREATE UNIQUE INDEX "zatca_invoice_submissions_tenantId_invoiceId_mode_key"
  ON "zatca_invoice_submissions"("tenantId", "invoiceId", "mode");
CREATE INDEX "zatca_invoice_submissions_tenantId_state_queuedAt_idx"
  ON "zatca_invoice_submissions"("tenantId", "state", "queuedAt");
CREATE INDEX "zatca_invoice_submissions_tenantId_terminalId_state_idx"
  ON "zatca_invoice_submissions"("tenantId", "terminalId", "state");

ALTER TABLE "zatca_invoice_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_invoice_submissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "zatca_invoice_submissions_isolation" ON "zatca_invoice_submissions";
CREATE POLICY "zatca_invoice_submissions_isolation" ON "zatca_invoice_submissions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

CREATE FUNCTION guard_zatca_invoice_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_type TEXT;
  sale_terminal_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA invoice submission evidence cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  SELECT i."invoiceType", s."terminalId"
    INTO invoice_type, sale_terminal_id
    FROM "invoices" i
    JOIN "sales" s
      ON s."tenantId" = i."tenantId" AND s."id" = i."saleId"
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZATCA submission invoice authority is missing'
      USING ERRCODE = '23514';
  END IF;
  IF sale_terminal_id <> NEW."terminalId" THEN
    RAISE EXCEPTION 'ZATCA submission terminal must match the immutable sale terminal'
      USING ERRCODE = '23514';
  END IF;
  IF (invoice_type = 'simplified' AND NEW."mode" <> 'reporting') OR
     (invoice_type = 'standard' AND NEW."mode" <> 'clearance') THEN
    RAISE EXCEPTION 'ZATCA submission mode contradicts immutable invoice type'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id" OR
     OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
     OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR
     OLD."terminalId" IS DISTINCT FROM NEW."terminalId" OR
     OLD."environment" IS DISTINCT FROM NEW."environment" OR
     OLD."mode" IS DISTINCT FROM NEW."mode" OR
     OLD."invoiceUuid" IS DISTINCT FROM NEW."invoiceUuid" OR
     OLD."invoiceHash" IS DISTINCT FROM NEW."invoiceHash" OR
     OLD."sealedInvoiceXml" IS DISTINCT FROM NEW."sealedInvoiceXml" OR
     OLD."secretProvider" IS DISTINCT FROM NEW."secretProvider" OR
     OLD."secretId" IS DISTINCT FROM NEW."secretId" OR
     OLD."queuedAt" IS DISTINCT FROM NEW."queuedAt" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'ZATCA submission immutable request identity cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."state" = 'pending' AND NEW."state" = 'in-flight' AND OLD."attemptCount" = 0 AND NEW."attemptCount" = 1) OR
    (OLD."state" = 'in-flight' AND NEW."state" IN ('accepted', 'rejected', 'uncertain') AND NEW."attemptCount" = 1) OR
    (OLD."state" = 'uncertain' AND NEW."state" IN ('accepted', 'rejected') AND NEW."attemptCount" = 1)
  ) THEN
    RAISE EXCEPTION 'illegal ZATCA invoice submission state transition: % -> %', OLD."state", NEW."state"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."requestStartedAt" IS NOT NULL AND
     OLD."requestStartedAt" IS DISTINCT FROM NEW."requestStartedAt" THEN
    RAISE EXCEPTION 'ZATCA submission requestStartedAt is immutable once set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "zatca_invoice_submission_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "zatca_invoice_submissions"
FOR EACH ROW EXECUTE FUNCTION guard_zatca_invoice_submission();

COMMIT;
