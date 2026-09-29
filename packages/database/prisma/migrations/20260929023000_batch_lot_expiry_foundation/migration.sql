-- Mastermind V2-4 — Batch / Lot / Expiry provenance foundation (ADR-0039)
--
-- Product/branch InventoryBalance remains the only stock total.
-- InventoryMovement remains the only quantity-changing stock ledger.
-- These tables distribute/prove canonical movement quantity by lot; they never
-- introduce a mutable lot stock counter or a lot cost pool.
BEGIN;

ALTER TABLE "tenant_settings"
  ADD COLUMN "businessTimeZone" TEXT NOT NULL DEFAULT 'Asia/Riyadh';

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_business_timezone_bounded"
  CHECK (
    "businessTimeZone" = btrim("businessTimeZone")
    AND char_length("businessTimeZone") BETWEEN 1 AND 100
  );

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_tenant_id_key"
  ON "inventory_movements"("tenantId","id");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_movements_tenant_id_branch_product_key"
  ON "inventory_movements"("tenantId","id","branchId","productId");
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_receipt_lines_tenant_id_key"
  ON "purchase_receipt_lines"("tenantId","id");
CREATE UNIQUE INDEX IF NOT EXISTS "return_lines_tenant_id_key"
  ON "return_lines"("tenantId","id");

CREATE TABLE "product_lot_policies" (
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "trackingMode" TEXT NOT NULL DEFAULT 'none',
  "selectionPolicy" TEXT NOT NULL DEFAULT 'fefo',
  "dateRequirement" TEXT NOT NULL DEFAULT 'optional',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_lot_policies_pkey" PRIMARY KEY ("tenantId","productId"),
  CONSTRAINT "product_lot_policies_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_lot_policies_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_lot_policies_tracking"
    CHECK ("trackingMode" IN ('none','required')),
  CONSTRAINT "product_lot_policies_selection"
    CHECK ("selectionPolicy" IN ('fefo','fifo')),
  CONSTRAINT "product_lot_policies_date_requirement"
    CHECK ("dateRequirement" IN ('optional','required')),
  CONSTRAINT "product_lot_policies_revision_positive"
    CHECK ("revision" > 0)
);

CREATE TABLE "inventory_lots" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "internalCode" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "externalBatchReference" TEXT,
  "dateKind" TEXT,
  "dateValue" DATE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "firstObservedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_lots_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_lots_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lots_internal_code_bounded"
    CHECK (
      "internalCode" = btrim("internalCode")
      AND char_length("internalCode") BETWEEN 1 AND 64
    ),
  CONSTRAINT "inventory_lots_provenance"
    CHECK ("provenance" IN ('received','produced','historical-unknown','manual-correction')),
  CONSTRAINT "inventory_lots_external_batch_bounded"
    CHECK (
      "externalBatchReference" IS NULL
      OR (
        "externalBatchReference" = btrim("externalBatchReference")
        AND char_length("externalBatchReference") BETWEEN 1 AND 120
      )
    ),
  CONSTRAINT "inventory_lots_date_shape"
    CHECK (
      ("dateKind" IS NULL AND "dateValue" IS NULL)
      OR ("dateKind" IN ('expiry','best-before') AND "dateValue" IS NOT NULL)
    ),
  CONSTRAINT "inventory_lots_status"
    CHECK ("status" IN ('active','blocked','closed')),
  CONSTRAINT "inventory_lots_revision_positive"
    CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "inventory_lots_tenant_id_key"
  ON "inventory_lots"("tenantId","id");
CREATE UNIQUE INDEX "inventory_lots_tenant_product_id_key"
  ON "inventory_lots"("tenantId","productId","id");
CREATE UNIQUE INDEX "inventory_lots_tenant_product_code_key"
  ON "inventory_lots"("tenantId","productId","internalCode");
CREATE UNIQUE INDEX "inventory_lots_tenant_product_external_batch_key"
  ON "inventory_lots"("tenantId","productId","externalBatchReference");
CREATE INDEX "inventory_lots_tenant_product_status_idx"
  ON "inventory_lots"("tenantId","productId","status");
CREATE INDEX "inventory_lots_tenant_product_date_idx"
  ON "inventory_lots"("tenantId","productId","dateValue");

