-- Mastermind V2-2 — deterministic promotions + coupon authority (ADR-0037)
--
-- Promotions/coupons are mutable merchant policy. Sale applications,
-- allocations and coupon redemptions are immutable historical facts.
BEGIN;

CREATE TABLE "promotions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "merchantCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "activationMode" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "stackingMode" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "effectKind" TEXT NOT NULL,
  "effectValue" BIGINT NOT NULL,
  "minimumEligibleSubtotalMinor" BIGINT NOT NULL DEFAULT 0,
  "targetKind" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotions_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promotions_status"
    CHECK ("status" IN ('draft','active','paused','archived')),
  CONSTRAINT "promotions_activation_mode"
    CHECK ("activationMode" IN ('automatic','coupon')),
  CONSTRAINT "promotions_stacking_mode"
    CHECK ("stackingMode" IN ('stackable','exclusive')),
  CONSTRAINT "promotions_effect_kind"
    CHECK ("effectKind" IN ('fixed','percentage')),
  CONSTRAINT "promotions_effect_value"
    CHECK (
      ("effectKind" = 'fixed' AND "effectValue" > 0)
      OR ("effectKind" = 'percentage' AND "effectValue" BETWEEN 1 AND 10000)
    ),
  CONSTRAINT "promotions_target_kind"
    CHECK ("targetKind" IN ('basket','products')),
  CONSTRAINT "promotions_minimum"
    CHECK ("minimumEligibleSubtotalMinor" >= 0),
  CONSTRAINT "promotions_revision"
    CHECK ("revision" > 0),
  CONSTRAINT "promotions_window"
    CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt"),
  CONSTRAINT "promotions_code_bounded"
    CHECK ("merchantCode" = btrim("merchantCode") AND char_length("merchantCode") BETWEEN 1 AND 64),
  CONSTRAINT "promotions_name_bounded"
    CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX "promotions_tenant_id_key"
  ON "promotions"("tenantId","id");
CREATE UNIQUE INDEX "promotions_tenant_code_key"
  ON "promotions"("tenantId","merchantCode");
CREATE INDEX "promotions_tenant_active_priority_idx"
  ON "promotions"("tenantId","status","activationMode","priority");

CREATE TABLE "promotion_products" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "promotionId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotion_products_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promotion_products_promotion_fkey"
    FOREIGN KEY ("tenantId","promotionId") REFERENCES "promotions"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promotion_products_product_fkey"
    FOREIGN KEY ("tenantId","productId") REFERENCES "products"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "promotion_products_tenant_id_key"
  ON "promotion_products"("tenantId","id");
CREATE UNIQUE INDEX "promotion_products_tenant_promotion_product_key"
  ON "promotion_products"("tenantId","promotionId","productId");
CREATE INDEX "promotion_products_tenant_product_idx"
  ON "promotion_products"("tenantId","productId");

CREATE TABLE "coupons" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "promotionId" UUID NOT NULL,
  "normalizedCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "totalRedemptionLimit" INTEGER,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coupons_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coupons_promotion_fkey"
    FOREIGN KEY ("tenantId","promotionId") REFERENCES "promotions"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "coupons_status"
    CHECK ("status" IN ('active','paused','retired')),
  CONSTRAINT "coupons_code"
    CHECK (
      char_length("normalizedCode") BETWEEN 1 AND 40
      AND "normalizedCode" = upper(btrim("normalizedCode"))
      AND "normalizedCode" ~ '^[A-Z0-9-]+$'
    ),
  CONSTRAINT "coupons_limit"
    CHECK ("totalRedemptionLimit" IS NULL OR "totalRedemptionLimit" > 0),
  CONSTRAINT "coupons_revision"
    CHECK ("revision" > 0),
  CONSTRAINT "coupons_window"
    CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt")
);

CREATE UNIQUE INDEX "coupons_tenant_id_key"
  ON "coupons"("tenantId","id");
CREATE UNIQUE INDEX "coupons_tenant_code_key"
  ON "coupons"("tenantId","normalizedCode");
CREATE INDEX "coupons_tenant_promotion_status_idx"
  ON "coupons"("tenantId","promotionId","status");

