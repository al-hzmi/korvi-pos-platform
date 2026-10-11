-- Mastermind V2-3 — retail packaging + contextual price-list authority (ADR-0038)
--
-- Forward only. Existing sale/order/receipt rows keep their pre-V2-3 meaning;
-- additive snapshot columns stay NULL on history rather than inventing package
-- or price-list provenance.
BEGIN;

-- ---------------------------------------------------------------------------
-- Product packages: commercial units only, never stock/cost identities.
-- ---------------------------------------------------------------------------

CREATE TABLE "product_packages" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "unitLabel" TEXT NOT NULL,
  "baseQuantityScaled" BIGINT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_packages_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_packages_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "product_packages_factor"
    CHECK ("baseQuantityScaled" > 1000 AND mod("baseQuantityScaled", 1000) = 0),
  CONSTRAINT "product_packages_revision" CHECK ("revision" > 0),
  CONSTRAINT "product_packages_code_bounded"
    CHECK ("code" = btrim("code") AND char_length("code") BETWEEN 1 AND 64),
  CONSTRAINT "product_packages_name_ar_bounded"
    CHECK ("nameAr" = btrim("nameAr") AND char_length("nameAr") BETWEEN 1 AND 200),
  CONSTRAINT "product_packages_unit_label_bounded"
    CHECK ("unitLabel" = btrim("unitLabel") AND char_length("unitLabel") BETWEEN 1 AND 32)
);

CREATE UNIQUE INDEX "product_packages_tenant_id_key"
  ON "product_packages"("tenantId","id");
CREATE UNIQUE INDEX "product_packages_tenant_product_id_key"
  ON "product_packages"("tenantId","productId","id");
CREATE UNIQUE INDEX "product_packages_tenant_product_code_key"
  ON "product_packages"("tenantId","productId","code");
CREATE INDEX "product_packages_tenant_product_active_idx"
  ON "product_packages"("tenantId","productId","isActive");

CREATE FUNCTION enforce_product_package_contract() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ptype TEXT;
BEGIN
  SELECT "productType" INTO ptype
    FROM "products"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."productId";

  IF ptype IS DISTINCT FROM 'unit' THEN
    RAISE EXCEPTION 'V2-3 packages require a unit product' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."productId" IS DISTINCT FROM OLD."productId"
       OR NEW."baseQuantityScaled" IS DISTINCT FROM OLD."baseQuantityScaled" THEN
      RAISE EXCEPTION 'package product/factor is immutable; deactivate and create a new package'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'package revision must advance by exactly one' USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "product_packages_contract"
BEFORE INSERT OR UPDATE ON "product_packages"
FOR EACH ROW EXECUTE FUNCTION enforce_product_package_contract();

CREATE FUNCTION reject_product_package_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product package identity is archived/deactivated, not deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "product_packages_no_delete"
BEFORE DELETE ON "product_packages"
FOR EACH ROW EXECUTE FUNCTION reject_product_package_delete();

-- Existing barcodes remain base-unit barcodes. NULL packageId is intentional.
ALTER TABLE "product_barcodes"
  ADD COLUMN "packageId" UUID;

