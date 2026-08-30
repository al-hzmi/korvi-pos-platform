-- Korvi POS — Strike 5C: exact inventory costing authority.
--
-- Quantity remains BIGINT scaled by 1000. Money remains BIGINT minor units.
-- No historical cost is inferred: every pre-5C stock fact is explicitly
-- unknown and carries zero invented monetary value (ADR-0024 §8).

BEGIN;

-- ---------------------------------------------------------------------------
-- Cost evidence on the causal stock ledger
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory_movements"
  ADD COLUMN "costKnownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costUnknownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costProvenance" TEXT NOT NULL DEFAULT 'historical-unknown';

-- BIGINT_MIN has no positive BIGINT magnitude. If such a row somehow exists,
-- migration must fail loudly rather than overflow or invent evidence.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_quantity_has_bigint_magnitude"
  CHECK ("quantityScaled" <> '-9223372036854775808'::bigint);

UPDATE "inventory_movements"
SET
  "costKnownQuantityScaled" = 0,
  "costUnknownQuantityScaled" = CASE
    WHEN "quantityScaled" < 0 THEN -"quantityScaled"
    ELSE "quantityScaled"
  END,
  "costValueMinor" = 0,
  "costProvenance" = 'historical-unknown';

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  ADD CONSTRAINT "inventory_movements_cost_quantity_reconciles"
    CHECK (
      "costKnownQuantityScaled" + "costUnknownQuantityScaled"
      = CASE WHEN "quantityScaled" < 0 THEN -"quantityScaled" ELSE "quantityScaled" END
    ),
  ADD CONSTRAINT "inventory_movements_cost_value_requires_known_quantity"
    CHECK ("costKnownQuantityScaled" > 0 OR "costValueMinor" = 0),
  ADD CONSTRAINT "inventory_movements_cost_provenance"
    CHECK ("costProvenance" IN ('historical-unknown', 'unknown', 'recorded', 'mixed'));

-- ---------------------------------------------------------------------------
-- Immutable cost basis on sale/return/receipt lines
-- ---------------------------------------------------------------------------

ALTER TABLE "sale_lines"
  ADD COLUMN "costKnownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costUnknownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costProvenance" TEXT NOT NULL DEFAULT 'historical-unknown';

UPDATE "sale_lines"
SET
  "costKnownQuantityScaled" = 0,
  "costUnknownQuantityScaled" = "quantityScaled",
  "costValueMinor" = 0,
  "costProvenance" = 'historical-unknown';

ALTER TABLE "sale_lines"
  ADD CONSTRAINT "sale_lines_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  ADD CONSTRAINT "sale_lines_cost_quantity_reconciles"
    CHECK ("costKnownQuantityScaled" + "costUnknownQuantityScaled" = "quantityScaled"),
  ADD CONSTRAINT "sale_lines_cost_value_requires_known_quantity"
    CHECK ("costKnownQuantityScaled" > 0 OR "costValueMinor" = 0),
  ADD CONSTRAINT "sale_lines_cost_provenance"
    CHECK ("costProvenance" IN ('historical-unknown', 'unknown', 'recorded', 'mixed'));

ALTER TABLE "return_lines"
  ADD COLUMN "costKnownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costUnknownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costProvenance" TEXT NOT NULL DEFAULT 'historical-unknown';

UPDATE "return_lines"
SET
  "costKnownQuantityScaled" = 0,
  "costUnknownQuantityScaled" = "quantityScaled",
  "costValueMinor" = 0,
  "costProvenance" = 'historical-unknown';

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  ADD CONSTRAINT "return_lines_cost_quantity_reconciles"
    CHECK ("costKnownQuantityScaled" + "costUnknownQuantityScaled" = "quantityScaled"),
  ADD CONSTRAINT "return_lines_cost_value_requires_known_quantity"
    CHECK ("costKnownQuantityScaled" > 0 OR "costValueMinor" = 0),
  ADD CONSTRAINT "return_lines_cost_provenance"
    CHECK ("costProvenance" IN ('historical-unknown', 'unknown', 'recorded', 'mixed'));

ALTER TABLE "purchase_receipt_lines"
  ADD COLUMN "inventoryValueMinor" BIGINT,
  ADD COLUMN "costKnownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costUnknownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "costProvenance" TEXT NOT NULL DEFAULT 'historical-unknown';

UPDATE "purchase_receipt_lines"
SET
  "inventoryValueMinor" = NULL,
  "costKnownQuantityScaled" = 0,
  "costUnknownQuantityScaled" = "acceptedQuantityScaled",
  "costValueMinor" = 0,
  "costProvenance" = 'historical-unknown';

ALTER TABLE "purchase_receipt_lines"
  ADD CONSTRAINT "purchase_receipt_lines_inventory_value_nonnegative"
    CHECK ("inventoryValueMinor" IS NULL OR "inventoryValueMinor" >= 0),
  ADD CONSTRAINT "purchase_receipt_lines_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  ADD CONSTRAINT "purchase_receipt_lines_cost_quantity_reconciles"
    CHECK (
      "costKnownQuantityScaled" + "costUnknownQuantityScaled" = "acceptedQuantityScaled"
    ),
  ADD CONSTRAINT "purchase_receipt_lines_cost_value_requires_known_quantity"
    CHECK ("costKnownQuantityScaled" > 0 OR "costValueMinor" = 0),
  ADD CONSTRAINT "purchase_receipt_lines_cost_provenance"
    CHECK ("costProvenance" IN ('historical-unknown', 'unknown', 'recorded', 'mixed'));

