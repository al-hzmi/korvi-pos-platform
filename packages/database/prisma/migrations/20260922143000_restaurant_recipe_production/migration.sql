-- Korvi POS — Restaurant recipe production stock/cost authority.
-- One causal production document converts recipe ingredients into finished stock
-- through the existing inventory movement and costing ledgers.

BEGIN;

-- Production is part of the same causal stock ledger. Extend the existing
-- closed movement vocabulary rather than bypassing its database constraint.
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
      'production-output'
    )
  );

CREATE TABLE "restaurant_recipe_productions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "recipeRevision" BIGINT NOT NULL,
  "batchCount" BIGINT NOT NULL,
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "actorUserId" UUID NOT NULL,
  "producedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_recipe_productions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_productions_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_productions_tenantId_recipeId_fkey"
    FOREIGN KEY ("tenantId", "recipeId") REFERENCES "restaurant_recipes"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_productions_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_productions_revision_positive"
    CHECK ("recipeRevision" > 0),
  CONSTRAINT "restaurant_recipe_productions_batch_positive"
    CHECK ("batchCount" > 0),
  CONSTRAINT "restaurant_recipe_productions_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 120),
  CONSTRAINT "restaurant_recipe_productions_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "restaurant_recipe_productions_tenantId_id_key"
  ON "restaurant_recipe_productions"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_recipe_productions_tenantId_operationId_key"
  ON "restaurant_recipe_productions"("tenantId", "operationId");
CREATE INDEX "restaurant_recipe_productions_tenantId_branchId_producedAt_idx"
  ON "restaurant_recipe_productions"("tenantId", "branchId", "producedAt");
CREATE INDEX "restaurant_recipe_productions_tenantId_recipeId_producedAt_idx"
  ON "restaurant_recipe_productions"("tenantId", "recipeId", "producedAt");

CREATE TABLE "restaurant_recipe_production_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productionId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "deltaQuantityScaled" BIGINT NOT NULL,
  "beforeQuantityScaled" BIGINT NOT NULL,
  "afterQuantityScaled" BIGINT NOT NULL,
  "resultRevision" BIGINT NOT NULL,
  "costKnownQuantityScaled" BIGINT NOT NULL,
  "costUnknownQuantityScaled" BIGINT NOT NULL,
  "costValueMinor" BIGINT NOT NULL,
  "costProvenance" TEXT NOT NULL,

  CONSTRAINT "restaurant_recipe_production_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_production_lines_tenantId_productionId_fkey"
    FOREIGN KEY ("tenantId", "productionId")
    REFERENCES "restaurant_recipe_productions"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_production_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_production_lines_role"
    CHECK ("role" IN ('ingredient', 'output')),
  CONSTRAINT "restaurant_recipe_production_lines_delta_nonzero"
    CHECK ("deltaQuantityScaled" <> 0),
  CONSTRAINT "restaurant_recipe_production_lines_role_sign"
    CHECK (
      ("role" = 'ingredient' AND "deltaQuantityScaled" < 0)
      OR ("role" = 'output' AND "deltaQuantityScaled" > 0)
    ),
  CONSTRAINT "restaurant_recipe_production_lines_arithmetic"
    CHECK ("afterQuantityScaled" = "beforeQuantityScaled" + "deltaQuantityScaled"),
  CONSTRAINT "restaurant_recipe_production_lines_revision_positive"
    CHECK ("resultRevision" > 0),
  CONSTRAINT "restaurant_recipe_production_lines_cost_nonnegative"
    CHECK (
      "costKnownQuantityScaled" >= 0
      AND "costUnknownQuantityScaled" >= 0
      AND "costValueMinor" >= 0
    ),
  CONSTRAINT "restaurant_recipe_production_lines_cost_quantity"
    CHECK (
      abs("deltaQuantityScaled")
        = "costKnownQuantityScaled" + "costUnknownQuantityScaled"
    ),
  CONSTRAINT "restaurant_recipe_production_lines_cost_provenance"
    CHECK ("costProvenance" IN ('unknown', 'recorded', 'mixed'))
);

CREATE UNIQUE INDEX "restaurant_recipe_production_lines_tenantId_id_key"
  ON "restaurant_recipe_production_lines"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_recipe_production_lines_tenant_production_product_key"
  ON "restaurant_recipe_production_lines"("tenantId", "productionId", "productId");
CREATE INDEX "restaurant_recipe_production_lines_tenant_product_idx"
  ON "restaurant_recipe_production_lines"("tenantId", "productId");

ALTER TABLE "restaurant_recipe_productions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_productions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_recipe_productions_isolation"
  ON "restaurant_recipe_productions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_recipe_production_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_production_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_recipe_production_lines_isolation"
  ON "restaurant_recipe_production_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
