-- Korvi Mastermind V2-1 — no-receipt exchange authority (ADR-0036)
--
-- Forward only. No historical sale/tax/tender/cost facts are inferred.
BEGIN;

ALTER TABLE "inventory_movements"
  DROP CONSTRAINT "inventory_movements_kind";
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_kind"
  CHECK (
    "kind" IN (
      'sale',
      'return',
      'adjustment',
      'receipt',
      'transfer',
      'production-consumption',
      'production-output',
      'no-receipt-exchange-intake'
    )
  );

ALTER TABLE "tenders" DROP CONSTRAINT "tenders_kind";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_kind"
  CHECK ("kind" IN ('cash', 'card', 'mada', 'transfer', 'electronic', 'exchange_allowance'));

ALTER TABLE "tenders" ADD CONSTRAINT "tenders_exchange_allowance_shape"
  CHECK (
    "kind" <> 'exchange_allowance'
    OR ("scheme" IS NULL AND "reference" IS NULL AND "changeMinor" = 0)
  );

CREATE UNIQUE INDEX "tenders_one_exchange_allowance_per_sale"
  ON "tenders"("tenantId", "saleId")
  WHERE "kind" = 'exchange_allowance';

CREATE TABLE "no_receipt_exchange_cases" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "sequence" INTEGER NOT NULL,
  "caseNumber" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceNote" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "referenceCeilingMinor" BIGINT NOT NULL,
  "approvedAllowanceMinor" BIGINT NOT NULL,
  "linkedSaleId" UUID NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "no_receipt_exchange_cases_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_cases_branch_fkey"
    FOREIGN KEY ("tenantId","branchId") REFERENCES "branches"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_cases_terminal_fkey"
    FOREIGN KEY ("tenantId","terminalId") REFERENCES "terminals"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_cases_shift_fkey"
    FOREIGN KEY ("tenantId","shiftId") REFERENCES "shifts"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_cases_actor_fkey"
    FOREIGN KEY ("tenantId","actorUserId") REFERENCES "users"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_cases_sale_fkey"
    FOREIGN KEY ("tenantId","linkedSaleId") REFERENCES "sales"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "no_receipt_exchange_cases_status" CHECK ("status" = 'finalized'),
  CONSTRAINT "no_receipt_exchange_cases_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 120),
  CONSTRAINT "no_receipt_exchange_cases_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "no_receipt_exchange_cases_reason_bounded"
    CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 200),
  CONSTRAINT "no_receipt_exchange_cases_evidence_bounded"
    CHECK (
      "evidenceNote" IS NULL
      OR ("evidenceNote" = btrim("evidenceNote") AND char_length("evidenceNote") BETWEEN 1 AND 500)
    ),
  CONSTRAINT "no_receipt_exchange_cases_values"
    CHECK (
      "referenceCeilingMinor" >= 0
      AND "approvedAllowanceMinor" >= 0
      AND "approvedAllowanceMinor" <= "referenceCeilingMinor"
    ),
  CONSTRAINT "no_receipt_exchange_cases_sequence_positive" CHECK ("sequence" > 0)
);

CREATE UNIQUE INDEX "no_receipt_exchange_cases_tenant_id_key"
  ON "no_receipt_exchange_cases"("tenantId","id");
CREATE UNIQUE INDEX "no_receipt_exchange_cases_tenant_operation_key"
  ON "no_receipt_exchange_cases"("tenantId","operationId");
CREATE UNIQUE INDEX "no_receipt_exchange_cases_tenant_branch_sequence_key"
  ON "no_receipt_exchange_cases"("tenantId","branchId","sequence");
CREATE UNIQUE INDEX "no_receipt_exchange_cases_tenant_number_key"
  ON "no_receipt_exchange_cases"("tenantId","caseNumber");
CREATE UNIQUE INDEX "no_receipt_exchange_cases_tenant_linked_sale_key"
  ON "no_receipt_exchange_cases"("tenantId","linkedSaleId");
CREATE INDEX "no_receipt_exchange_cases_tenant_branch_issued_idx"
  ON "no_receipt_exchange_cases"("tenantId","branchId","issuedAt");
CREATE INDEX "no_receipt_exchange_cases_tenant_actor_issued_idx"
  ON "no_receipt_exchange_cases"("tenantId","actorUserId","issuedAt");