CREATE TABLE "inventory_lot_reclassifications" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "expectedBalanceRevision" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_lot_reclassifications_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_reclassifications_branch_fkey"
    FOREIGN KEY ("tenantId","branchId") REFERENCES "branches"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_reclassifications_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_reclassifications_actor_fkey"
    FOREIGN KEY ("tenantId","actorUserId") REFERENCES "users"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_reclassifications_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 120),
  CONSTRAINT "inventory_lot_reclassifications_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "inventory_lot_reclassifications_revision_nonnegative"
    CHECK ("expectedBalanceRevision" >= 0),
  CONSTRAINT "inventory_lot_reclassifications_reason_bounded"
    CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "inventory_lot_reclassifications_tenant_id_key"
  ON "inventory_lot_reclassifications"("tenantId","id");
CREATE UNIQUE INDEX "inventory_lot_reclassifications_tenant_id_branch_product_key"
  ON "inventory_lot_reclassifications"("tenantId","id","branchId","productId");
CREATE UNIQUE INDEX "inventory_lot_reclassifications_tenant_operation_key"
  ON "inventory_lot_reclassifications"("tenantId","operationId");
CREATE INDEX "inventory_lot_reclassifications_tenant_branch_product_time_idx"
  ON "inventory_lot_reclassifications"("tenantId","branchId","productId","occurredAt");