ALTER TABLE "product_barcodes"
  ADD CONSTRAINT "product_barcodes_package_fkey"
  FOREIGN KEY ("tenantId","productId","packageId")
  REFERENCES "product_packages"("tenantId","productId","id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "product_barcodes_tenant_package_idx"
  ON "product_barcodes"("tenantId","packageId");

-- ---------------------------------------------------------------------------
-- Retail / wholesale contextual price lists.
-- ---------------------------------------------------------------------------

CREATE TABLE "price_lists" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "price_lists_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "price_lists_context" CHECK ("context" IN ('retail','wholesale')),
  CONSTRAINT "price_lists_status" CHECK ("status" IN ('draft','active','paused','archived')),
  CONSTRAINT "price_lists_revision" CHECK ("revision" > 0),
  CONSTRAINT "price_lists_code_bounded"
    CHECK ("code" = btrim("code") AND char_length("code") BETWEEN 1 AND 64),
  CONSTRAINT "price_lists_name_bounded"
    CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX "price_lists_tenant_id_key"
  ON "price_lists"("tenantId","id");
CREATE UNIQUE INDEX "price_lists_tenant_code_key"
  ON "price_lists"("tenantId","code");
CREATE UNIQUE INDEX "price_lists_one_active_context"
  ON "price_lists"("tenantId","context")
  WHERE "status" = 'active';
CREATE INDEX "price_lists_tenant_context_status_idx"
  ON "price_lists"("tenantId","context","status");

CREATE FUNCTION enforce_price_list_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'price-list revision must advance by exactly one' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "price_lists_revision_guard"
BEFORE UPDATE ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION enforce_price_list_revision();

CREATE FUNCTION reject_price_list_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price-list identity is archived, not deleted' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "price_lists_no_delete"
BEFORE DELETE ON "price_lists"
FOR EACH ROW EXECUTE FUNCTION reject_price_list_delete();

CREATE TABLE "price_list_entries" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "priceListId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "packageId" UUID,
  "priceMinor" BIGINT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "price_list_entries_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "price_list_entries_list_fkey"
    FOREIGN KEY ("tenantId","priceListId") REFERENCES "price_lists"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "price_list_entries_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "price_list_entries_package_fkey"
    FOREIGN KEY ("tenantId","productId","packageId")
    REFERENCES "product_packages"("tenantId","productId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "price_list_entries_price_nonnegative" CHECK ("priceMinor" >= 0),
  CONSTRAINT "price_list_entries_revision" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "price_list_entries_tenant_id_key"
  ON "price_list_entries"("tenantId","id");
CREATE UNIQUE INDEX "price_list_entries_base_target_key"
  ON "price_list_entries"("tenantId","priceListId","productId")
  WHERE "packageId" IS NULL;
CREATE UNIQUE INDEX "price_list_entries_package_target_key"
  ON "price_list_entries"("tenantId","priceListId","productId","packageId")
  WHERE "packageId" IS NOT NULL;
CREATE INDEX "price_list_entries_tenant_list_product_idx"
  ON "price_list_entries"("tenantId","priceListId","productId");
CREATE INDEX "price_list_entries_tenant_product_package_idx"
  ON "price_list_entries"("tenantId","productId","packageId");

CREATE FUNCTION enforce_price_list_entry_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'price-list entry revision must advance by exactly one' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "price_list_entries_revision_guard"
BEFORE UPDATE ON "price_list_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_price_list_entry_revision();

-- Strengthen base price history without fabricating missing old history.
ALTER TABLE "product_prices"
  ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'recorded';

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_provenance"
  CHECK ("provenance" IN ('recorded','legacy-current'));

CREATE UNIQUE INDEX "product_prices_one_open_current"
  ON "product_prices"("tenantId","productId")
  WHERE "effectiveTo" IS NULL;

-- ---------------------------------------------------------------------------
-- Immutable commercial/base and price provenance snapshots.
-- ---------------------------------------------------------------------------

ALTER TABLE "sale_lines"
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "priceListId" UUID,
  ADD COLUMN "inventoryQuantityScaled" BIGINT,
  ADD COLUMN "packageCode" TEXT,
  ADD COLUMN "packageNameAr" TEXT,
  ADD COLUMN "packageUnitLabel" TEXT,
  ADD COLUMN "packageBaseQuantityScaled" BIGINT,
  ADD COLUMN "priceContext" TEXT,
  ADD COLUMN "pricingProvenance" TEXT,
  ADD COLUMN "priceListCode" TEXT,
  ADD COLUMN "priceListRevision" BIGINT;

ALTER TABLE "sale_lines"
  ADD CONSTRAINT "sale_lines_package_fkey"
    FOREIGN KEY ("tenantId","productId","packageId")
    REFERENCES "product_packages"("tenantId","productId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "sale_lines_price_list_fkey"
    FOREIGN KEY ("tenantId","priceListId")
    REFERENCES "price_lists"("tenantId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "sale_lines_inventory_quantity_positive"
    CHECK ("inventoryQuantityScaled" IS NULL OR "inventoryQuantityScaled" > 0),
  ADD CONSTRAINT "sale_lines_price_context"
    CHECK ("priceContext" IS NULL OR "priceContext" IN ('retail','wholesale')),
  ADD CONSTRAINT "sale_lines_pricing_provenance"
    CHECK (
      "pricingProvenance" IS NULL
      OR "pricingProvenance" IN ('product-base','price-list-base','price-list-package')
    ),
  ADD CONSTRAINT "sale_lines_package_snapshot_shape"
    CHECK (
      (
        "packageId" IS NULL
        AND "packageCode" IS NULL
        AND "packageNameAr" IS NULL
        AND "packageUnitLabel" IS NULL
        AND "packageBaseQuantityScaled" IS NULL
      )
      OR
      (
        "packageId" IS NOT NULL
        AND "productId" IS NOT NULL
        AND "packageCode" IS NOT NULL
        AND "packageNameAr" IS NOT NULL
        AND "packageUnitLabel" IS NOT NULL
        AND "packageBaseQuantityScaled" > 1000
        AND mod("packageBaseQuantityScaled",1000) = 0
        AND mod("quantityScaled",1000) = 0
        AND "inventoryQuantityScaled" IS NOT NULL
        AND ("inventoryQuantityScaled"::numeric * 1000)
          = ("quantityScaled"::numeric * "packageBaseQuantityScaled"::numeric)
      )
    ),
  ADD CONSTRAINT "sale_lines_price_snapshot_shape"
    CHECK (
      (
        "priceContext" IS NULL
        AND "pricingProvenance" IS NULL
        AND "priceListId" IS NULL
        AND "priceListCode" IS NULL
        AND "priceListRevision" IS NULL
      )
      OR
      (
        "priceContext" IS NOT NULL
        AND "pricingProvenance" = 'product-base'
        AND "priceListId" IS NULL
        AND "priceListCode" IS NULL
        AND "priceListRevision" IS NULL
      )
      OR
      (
        "priceContext" IS NOT NULL
        AND "pricingProvenance" IN ('price-list-base','price-list-package')
        AND "priceListId" IS NOT NULL
        AND "priceListCode" IS NOT NULL
        AND "priceListRevision" > 0
        AND ("pricingProvenance" <> 'price-list-package' OR "packageId" IS NOT NULL)
      )
    );

ALTER TABLE "sale_lines"
  DROP CONSTRAINT "sale_lines_cost_quantity_reconciles";
ALTER TABLE "sale_lines"
  ADD CONSTRAINT "sale_lines_cost_quantity_reconciles"
  CHECK (
    "costKnownQuantityScaled" + "costUnknownQuantityScaled"
      = COALESCE("inventoryQuantityScaled","quantityScaled")
  );

CREATE INDEX "sale_lines_tenant_package_idx"
  ON "sale_lines"("tenantId","packageId");
CREATE INDEX "sale_lines_tenant_price_list_idx"
  ON "sale_lines"("tenantId","priceListId");

-- Original-sale returns retain commercial money quantity plus the exact base
-- inventory quantity restored from the sale snapshot.
ALTER TABLE "return_lines"
  ADD COLUMN "inventoryQuantityScaled" BIGINT,
  ADD COLUMN "packageCode" TEXT,
  ADD COLUMN "packageNameAr" TEXT,
  ADD COLUMN "packageUnitLabel" TEXT,
  ADD COLUMN "packageBaseQuantityScaled" BIGINT;

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_inventory_quantity_positive"
    CHECK ("inventoryQuantityScaled" IS NULL OR "inventoryQuantityScaled" > 0),
  ADD CONSTRAINT "return_lines_package_snapshot_shape"
    CHECK (
      (
        "packageCode" IS NULL
        AND "packageNameAr" IS NULL
        AND "packageUnitLabel" IS NULL
        AND "packageBaseQuantityScaled" IS NULL
      )
      OR
      (
        "packageCode" IS NOT NULL
        AND "packageNameAr" IS NOT NULL
        AND "packageUnitLabel" IS NOT NULL
        AND "packageBaseQuantityScaled" > 1000
        AND mod("packageBaseQuantityScaled",1000) = 0
        AND mod("quantityScaled",1000) = 0
        AND "inventoryQuantityScaled" IS NOT NULL
        AND ("inventoryQuantityScaled"::numeric * 1000)
          = ("quantityScaled"::numeric * "packageBaseQuantityScaled"::numeric)
      )
    );

ALTER TABLE "return_lines"
  DROP CONSTRAINT "return_lines_cost_quantity_reconciles";
ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_cost_quantity_reconciles"
  CHECK (
    "costKnownQuantityScaled" + "costUnknownQuantityScaled"
      = COALESCE("inventoryQuantityScaled","quantityScaled")
  );

-- Purchasing keeps its existing base accumulators while snapshotting the
-- commercial package intent used to derive them.
ALTER TABLE "purchase_order_lines"
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "commercialQuantityScaled" BIGINT,
  ADD COLUMN "packageCode" TEXT,
  ADD COLUMN "packageUnitLabel" TEXT,
  ADD COLUMN "packageBaseQuantityScaled" BIGINT;

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_package_fkey"
    FOREIGN KEY ("tenantId","productId","packageId")
    REFERENCES "product_packages"("tenantId","productId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_order_lines_commercial_shape"
    CHECK (
      "commercialQuantityScaled" IS NULL
      OR (
        "commercialQuantityScaled" > 0
        AND (
          (
            "packageId" IS NULL
            AND "packageCode" IS NULL
            AND "packageUnitLabel" IS NULL
            AND "packageBaseQuantityScaled" IS NULL
            AND "commercialQuantityScaled" = "orderedQuantityScaled"
          )
          OR
          (
            "packageId" IS NOT NULL
            AND "packageCode" IS NOT NULL
            AND "packageUnitLabel" IS NOT NULL
            AND "packageBaseQuantityScaled" > 1000
            AND mod("packageBaseQuantityScaled",1000) = 0
            AND mod("commercialQuantityScaled",1000) = 0
            AND ("orderedQuantityScaled"::numeric * 1000)
              = ("commercialQuantityScaled"::numeric * "packageBaseQuantityScaled"::numeric)
          )
        )
      )
    );

CREATE INDEX "purchase_order_lines_tenant_package_idx"
  ON "purchase_order_lines"("tenantId","packageId");

ALTER TABLE "purchase_receipt_lines"
  ADD COLUMN "packageId" UUID,
  ADD COLUMN "acceptedCommercialQuantityScaled" BIGINT,
  ADD COLUMN "packageCode" TEXT,
  ADD COLUMN "packageUnitLabel" TEXT,
  ADD COLUMN "packageBaseQuantityScaled" BIGINT;

ALTER TABLE "purchase_receipt_lines"
  ADD CONSTRAINT "purchase_receipt_lines_package_fkey"
    FOREIGN KEY ("tenantId","productId","packageId")
    REFERENCES "product_packages"("tenantId","productId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_receipt_lines_commercial_shape"
    CHECK (
      "acceptedCommercialQuantityScaled" IS NULL
      OR (
        "acceptedCommercialQuantityScaled" > 0
        AND (
          (
            "packageId" IS NULL
            AND "packageCode" IS NULL
            AND "packageUnitLabel" IS NULL
            AND "packageBaseQuantityScaled" IS NULL
            AND "acceptedCommercialQuantityScaled" = "acceptedQuantityScaled"
          )
          OR
          (
            "packageId" IS NOT NULL
            AND "packageCode" IS NOT NULL
            AND "packageUnitLabel" IS NOT NULL
            AND "packageBaseQuantityScaled" > 1000
            AND mod("packageBaseQuantityScaled",1000) = 0
            AND mod("acceptedCommercialQuantityScaled",1000) = 0
            AND ("acceptedQuantityScaled"::numeric * 1000)
              = ("acceptedCommercialQuantityScaled"::numeric * "packageBaseQuantityScaled"::numeric)
          )
        )
      )
    );

CREATE INDEX "purchase_receipt_lines_tenant_package_idx"
  ON "purchase_receipt_lines"("tenantId","packageId");

-- ---------------------------------------------------------------------------
-- RLS and management permissions.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "product_packages_isolation" ON "product_packages"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "price_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_lists" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_lists_isolation" ON "price_lists"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "price_list_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_list_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_list_entries_isolation" ON "price_list_entries"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

INSERT INTO "permissions" ("key","descriptionAr","descriptionEn")
VALUES
  ('price-list.manage','إدارة قوائم الأسعار','Manage price lists'),
  ('sale.price-context','اختيار سياق سعر غير افتراضي','Select non-default sale price context')
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
  p."permissionKey"
FROM "roles" r
CROSS JOIN (
  VALUES ('price-list.manage'), ('sale.price-context')
) AS p("permissionKey")
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager','admin','owner')
ON CONFLICT ("tenantId","roleId","permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
