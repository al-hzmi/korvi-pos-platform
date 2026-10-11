-- V2-6 phase 1 — append-only, consent-backed customer loyalty points.
-- Forward-only and additive: no historical sale is silently awarded points.
-- Points are not SAR, customer credit, gift cards, stored value or tax authority.
BEGIN;

CREATE TABLE "loyalty_programs" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "nameAr" TEXT NOT NULL,
  "earnNumerator" BIGINT NOT NULL,
  "earnDenominator" BIGINT NOT NULL,
  "redeemValueMinorPerPoint" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_programs_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_programs_values_check" CHECK (
    "status" IN ('draft', 'active', 'paused') AND "revision" > 0
    AND length(btrim("nameAr")) BETWEEN 1 AND 120
    AND "earnNumerator" > 0 AND "earnDenominator" > 0
    AND "redeemValueMinorPerPoint" > 0
  )
);
CREATE UNIQUE INDEX "loyalty_programs_tenant_id_key" ON "loyalty_programs"("tenantId", "id");

CREATE TABLE "loyalty_enrollments" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "programId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "consentedAt" TIMESTAMP(3) NOT NULL,
  "consentedByUserId" UUID NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_enrollments_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_enrollments_program_fkey" FOREIGN KEY ("tenantId","programId")
    REFERENCES "loyalty_programs"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_enrollments_customer_fkey" FOREIGN KEY ("tenantId","customerId")
    REFERENCES "customers"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_enrollments_actor_fkey" FOREIGN KEY ("tenantId","consentedByUserId")
    REFERENCES "users"("tenantId","id") ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "loyalty_enrollments_tenant_id_key" ON "loyalty_enrollments"("tenantId","id");
CREATE UNIQUE INDEX "loyalty_enrollments_customer_key" ON "loyalty_enrollments"("tenantId","customerId");
CREATE INDEX "loyalty_enrollments_program_active_idx" ON "loyalty_enrollments"("tenantId","programId","isActive");

CREATE TABLE "loyalty_point_entries" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "programId" UUID NOT NULL,
  "enrollmentId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "pointsDelta" BIGINT NOT NULL,
  "programRevision" BIGINT NOT NULL,
  "earnNumerator" BIGINT NOT NULL,
  "earnDenominator" BIGINT NOT NULL,
  "redeemValueMinorPerPoint" BIGINT NOT NULL,
  "eligibleMinor" BIGINT,
  "saleId" UUID,
  "returnId" UUID,
  "reversesEntryId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loyalty_points_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "loyalty_points_program_fkey" FOREIGN KEY ("tenantId","programId")
    REFERENCES "loyalty_programs"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_enrollment_fkey" FOREIGN KEY ("tenantId","enrollmentId")
    REFERENCES "loyalty_enrollments"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_customer_fkey" FOREIGN KEY ("tenantId","customerId")
    REFERENCES "customers"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_sale_fkey" FOREIGN KEY ("tenantId","saleId")
    REFERENCES "sales"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_return_fkey" FOREIGN KEY ("tenantId","returnId")
    REFERENCES "returns"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_reversal_fkey" FOREIGN KEY ("tenantId","reversesEntryId")
    REFERENCES "loyalty_point_entries"("tenantId","id") ON DELETE NO ACTION,
  CONSTRAINT "loyalty_points_valid_check" CHECK (
    char_length("operationId") BETWEEN 1 AND 120
    AND "programRevision" > 0
    AND "earnNumerator" > 0 AND "earnDenominator" > 0
    AND "redeemValueMinorPerPoint" > 0
    AND ("eligibleMinor" IS NULL OR "eligibleMinor" >= 0)
    AND (
      ("kind" = 'earn' AND "pointsDelta" > 0 AND "saleId" IS NOT NULL
       AND "returnId" IS NULL AND "reversesEntryId" IS NULL AND "eligibleMinor" IS NOT NULL)
      OR ("kind" = 'redeem' AND "pointsDelta" < 0 AND "saleId" IS NOT NULL
       AND "returnId" IS NULL AND "reversesEntryId" IS NULL AND "eligibleMinor" IS NULL)
      OR ("kind" = 'reverse-earn' AND "pointsDelta" < 0 AND "saleId" IS NULL
       AND "returnId" IS NOT NULL AND "reversesEntryId" IS NOT NULL AND "eligibleMinor" IS NULL)
      OR ("kind" = 'restore-redeem' AND "pointsDelta" > 0 AND "saleId" IS NULL
       AND "returnId" IS NOT NULL AND "reversesEntryId" IS NOT NULL AND "eligibleMinor" IS NULL)
    )
  )
);
CREATE UNIQUE INDEX "loyalty_points_tenant_id_key" ON "loyalty_point_entries"("tenantId","id");
CREATE UNIQUE INDEX "loyalty_points_operation_key" ON "loyalty_point_entries"("tenantId","operationId");
CREATE UNIQUE INDEX "loyalty_points_one_sale_kind" ON "loyalty_point_entries"("tenantId","saleId","kind")
  WHERE "saleId" IS NOT NULL;
CREATE UNIQUE INDEX "loyalty_points_one_return_kind" ON "loyalty_point_entries"("tenantId","returnId","kind")
  WHERE "returnId" IS NOT NULL;