CREATE TABLE "sale_promotion_applications" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "promotionId" UUID NOT NULL,
  "couponId" UUID,
  "promotionRevision" BIGINT NOT NULL,
  "merchantCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "stackingMode" TEXT NOT NULL,
  "activationMode" TEXT NOT NULL,
  "effectKind" TEXT NOT NULL,
  "effectValue" BIGINT NOT NULL,
  "eligibleBaseMinor" BIGINT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "couponCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sale_promotion_applications_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_applications_sale_fkey"
    FOREIGN KEY ("tenantId","saleId") REFERENCES "sales"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_applications_promotion_fkey"
    FOREIGN KEY ("tenantId","promotionId") REFERENCES "promotions"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_applications_coupon_fkey"
    FOREIGN KEY ("tenantId","couponId") REFERENCES "coupons"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_applications_revision"
    CHECK ("promotionRevision" > 0),
  CONSTRAINT "sale_promotion_applications_stacking"
    CHECK ("stackingMode" IN ('stackable','exclusive')),
  CONSTRAINT "sale_promotion_applications_activation"
    CHECK ("activationMode" IN ('automatic','coupon')),
  CONSTRAINT "sale_promotion_applications_effect"
    CHECK (
      ("effectKind" = 'fixed' AND "effectValue" > 0)
      OR ("effectKind" = 'percentage' AND "effectValue" BETWEEN 1 AND 10000)
    ),
  CONSTRAINT "sale_promotion_applications_money"
    CHECK ("eligibleBaseMinor" > 0 AND "amountMinor" > 0 AND "amountMinor" <= "eligibleBaseMinor"),
  CONSTRAINT "sale_promotion_applications_coupon_shape"
    CHECK (
      ("activationMode" = 'automatic' AND "couponId" IS NULL AND "couponCode" IS NULL)
      OR (
        "activationMode" = 'coupon'
        AND "couponId" IS NOT NULL
        AND "couponCode" IS NOT NULL
        AND "couponCode" = upper(btrim("couponCode"))
        AND "couponCode" ~ '^[A-Z0-9-]+$'
      )
    )
);

CREATE UNIQUE INDEX "sale_promotion_applications_tenant_id_key"
  ON "sale_promotion_applications"("tenantId","id");
CREATE UNIQUE INDEX "sale_promotion_applications_tenant_sale_promotion_key"
  ON "sale_promotion_applications"("tenantId","saleId","promotionId");
CREATE INDEX "sale_promotion_applications_tenant_promotion_idx"
  ON "sale_promotion_applications"("tenantId","promotionId","createdAt");
CREATE INDEX "sale_promotion_applications_tenant_coupon_idx"
  ON "sale_promotion_applications"("tenantId","couponId");

CREATE TABLE "sale_promotion_allocations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "applicationId" UUID NOT NULL,
  "saleLineId" UUID NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sale_promotion_allocations_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_allocations_application_fkey"
    FOREIGN KEY ("tenantId","applicationId") REFERENCES "sale_promotion_applications"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_allocations_sale_line_fkey"
    FOREIGN KEY ("tenantId","saleLineId") REFERENCES "sale_lines"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_promotion_allocations_amount"
    CHECK ("amountMinor" > 0)
);

CREATE UNIQUE INDEX "sale_promotion_allocations_tenant_id_key"
  ON "sale_promotion_allocations"("tenantId","id");
CREATE UNIQUE INDEX "sale_promotion_allocations_tenant_application_line_key"
  ON "sale_promotion_allocations"("tenantId","applicationId","saleLineId");
CREATE INDEX "sale_promotion_allocations_tenant_sale_line_idx"
  ON "sale_promotion_allocations"("tenantId","saleLineId");

