-- Korvi POS — Restaurant recipe/BOM foundation.
-- Operational stock configuration only. No price, cost, tax, invoice or fiscal fields.

BEGIN;

CREATE TABLE "restaurant_recipes" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "yieldQuantityScaled" BIGINT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "restaurant_recipes_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipes_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipes_yield_positive" CHECK ("yieldQuantityScaled" > 0),
  CONSTRAINT "restaurant_recipes_revision_positive" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "restaurant_recipes_tenantId_id_key"
  ON "restaurant_recipes"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_recipes_tenantId_productId_key"
  ON "restaurant_recipes"("tenantId", "productId");
CREATE INDEX "restaurant_recipes_tenantId_updatedAt_idx"
  ON "restaurant_recipes"("tenantId", "updatedAt");

CREATE TABLE "restaurant_recipe_ingredients" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "recipeId" UUID NOT NULL,
  "ingredientProductId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_recipe_ingredients_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_ingredients_tenantId_recipeId_fkey"
    FOREIGN KEY ("tenantId", "recipeId") REFERENCES "restaurant_recipes"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_ingredients_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "ingredientProductId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_recipe_ingredients_quantity_positive" CHECK ("quantityScaled" > 0)
);

CREATE UNIQUE INDEX "restaurant_recipe_ingredients_tenantId_id_key"
  ON "restaurant_recipe_ingredients"("tenantId", "id");
CREATE UNIQUE INDEX "restaurant_recipe_ingredients_tenant_recipe_product_key"
  ON "restaurant_recipe_ingredients"("tenantId", "recipeId", "ingredientProductId");
CREATE INDEX "restaurant_recipe_ingredients_tenant_product_idx"
  ON "restaurant_recipe_ingredients"("tenantId", "ingredientProductId");

ALTER TABLE "restaurant_recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_recipes_isolation"
  ON "restaurant_recipes"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_recipe_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_ingredients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_recipe_ingredients_isolation"
  ON "restaurant_recipe_ingredients"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