CREATE INDEX "loyalty_points_customer_history_idx"
  ON "loyalty_point_entries"("tenantId","enrollmentId","occurredAt","id");
CREATE INDEX "loyalty_points_sale_idx" ON "loyalty_point_entries"("tenantId","saleId","kind");
CREATE INDEX "loyalty_points_return_idx" ON "loyalty_point_entries"("tenantId","returnId","kind");

-- Any attempt to mutate historical points fails, even under an authorized tenant.
CREATE FUNCTION forbid_loyalty_point_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'loyalty point entries are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "loyalty_point_entries_immutable"
BEFORE UPDATE OR DELETE ON "loyalty_point_entries"
FOR EACH ROW EXECUTE FUNCTION forbid_loyalty_point_rewrite();

-- Serialize every debit/credit against the enrollment row, not an app mutex.
-- Verify tenant/customer/program consent and reversal source in the same lock.
CREATE FUNCTION guard_loyalty_point_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  enrolled RECORD;
  previous_entry RECORD;
  prior_balance BIGINT;
  reversed_points BIGINT;
  sale_customer UUID;
  related_sale UUID;
BEGIN
  SELECT e."customerId", e."programId", e."isActive", p."status", p."revision"
    INTO enrolled
    FROM "loyalty_enrollments" e JOIN "loyalty_programs" p
      ON p."tenantId" = e."tenantId" AND p."id" = e."programId"
   WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."enrollmentId"
   FOR UPDATE OF e;
  IF NOT FOUND OR enrolled."customerId" <> NEW."customerId"
     OR enrolled."programId" <> NEW."programId" THEN
    RAISE EXCEPTION 'loyalty enrollment does not own entry' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" IN ('earn','redeem') AND
     (NOT enrolled."isActive" OR enrolled."status" <> 'active'
      OR enrolled."revision" <> NEW."programRevision") THEN
    RAISE EXCEPTION 'loyalty policy or consent is no longer active' USING ERRCODE = '23514';
  END IF;
  IF NEW."saleId" IS NOT NULL THEN
    SELECT "customerId" INTO sale_customer FROM "sales"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."saleId" AND "status" = 'finalized';
    IF NOT FOUND OR sale_customer IS DISTINCT FROM NEW."customerId" THEN
      RAISE EXCEPTION 'loyalty sale customer identity mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."reversesEntryId" IS NOT NULL THEN
    SELECT "id", "kind", "pointsDelta", "enrollmentId", "saleId" INTO previous_entry
      FROM "loyalty_point_entries"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."reversesEntryId";
    IF NOT FOUND OR previous_entry."enrollmentId" <> NEW."enrollmentId" OR
      NOT (
        (NEW."kind" = 'reverse-earn' AND previous_entry."kind" = 'earn') OR
        (NEW."kind" = 'restore-redeem' AND previous_entry."kind" = 'redeem')
      ) THEN
      RAISE EXCEPTION 'loyalty reversal must identify matching original entry' USING ERRCODE = '23514';
    END IF;
    SELECT "saleId" INTO related_sale FROM "returns"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."returnId" AND "status" = 'finalized';
    IF NOT FOUND OR related_sale <> previous_entry."saleId" THEN
      RAISE EXCEPTION 'loyalty reversal return belongs to a different sale' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(abs("pointsDelta")), 0) INTO reversed_points
      FROM "loyalty_point_entries"
     WHERE "tenantId" = NEW."tenantId" AND "reversesEntryId" = NEW."reversesEntryId";
    IF reversed_points + abs(NEW."pointsDelta") > abs(previous_entry."pointsDelta") THEN
      RAISE EXCEPTION 'loyalty reversal exceeds original points' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM("pointsDelta"), 0) INTO prior_balance
    FROM "loyalty_point_entries"
   WHERE "tenantId" = NEW."tenantId" AND "enrollmentId" = NEW."enrollmentId";
  IF prior_balance + NEW."pointsDelta" < 0 THEN
    RAISE EXCEPTION 'loyalty points may not be overdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "loyalty_point_entries_append_guard"
BEFORE INSERT ON "loyalty_point_entries"
FOR EACH ROW EXECUTE FUNCTION guard_loyalty_point_append();

ALTER TABLE "loyalty_programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_programs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_programs_isolation" ON "loyalty_programs"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "loyalty_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_enrollments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_enrollments_isolation" ON "loyalty_enrollments"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "loyalty_point_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_point_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_point_entries_isolation" ON "loyalty_point_entries"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

INSERT INTO "permissions" ("key","descriptionAr","descriptionEn")
VALUES ('loyalty.manage', 'إدارة سياسات الولاء', 'Manage loyalty policies')
ON CONFLICT ("key") DO NOTHING;
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "role_permissions" ("id","tenantId","roleId","permissionKey")
SELECT gen_random_uuid(), r."tenantId", r."id", 'loyalty.manage'
  FROM "roles" r
 WHERE r."isSystem" = TRUE AND r."key" IN ('manager','admin','owner')
ON CONFLICT ("tenantId","roleId","permissionKey") DO NOTHING;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
COMMIT;