CREATE TABLE "coupon_redemptions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "couponId" UUID NOT NULL,
  "promotionId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "applicationId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "redeemedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coupon_redemptions_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coupon_redemptions_coupon_fkey"
    FOREIGN KEY ("tenantId","couponId") REFERENCES "coupons"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "coupon_redemptions_promotion_fkey"
    FOREIGN KEY ("tenantId","promotionId") REFERENCES "promotions"("tenantId","id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "coupon_redemptions_sale_fkey"
    FOREIGN KEY ("tenantId","saleId") REFERENCES "sales"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coupon_redemptions_application_fkey"
    FOREIGN KEY ("tenantId","applicationId") REFERENCES "sale_promotion_applications"("tenantId","id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "coupon_redemptions_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "coupon_redemptions_tenant_id_key"
  ON "coupon_redemptions"("tenantId","id");
CREATE UNIQUE INDEX "coupon_redemptions_tenant_coupon_sale_key"
  ON "coupon_redemptions"("tenantId","couponId","saleId");
CREATE UNIQUE INDEX "coupon_redemptions_tenant_application_key"
  ON "coupon_redemptions"("tenantId","applicationId");
CREATE INDEX "coupon_redemptions_tenant_coupon_redeemed_idx"
  ON "coupon_redemptions"("tenantId","couponId","redeemedAt");
CREATE INDEX "coupon_redemptions_tenant_operation_idx"
  ON "coupon_redemptions"("tenantId","operationId");

CREATE FUNCTION enforce_promotion_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'promotion identity and creation facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'promotion update must advance revision exactly once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotions_revision_guard"
BEFORE UPDATE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION enforce_promotion_revision_update();

CREATE FUNCTION enforce_coupon_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."tenantId" <> OLD."tenantId" OR NEW."promotionId" <> OLD."promotionId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'coupon identity, tenant, promotion and creation facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'coupon update must advance revision exactly once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "coupons_revision_guard"
BEFORE UPDATE ON "coupons"
FOR EACH ROW EXECUTE FUNCTION enforce_coupon_revision_update();

CREATE FUNCTION enforce_coupon_activation_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode TEXT;
BEGIN
  SELECT "activationMode" INTO mode
    FROM "promotions"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."promotionId";
  IF mode IS DISTINCT FROM 'coupon' THEN
    RAISE EXCEPTION 'coupon must reference a coupon-activated promotion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "coupons_activation_mode_guard"
BEFORE INSERT OR UPDATE ON "coupons"
FOR EACH ROW EXECUTE FUNCTION enforce_coupon_activation_mode();

CREATE FUNCTION enforce_promotion_product_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target TEXT;
BEGIN
  SELECT "targetKind" INTO target
    FROM "promotions"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."promotionId";
  IF target IS DISTINCT FROM 'products' THEN
    RAISE EXCEPTION 'promotion product allow-list requires product target mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotion_products_target_guard"
BEFORE INSERT OR UPDATE ON "promotion_products"
FOR EACH ROW EXECUTE FUNCTION enforce_promotion_product_target();

CREATE FUNCTION reject_promotion_history_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finalized promotion application/redemption facts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "sale_promotion_applications_immutable"
BEFORE UPDATE ON "sale_promotion_applications"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

CREATE TRIGGER "sale_promotion_allocations_immutable"
BEFORE UPDATE ON "sale_promotion_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

CREATE TRIGGER "coupon_redemptions_immutable"
BEFORE UPDATE ON "coupon_redemptions"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promotions_isolation" ON "promotions";
CREATE POLICY "promotions_isolation" ON "promotions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "promotion_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotion_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promotion_products_isolation" ON "promotion_products";
CREATE POLICY "promotion_products_isolation" ON "promotion_products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coupons" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coupons_isolation" ON "coupons";
CREATE POLICY "coupons_isolation" ON "coupons"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_promotion_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_promotion_applications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_promotion_applications_isolation" ON "sale_promotion_applications";
CREATE POLICY "sale_promotion_applications_isolation" ON "sale_promotion_applications"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_promotion_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_promotion_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_promotion_allocations_isolation" ON "sale_promotion_allocations";
CREATE POLICY "sale_promotion_allocations_isolation" ON "sale_promotion_allocations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "coupon_redemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coupon_redemptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coupon_redemptions_isolation" ON "coupon_redemptions";
CREATE POLICY "coupon_redemptions_isolation" ON "coupon_redemptions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

INSERT INTO "permissions" ("key", "descriptionAr", "descriptionEn")
VALUES ('promotion.manage', 'إدارة العروض والكوبونات', 'Manage promotions and coupons')
ON CONFLICT ("key") DO NOTHING;

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
  'promotion.manage'
FROM "roles" r
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager','admin','owner')
ON CONFLICT ("tenantId","roleId","permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