-- ---------------------------------------------------------------------------
-- Current exact known-value pool (not a second stock truth)
-- ---------------------------------------------------------------------------

CREATE TABLE "inventory_cost_balances" (
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  -- Only the recorded-cost subset of positive on-hand stock. Total stock is
  -- always inventory_balances.quantityScaled and is never duplicated here.
  "knownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  "knownValueMinor" BIGINT NOT NULL DEFAULT 0,

  -- The stock revision this valuation state has processed. Any mismatch is an
  -- internal invariant failure, never a reason to guess at cost.
  "stockRevision" BIGINT NOT NULL DEFAULT 0,
  -- Independent valuation revision. Bootstrap and cost-bearing stock changes
  -- move this monotonically; it never substitutes for stockRevision.
  "costRevision" BIGINT NOT NULL DEFAULT 0,

  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_cost_balances_pkey"
    PRIMARY KEY ("tenantId", "branchId", "productId"),
  CONSTRAINT "inventory_cost_balances_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_cost_balances_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_cost_balances_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_cost_balances_nonnegative"
    CHECK (
      "knownQuantityScaled" >= 0
      AND "knownValueMinor" >= 0
      AND "stockRevision" >= 0
      AND "costRevision" >= 0
    ),
  CONSTRAINT "inventory_cost_balances_no_residual_value"
    CHECK ("knownQuantityScaled" > 0 OR "knownValueMinor" = 0)
);

CREATE INDEX "inventory_cost_balances_tenantId_branchId_idx"
  ON "inventory_cost_balances"("tenantId", "branchId");

-- Existing quantity is not evidence of historical acquisition cost. Seed only
-- synchronization evidence; every historical unit remains unknown.
INSERT INTO "inventory_cost_balances"
  ("tenantId", "branchId", "productId", "knownQuantityScaled", "knownValueMinor", "stockRevision", "costRevision", "updatedAt")
SELECT
  "tenantId", "branchId", "productId", 0, 0, "revision", 0, CURRENT_TIMESTAMP
FROM "inventory_balances";

-- ---------------------------------------------------------------------------
-- Append-only valuation evidence
-- ---------------------------------------------------------------------------

CREATE TABLE "inventory_valuation_events" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  "eventKind" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "knownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  "unknownQuantityScaled" BIGINT NOT NULL DEFAULT 0,
  "knownValueMinor" BIGINT NOT NULL DEFAULT 0,

  "sourceType" TEXT,
  "sourceId" UUID,
  "sourceLineId" UUID,
  "actorUserId" UUID,

  "stockRevision" BIGINT NOT NULL,
  "costRevision" BIGINT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_valuation_events_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_valuation_events_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_valuation_events_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_valuation_events_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "inventory_valuation_events_kind"
    CHECK ("eventKind" IN ('movement', 'bootstrap', 'deficit-catchup')),
  CONSTRAINT "inventory_valuation_events_provenance"
    CHECK ("provenance" IN ('unknown', 'recorded', 'mixed')),
  CONSTRAINT "inventory_valuation_events_nonnegative"
    CHECK (
      "knownQuantityScaled" >= 0
      AND "unknownQuantityScaled" >= 0
      AND "knownValueMinor" >= 0
      AND "stockRevision" >= 0
      AND "costRevision" >= 0
    ),
  CONSTRAINT "inventory_valuation_events_value_requires_known_quantity"
    CHECK ("knownQuantityScaled" > 0 OR "knownValueMinor" = 0)
);

CREATE UNIQUE INDEX "inventory_valuation_events_tenantId_id_key"
  ON "inventory_valuation_events"("tenantId", "id");
CREATE INDEX "inventory_valuation_events_tenantId_branch_product_occurred_idx"
  ON "inventory_valuation_events"("tenantId", "branchId", "productId", "occurredAt");
CREATE INDEX "inventory_valuation_events_tenantId_source_idx"
  ON "inventory_valuation_events"("tenantId", "sourceType", "sourceId");

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory_cost_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_cost_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_cost_balances_isolation" ON "inventory_cost_balances";
CREATE POLICY "inventory_cost_balances_isolation" ON "inventory_cost_balances"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_valuation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_valuation_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_valuation_events_isolation" ON "inventory_valuation_events";
CREATE POLICY "inventory_valuation_events_isolation" ON "inventory_valuation_events"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Cost permissions — existing and future system roles
-- ---------------------------------------------------------------------------

INSERT INTO "permissions" ("key", "descriptionAr", "descriptionEn")
VALUES
  ('inventory.cost.read', 'عرض تكلفة المخزون', 'View inventory cost'),
  ('inventory.cost.manage', 'إدارة تقييم تكلفة المخزون', 'Manage inventory valuation')
ON CONFLICT ("key") DO NOTHING;

-- Existing system roles receive the same grants the canonical domain map gives
-- new tenants. Custom roles and cashiers are deliberately untouched.
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
  granted."permissionKey"
FROM "roles" r
CROSS JOIN (
  VALUES ('inventory.cost.read'), ('inventory.cost.manage')
) AS granted("permissionKey")
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager', 'admin', 'owner')
ON CONFLICT ("tenantId", "roleId", "permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