CREATE TABLE "inventory_lot_entries" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lotId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "causeKind" TEXT NOT NULL,
  "inventoryMovementId" UUID,
  "reclassificationId" UUID,
  "actorUserId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_lot_entries_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_branch_fkey"
    FOREIGN KEY ("tenantId","branchId") REFERENCES "branches"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_lot_fkey"
    FOREIGN KEY ("tenantId","productId","lotId") REFERENCES "inventory_lots"("tenantId","productId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_movement_fkey"
    FOREIGN KEY ("tenantId","inventoryMovementId","branchId","productId")
    REFERENCES "inventory_movements"("tenantId","id","branchId","productId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_reclassification_fkey"
    FOREIGN KEY ("tenantId","reclassificationId","branchId","productId")
    REFERENCES "inventory_lot_reclassifications"("tenantId","id","branchId","productId") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_actor_fkey"
    FOREIGN KEY ("tenantId","actorUserId") REFERENCES "users"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_lot_entries_quantity_nonzero"
    CHECK ("quantityScaled" <> 0),
  CONSTRAINT "inventory_lot_entries_cause"
    CHECK ("causeKind" IN ('tracking-baseline','movement','reclassification')),
  CONSTRAINT "inventory_lot_entries_cause_shape"
    CHECK (
      ("causeKind" = 'tracking-baseline' AND "inventoryMovementId" IS NULL AND "reclassificationId" IS NULL)
      OR ("causeKind" = 'movement' AND "inventoryMovementId" IS NOT NULL AND "reclassificationId" IS NULL)
      OR ("causeKind" = 'reclassification' AND "inventoryMovementId" IS NULL AND "reclassificationId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "inventory_lot_entries_tenant_id_key"
  ON "inventory_lot_entries"("tenantId","id");
CREATE UNIQUE INDEX "inventory_lot_entries_one_lot_per_movement_key"
  ON "inventory_lot_entries"("tenantId","inventoryMovementId","lotId")
  WHERE "inventoryMovementId" IS NOT NULL;
CREATE UNIQUE INDEX "inventory_lot_entries_one_lot_per_reclassification_key"
  ON "inventory_lot_entries"("tenantId","reclassificationId","lotId")
  WHERE "reclassificationId" IS NOT NULL;
CREATE UNIQUE INDEX "inventory_lot_entries_one_baseline_per_branch_product_key"
  ON "inventory_lot_entries"("tenantId","branchId","productId")
  WHERE "causeKind" = 'tracking-baseline';
CREATE INDEX "inventory_lot_entries_availability_idx"
  ON "inventory_lot_entries"("tenantId","branchId","productId","lotId","occurredAt");
CREATE INDEX "inventory_lot_entries_movement_idx"
  ON "inventory_lot_entries"("tenantId","inventoryMovementId");
CREATE INDEX "inventory_lot_entries_reclassification_idx"
  ON "inventory_lot_entries"("tenantId","reclassificationId");

CREATE TABLE "purchase_receipt_lot_allocations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "purchaseReceiptLineId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lotId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "internalCode" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "externalBatchReference" TEXT,
  "dateKind" TEXT,
  "dateValue" DATE,

  CONSTRAINT "purchase_receipt_lot_allocations_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "purchase_receipt_lot_allocations_line_fkey"
    FOREIGN KEY ("tenantId","purchaseReceiptLineId") REFERENCES "purchase_receipt_lines"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "purchase_receipt_lot_allocations_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "purchase_receipt_lot_allocations_lot_fkey"
    FOREIGN KEY ("tenantId","productId","lotId") REFERENCES "inventory_lots"("tenantId","productId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "purchase_receipt_lot_allocations_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "purchase_receipt_lot_allocations_date_shape"
    CHECK (
      ("dateKind" IS NULL AND "dateValue" IS NULL)
      OR ("dateKind" IN ('expiry','best-before') AND "dateValue" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "purchase_receipt_lot_allocations_tenant_id_key"
  ON "purchase_receipt_lot_allocations"("tenantId","id");
CREATE UNIQUE INDEX "purchase_receipt_lot_allocations_line_lot_key"
  ON "purchase_receipt_lot_allocations"("tenantId","purchaseReceiptLineId","lotId");
CREATE INDEX "purchase_receipt_lot_allocations_product_lot_idx"
  ON "purchase_receipt_lot_allocations"("tenantId","productId","lotId");

CREATE TABLE "sale_line_lot_allocations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleLineId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lotId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "internalCode" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "externalBatchReference" TEXT,
  "dateKind" TEXT,
  "dateValue" DATE,

  CONSTRAINT "sale_line_lot_allocations_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_line_lot_allocations_line_fkey"
    FOREIGN KEY ("tenantId","saleLineId") REFERENCES "sale_lines"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_line_lot_allocations_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sale_line_lot_allocations_lot_fkey"
    FOREIGN KEY ("tenantId","productId","lotId") REFERENCES "inventory_lots"("tenantId","productId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sale_line_lot_allocations_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "sale_line_lot_allocations_date_shape"
    CHECK (
      ("dateKind" IS NULL AND "dateValue" IS NULL)
      OR ("dateKind" IN ('expiry','best-before') AND "dateValue" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "sale_line_lot_allocations_tenant_id_key"
  ON "sale_line_lot_allocations"("tenantId","id");
CREATE UNIQUE INDEX "sale_line_lot_allocations_line_lot_key"
  ON "sale_line_lot_allocations"("tenantId","saleLineId","lotId");
CREATE INDEX "sale_line_lot_allocations_product_lot_idx"
  ON "sale_line_lot_allocations"("tenantId","productId","lotId");

CREATE TABLE "return_line_lot_allocations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "returnLineId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "lotId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "internalCode" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "externalBatchReference" TEXT,
  "dateKind" TEXT,
  "dateValue" DATE,

  CONSTRAINT "return_line_lot_allocations_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_line_lot_allocations_line_fkey"
    FOREIGN KEY ("tenantId","returnLineId") REFERENCES "return_lines"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_line_lot_allocations_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "return_line_lot_allocations_lot_fkey"
    FOREIGN KEY ("tenantId","productId","lotId") REFERENCES "inventory_lots"("tenantId","productId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "return_line_lot_allocations_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "return_line_lot_allocations_date_shape"
    CHECK (
      ("dateKind" IS NULL AND "dateValue" IS NULL)
      OR ("dateKind" IN ('expiry','best-before') AND "dateValue" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "return_line_lot_allocations_tenant_id_key"
  ON "return_line_lot_allocations"("tenantId","id");
CREATE UNIQUE INDEX "return_line_lot_allocations_line_lot_key"
  ON "return_line_lot_allocations"("tenantId","returnLineId","lotId");
CREATE INDEX "return_line_lot_allocations_product_lot_idx"
  ON "return_line_lot_allocations"("tenantId","productId","lotId");

-- ---------------------------------------------------------------------------
-- Database invariants for immutable provenance and derived availability.
-- ---------------------------------------------------------------------------

CREATE FUNCTION reject_v2_4_lot_fact_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finalized V2-4 lot provenance is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "inventory_lot_entries_immutable"
BEFORE UPDATE ON "inventory_lot_entries"
FOR EACH ROW EXECUTE FUNCTION reject_v2_4_lot_fact_update();

CREATE TRIGGER "inventory_lot_reclassifications_immutable"
BEFORE UPDATE ON "inventory_lot_reclassifications"
FOR EACH ROW EXECUTE FUNCTION reject_v2_4_lot_fact_update();

CREATE TRIGGER "purchase_receipt_lot_allocations_immutable"
BEFORE UPDATE ON "purchase_receipt_lot_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_v2_4_lot_fact_update();

CREATE TRIGGER "sale_line_lot_allocations_immutable"
BEFORE UPDATE ON "sale_line_lot_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_v2_4_lot_fact_update();

CREATE TRIGGER "return_line_lot_allocations_immutable"
BEFORE UPDATE ON "return_line_lot_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_v2_4_lot_fact_update();

CREATE FUNCTION protect_v2_4_lot_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."productId" IS DISTINCT FROM OLD."productId"
     OR NEW."internalCode" IS DISTINCT FROM OLD."internalCode"
     OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
     OR NEW."externalBatchReference" IS DISTINCT FROM OLD."externalBatchReference"
     OR NEW."dateKind" IS DISTINCT FROM OLD."dateKind"
     OR NEW."dateValue" IS DISTINCT FROM OLD."dateValue"
     OR NEW."firstObservedAt" IS DISTINCT FROM OLD."firstObservedAt"
  THEN
    RAISE EXCEPTION 'lot identity and received provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_lots_identity_immutable"
BEFORE UPDATE ON "inventory_lots"
FOR EACH ROW EXECUTE FUNCTION protect_v2_4_lot_identity();

CREATE FUNCTION assert_v2_4_movement_lot_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant UUID;
  v_movement UUID;
  v_product UUID;
  v_quantity BIGINT;
  v_tracking TEXT;
  v_allocated BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_movements' THEN
    v_tenant := NEW."tenantId";
    v_movement := NEW."id";
    v_product := NEW."productId";
    v_quantity := NEW."quantityScaled";
  ELSE
    IF NEW."inventoryMovementId" IS NULL THEN
      RETURN NULL;
    END IF;
    v_tenant := NEW."tenantId";
    v_movement := NEW."inventoryMovementId";
    SELECT "productId","quantityScaled"
      INTO v_product,v_quantity
      FROM "inventory_movements"
     WHERE "tenantId" = v_tenant AND "id" = v_movement;
  END IF;

  SELECT "trackingMode"
    INTO v_tracking
    FROM "product_lot_policies"
   WHERE "tenantId" = v_tenant AND "productId" = v_product;

  IF v_tracking = 'required' THEN
    SELECT COALESCE(SUM("quantityScaled"),0)
      INTO v_allocated
      FROM "inventory_lot_entries"
     WHERE "tenantId" = v_tenant
       AND "inventoryMovementId" = v_movement
       AND "causeKind" = 'movement';

    IF v_allocated <> v_quantity THEN
      RAISE EXCEPTION 'lot allocations (%) do not reconcile to inventory movement (%)',
        v_allocated, v_quantity
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "inventory_movements_lot_reconciliation"
AFTER INSERT OR UPDATE OF "quantityScaled","productId","branchId"
ON "inventory_movements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_movement_lot_reconciliation();

CREATE CONSTRAINT TRIGGER "inventory_lot_entries_movement_reconciliation"
AFTER INSERT ON "inventory_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_movement_lot_reconciliation();

CREATE FUNCTION assert_v2_4_lot_nonnegative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_available BIGINT;
BEGIN
  SELECT COALESCE(SUM("quantityScaled"),0)
    INTO v_available
    FROM "inventory_lot_entries"
   WHERE "tenantId" = NEW."tenantId"
     AND "branchId" = NEW."branchId"
     AND "productId" = NEW."productId"
     AND "lotId" = NEW."lotId";

  IF v_available < 0 THEN
    RAISE EXCEPTION 'derived lot availability cannot be negative'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "inventory_lot_entries_nonnegative"
AFTER INSERT ON "inventory_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_lot_nonnegative();

CREATE FUNCTION assert_v2_4_tracking_distribution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad_count INTEGER;
BEGIN
  IF NEW."trackingMode" <> 'required' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)
    INTO bad_count
    FROM "inventory_balances" b
   WHERE b."tenantId" = NEW."tenantId"
     AND b."productId" = NEW."productId"
     AND (
       b."quantityScaled" < 0
       OR b."quantityScaled" <> COALESCE((
         SELECT SUM(e."quantityScaled")
           FROM "inventory_lot_entries" e
          WHERE e."tenantId" = b."tenantId"
            AND e."branchId" = b."branchId"
            AND e."productId" = b."productId"
       ),0)
     );

  IF bad_count <> 0 THEN
    RAISE EXCEPTION 'required lot distribution does not reconcile to canonical inventory balance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "product_lot_policies_distribution_reconciles"
AFTER INSERT OR UPDATE OF "trackingMode"
ON "product_lot_policies"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_tracking_distribution();

CREATE FUNCTION assert_v2_4_reclassification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sum BIGINT;
  v_revision BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_lot_reclassifications' THEN
    SELECT COALESCE(SUM("quantityScaled"),0)
      INTO v_sum
      FROM "inventory_lot_entries"
     WHERE "tenantId" = NEW."tenantId"
       AND "reclassificationId" = NEW."id"
       AND "causeKind" = 'reclassification';

    SELECT "revision"
      INTO v_revision
      FROM "inventory_balances"
     WHERE "tenantId" = NEW."tenantId"
       AND "branchId" = NEW."branchId"
       AND "productId" = NEW."productId";

    IF v_sum <> 0 OR v_revision IS DISTINCT FROM NEW."expectedBalanceRevision" THEN
      RAISE EXCEPTION 'lot reclassification must be zero-net against the observed balance revision'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."reclassificationId" IS NOT NULL THEN
    SELECT COALESCE(SUM("quantityScaled"),0)
      INTO v_sum
      FROM "inventory_lot_entries"
     WHERE "tenantId" = NEW."tenantId"
       AND "reclassificationId" = NEW."reclassificationId"
       AND "causeKind" = 'reclassification';
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'lot reclassification entries must sum to zero'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "inventory_lot_reclassifications_zero_net"
AFTER INSERT ON "inventory_lot_reclassifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_reclassification();

CREATE CONSTRAINT TRIGGER "inventory_lot_entries_reclassification_zero_net"
AFTER INSERT ON "inventory_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_v2_4_reclassification();

-- ---------------------------------------------------------------------------
-- Tenant isolation.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_lot_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_lot_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_lot_policies_isolation" ON "product_lot_policies";
CREATE POLICY "product_lot_policies_isolation" ON "product_lot_policies"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_lots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_lots_isolation" ON "inventory_lots";
CREATE POLICY "inventory_lots_isolation" ON "inventory_lots"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_lot_reclassifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_lot_reclassifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_lot_reclassifications_isolation" ON "inventory_lot_reclassifications";
CREATE POLICY "inventory_lot_reclassifications_isolation" ON "inventory_lot_reclassifications"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_lot_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_lot_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_lot_entries_isolation" ON "inventory_lot_entries";
CREATE POLICY "inventory_lot_entries_isolation" ON "inventory_lot_entries"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "purchase_receipt_lot_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipt_lot_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_receipt_lot_allocations_isolation" ON "purchase_receipt_lot_allocations";
CREATE POLICY "purchase_receipt_lot_allocations_isolation" ON "purchase_receipt_lot_allocations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_line_lot_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_line_lot_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_line_lot_allocations_isolation" ON "sale_line_lot_allocations";
CREATE POLICY "sale_line_lot_allocations_isolation" ON "sale_line_lot_allocations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "return_line_lot_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_line_lot_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "return_line_lot_allocations_isolation" ON "return_line_lot_allocations";
CREATE POLICY "return_line_lot_allocations_isolation" ON "return_line_lot_allocations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- Dedicated administration permission; automatic lot selection inherits the
-- authority of the parent stock/sale/receipt operation.
INSERT INTO "permissions" ("key","descriptionAr","descriptionEn")
VALUES ('lot.manage','إدارة الدفعات والصلاحية','Manage lots and expiry policy')
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permissions" ("id","tenantId","roleId","permissionKey")
SELECT
  (
    lpad(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
    || '7'
    || substr(replace(gen_random_uuid()::text, '-', ''), 14, 3)
    || substr(replace(gen_random_uuid()::text, '-', ''), 17, 16)
  )::uuid,
  r."tenantId",
  r."id",
  'lot.manage'
FROM "roles" r
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager','admin','owner')
ON CONFLICT ("tenantId","roleId","permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
