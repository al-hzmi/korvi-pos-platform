-- Korvi POS — governed restaurant waste/spoilage inventory authority.
-- Waste is an explicit causal document. Quantity/cost effects still flow through
-- the one inventory/cost ledger; this is not a second stock store or an ad-hoc adjustment.

BEGIN;

CREATE TABLE "restaurant_wastes" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "reasonType" TEXT NOT NULL,
  "note" TEXT,
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_wastes_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_wastes_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_wastes_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_wastes_reason"
    CHECK ("reasonType" IN ('waste', 'spoilage')),
  CONSTRAINT "restaurant_wastes_note"
    CHECK (
      "note" IS NULL
      OR ("note" = btrim("note") AND char_length("note") BETWEEN 1 AND 200)
    ),
  CONSTRAINT "restaurant_wastes_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 120),
  CONSTRAINT "restaurant_wastes_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "restaurant_wastes_tenantId_id_key"
  ON "restaurant_wastes"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_wastes_tenantId_operationId_key"
  ON "restaurant_wastes"("tenantId", "operationId");
CREATE INDEX "restaurant_wastes_tenantId_branchId_occurredAt_idx"
  ON "restaurant_wastes"("tenantId", "branchId", "occurredAt");
CREATE INDEX "restaurant_wastes_tenantId_reasonType_occurredAt_idx"
  ON "restaurant_wastes"("tenantId", "reasonType", "occurredAt");

CREATE TABLE "restaurant_waste_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "wasteId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "beforeQuantityScaled" BIGINT NOT NULL,
  "afterQuantityScaled" BIGINT NOT NULL,
  "resultRevision" BIGINT NOT NULL,
  "costKnownQuantityScaled" BIGINT NOT NULL,
  "costUnknownQuantityScaled" BIGINT NOT NULL,
  "costValueMinor" BIGINT NOT NULL,
  "costProvenance" TEXT NOT NULL,

  CONSTRAINT "restaurant_waste_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_waste_lines_tenantId_wasteId_fkey"
    FOREIGN KEY ("tenantId", "wasteId") REFERENCES "restaurant_wastes"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_waste_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_waste_lines_quantity_positive"
    CHECK ("quantityScaled" > 0),
  CONSTRAINT "restaurant_waste_lines_arithmetic"
    CHECK ("afterQuantityScaled" = "beforeQuantityScaled" - "quantityScaled"),
  CONSTRAINT "restaurant_waste_lines_revision_positive"
    CHECK ("resultRevision" > 0),
  CONSTRAINT "restaurant_waste_lines_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  CONSTRAINT "restaurant_waste_lines_cost_quantity"
    CHECK (
      "quantityScaled" = "costKnownQuantityScaled" + "costUnknownQuantityScaled"
    ),
  CONSTRAINT "restaurant_waste_lines_cost_provenance"
    CHECK ("costProvenance" IN ('unknown', 'recorded', 'mixed'))
);

CREATE UNIQUE INDEX "restaurant_waste_lines_tenantId_id_key"
  ON "restaurant_waste_lines"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_waste_lines_tenant_waste_product_key"
  ON "restaurant_waste_lines"("tenantId", "wasteId", "productId");
CREATE INDEX "restaurant_waste_lines_tenant_product_idx"
  ON "restaurant_waste_lines"("tenantId", "productId");

ALTER TABLE "restaurant_wastes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_wastes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_wastes_isolation"
  ON "restaurant_wastes"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_waste_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_waste_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_waste_lines_isolation"
  ON "restaurant_waste_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