CREATE TABLE "no_receipt_exchange_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "productType" TEXT NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "currentUnitReferencePriceMinor" BIGINT NOT NULL,
  "currentVatBasisPoints" INTEGER NOT NULL,
  "currentReferenceTotalMinor" BIGINT NOT NULL,
  "trackInventory" BOOLEAN NOT NULL,
  "stockDisposition" TEXT NOT NULL DEFAULT 'sellable',
  "costProvenance" TEXT NOT NULL DEFAULT 'unknown',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "no_receipt_exchange_lines_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_lines_case_fkey"
    FOREIGN KEY ("tenantId","caseId") REFERENCES "no_receipt_exchange_cases"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "no_receipt_exchange_lines_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "no_receipt_exchange_lines_number_positive" CHECK ("lineNumber" > 0),
  CONSTRAINT "no_receipt_exchange_lines_type" CHECK ("productType" IN ('unit','weighted')),
  CONSTRAINT "no_receipt_exchange_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "no_receipt_exchange_lines_unit_whole"
    CHECK ("productType" <> 'unit' OR mod("quantityScaled", 1000) = 0),
  CONSTRAINT "no_receipt_exchange_lines_reference_values"
    CHECK (
      "currentUnitReferencePriceMinor" >= 0
      AND "currentReferenceTotalMinor" >= 0
      AND "currentVatBasisPoints" BETWEEN 0 AND 10000
    ),
  CONSTRAINT "no_receipt_exchange_lines_stock_disposition" CHECK ("stockDisposition" = 'sellable'),
  CONSTRAINT "no_receipt_exchange_lines_cost_provenance" CHECK ("costProvenance" = 'unknown')
);

CREATE UNIQUE INDEX "no_receipt_exchange_lines_tenant_id_key"
  ON "no_receipt_exchange_lines"("tenantId","id");
CREATE UNIQUE INDEX "no_receipt_exchange_lines_tenant_case_number_key"
  ON "no_receipt_exchange_lines"("tenantId","caseId","lineNumber");
CREATE UNIQUE INDEX "no_receipt_exchange_lines_tenant_case_product_key"
  ON "no_receipt_exchange_lines"("tenantId","caseId","productId");
CREATE INDEX "no_receipt_exchange_lines_tenant_product_idx"
  ON "no_receipt_exchange_lines"("tenantId","productId");

ALTER TABLE "no_receipt_exchange_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "no_receipt_exchange_cases" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no_receipt_exchange_cases_isolation" ON "no_receipt_exchange_cases";
CREATE POLICY "no_receipt_exchange_cases_isolation" ON "no_receipt_exchange_cases"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "no_receipt_exchange_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "no_receipt_exchange_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no_receipt_exchange_lines_isolation" ON "no_receipt_exchange_lines";
CREATE POLICY "no_receipt_exchange_lines_isolation" ON "no_receipt_exchange_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

INSERT INTO "permissions" ("key", "descriptionAr", "descriptionEn")
VALUES (
  'sale.exchange.no-receipt',
  'اعتماد استبدال بدون فاتورة',
  'Approve no-receipt exchange'
)
ON CONFLICT ("key") DO NOTHING;

-- Existing tenant roles are FORCE-RLS protected. Lift FORCE only inside this
-- migration transaction, under ACCESS EXCLUSIVE locks, then restore before
-- COMMIT. This is the same forward-only pattern used by Strike 5A.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permissions" ("id", "tenantId", "roleId", "permissionKey")
SELECT
  (
    lpad(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 14, 3)
    || substr(replace(gen_random_uuid()::text, '-', ''), 17, 16)
  )::uuid,
  r."tenantId",
  r."id",
  'sale.exchange.no-receipt'
FROM "roles" r
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager', 'admin', 'owner')
ON CONFLICT ("tenantId", "roleId", "permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

-- Finalized no-receipt facts are append-only. Tenant deletion may still cascade
-- them as part of tenant lifecycle, but an application transaction cannot
-- rewrite the case or its line snapshots after commit.
CREATE FUNCTION reject_no_receipt_exchange_mutation() RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN
  IF TG_OP = ''DELETE'' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION ''finalized no-receipt exchange facts are immutable''
    USING ERRCODE = ''55000'';
END;';

CREATE TRIGGER "no_receipt_exchange_cases_immutable_update"
BEFORE UPDATE ON "no_receipt_exchange_cases"
FOR EACH ROW EXECUTE FUNCTION reject_no_receipt_exchange_mutation();

CREATE TRIGGER "no_receipt_exchange_cases_immutable_delete"
BEFORE DELETE ON "no_receipt_exchange_cases"
FOR EACH ROW EXECUTE FUNCTION reject_no_receipt_exchange_mutation();

CREATE TRIGGER "no_receipt_exchange_lines_immutable_update"
BEFORE UPDATE ON "no_receipt_exchange_lines"
FOR EACH ROW EXECUTE FUNCTION reject_no_receipt_exchange_mutation();

CREATE TRIGGER "no_receipt_exchange_lines_immutable_delete"
BEFORE DELETE ON "no_receipt_exchange_lines"
FOR EACH ROW EXECUTE FUNCTION reject_no_receipt_exchange_mutation();

COMMIT;
