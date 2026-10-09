-- Mastermind V2-2 — historical promotion financial component + hardening
-- Follow-up to 20260925120000_promotions_coupons_authority.
--
-- Forward-only: the earlier migration is already repository history and is not
-- rewritten. Zero is exact for rows committed before V2-2 because Korvi had no
-- authoritative promotion engine before this strike.
BEGIN;

ALTER TABLE "sales"
  ADD COLUMN "promotionDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "sale_lines"
  ADD COLUMN "promotionDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns"
  ADD COLUMN "promotionDiscountMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_lines"
  ADD COLUMN "promotionDiscountMinor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_promotion_discount_non_negative"
  CHECK ("promotionDiscountMinor" >= 0);
ALTER TABLE "sale_lines"
  ADD CONSTRAINT "sale_lines_promotion_discount_non_negative"
  CHECK ("promotionDiscountMinor" >= 0);
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_promotion_discount_non_negative"
  CHECK ("promotionDiscountMinor" >= 0);
ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_promotion_discount_non_negative"
  CHECK ("promotionDiscountMinor" >= 0);

-- Keep the database's coupon business key exactly aligned with the domain
-- normalizer: 3-32 ASCII alphanumerics with optional internal hyphens.
ALTER TABLE "coupons" DROP CONSTRAINT "coupons_code";
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_code"
  CHECK (
    char_length("normalizedCode") BETWEEN 3 AND 32
    AND "normalizedCode" ~ '^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$'
  );

ALTER TABLE "sale_promotion_applications"
  DROP CONSTRAINT "sale_promotion_applications_coupon_shape";
ALTER TABLE "sale_promotion_applications"
  ADD CONSTRAINT "sale_promotion_applications_coupon_shape"
  CHECK (
    ("activationMode" = 'automatic' AND "couponId" IS NULL AND "couponCode" IS NULL)
    OR (
      "activationMode" = 'coupon'
      AND "couponId" IS NOT NULL
      AND "couponCode" IS NOT NULL
      AND char_length("couponCode") BETWEEN 3 AND 32
      AND "couponCode" ~ '^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$'
    )
  );

-- UPDATE was already blocked on finalized policy facts. DELETE must be blocked
-- too, except when a parent tenant/sale lifecycle cascade is removing the whole
-- aggregate. Direct application deletion is never a business operation.
CREATE OR REPLACE FUNCTION reject_promotion_history_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'finalized promotion application/redemption facts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "sale_promotion_applications_immutable_delete"
BEFORE DELETE ON "sale_promotion_applications"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

CREATE TRIGGER "sale_promotion_allocations_immutable_delete"
BEFORE DELETE ON "sale_promotion_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

CREATE TRIGGER "coupon_redemptions_immutable_delete"
BEFORE DELETE ON "coupon_redemptions"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_history_update();

-- Promotion/coupon configuration uses status lifecycle. Physical deletion is
-- not a merchant mutation because it would erase the policy object an audit or
-- historical sale references. Tenant lifecycle cascade remains permitted.
CREATE FUNCTION reject_promotion_config_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'promotion/coupon configuration must be archived or retired, not deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "promotions_no_direct_delete"
BEFORE DELETE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_config_delete();

CREATE TRIGGER "coupons_no_direct_delete"
BEFORE DELETE ON "coupons"
FOR EACH ROW EXECUTE FUNCTION reject_promotion_config_delete();

-- Child-table guards in the first migration prevent an invalid child from
-- being inserted. These parent guards close the inverse route: changing an
-- already-populated parent into a mode that makes its existing children
-- impossible.
CREATE FUNCTION enforce_promotion_parent_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activationMode" <> 'coupon'
     AND EXISTS (
       SELECT 1 FROM "coupons"
        WHERE "tenantId" = OLD."tenantId" AND "promotionId" = OLD."id"
     ) THEN
    RAISE EXCEPTION 'promotion with coupons must remain coupon-activated until coupons are retired from configuration'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."targetKind" <> 'products'
     AND EXISTS (
       SELECT 1 FROM "promotion_products"
        WHERE "tenantId" = OLD."tenantId" AND "promotionId" = OLD."id"
     ) THEN
    RAISE EXCEPTION 'promotion with product allow-list rows must remain product-targeted until the allow-list is removed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotions_parent_shape_guard"
BEFORE UPDATE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION enforce_promotion_parent_shape();

COMMIT;
