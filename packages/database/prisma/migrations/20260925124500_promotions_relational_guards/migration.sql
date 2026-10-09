-- Mastermind V2-2 — promotion/coupon historical relational guards
-- Follow-up to ADR-0037 persistence authority.
--
-- Forward-only. This migration does not rewrite either prior V2-2 migration.
-- It closes cross-document composition gaps at PostgreSQL authority.
BEGIN;

-- A sale promotion application is a historical snapshot of the exact merchant
-- policy revision used for that sale. It must match the current locked policy
-- at commit time; coupon-backed applications must also match the exact coupon
-- instrument and normalized code snapshot.
CREATE FUNCTION enforce_sale_promotion_application_links() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision BIGINT;
  current_merchant_code TEXT;
  current_name TEXT;
  current_priority INTEGER;
  current_stacking_mode TEXT;
  current_activation_mode TEXT;
  current_effect_kind TEXT;
  current_effect_value BIGINT;
  coupon_promotion UUID;
  coupon_code TEXT;
BEGIN
  SELECT
    "revision",
    "merchantCode",
    "name",
    "priority",
    "stackingMode",
    "activationMode",
    "effectKind",
    "effectValue"
  INTO
    current_revision,
    current_merchant_code,
    current_name,
    current_priority,
    current_stacking_mode,
    current_activation_mode,
    current_effect_kind,
    current_effect_value
  FROM "promotions"
  WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."promotionId"
  FOR SHARE;

  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'promotion application references an unknown tenant promotion'
      USING ERRCODE = '23503';
  END IF;

  IF
    NEW."promotionRevision" IS DISTINCT FROM current_revision
    OR NEW."merchantCode" IS DISTINCT FROM current_merchant_code
    OR NEW."name" IS DISTINCT FROM current_name
    OR NEW."priority" IS DISTINCT FROM current_priority
    OR NEW."stackingMode" IS DISTINCT FROM current_stacking_mode
    OR NEW."activationMode" IS DISTINCT FROM current_activation_mode
    OR NEW."effectKind" IS DISTINCT FROM current_effect_kind
    OR NEW."effectValue" IS DISTINCT FROM current_effect_value
  THEN
    RAISE EXCEPTION 'promotion application snapshot does not match the locked promotion revision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."activationMode" = 'coupon' THEN
    SELECT "promotionId", "normalizedCode"
      INTO coupon_promotion, coupon_code
      FROM "coupons"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."couponId"
     FOR SHARE;

    IF coupon_promotion IS NULL THEN
      RAISE EXCEPTION 'coupon-backed promotion application references an unknown tenant coupon'
        USING ERRCODE = '23503';
    END IF;

    IF
      coupon_promotion IS DISTINCT FROM NEW."promotionId"
      OR coupon_code IS DISTINCT FROM NEW."couponCode"
    THEN
      RAISE EXCEPTION 'coupon-backed promotion application does not match its coupon instrument'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "sale_promotion_applications_link_guard"
BEFORE INSERT ON "sale_promotion_applications"
FOR EACH ROW EXECUTE FUNCTION enforce_sale_promotion_application_links();

-- An allocation may only point at a sale line from the SAME sale as its
-- application. Tenant-scoped foreign keys alone are not sufficient here.
CREATE FUNCTION enforce_sale_promotion_allocation_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  application_sale UUID;
  line_sale UUID;
BEGIN
  SELECT "saleId" INTO application_sale
    FROM "sale_promotion_applications"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."applicationId"
   FOR SHARE;

  SELECT "saleId" INTO line_sale
    FROM "sale_lines"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."saleLineId"
   FOR SHARE;

  IF application_sale IS NULL OR line_sale IS NULL THEN
    RAISE EXCEPTION 'promotion allocation references an unknown application or sale line'
      USING ERRCODE = '23503';
  END IF;

  IF application_sale IS DISTINCT FROM line_sale THEN
    RAISE EXCEPTION 'promotion allocation sale line belongs to a different sale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "sale_promotion_allocations_link_guard"
BEFORE INSERT ON "sale_promotion_allocations"
FOR EACH ROW EXECUTE FUNCTION enforce_sale_promotion_allocation_link();

-- Redemption is a ledger fact for one coupon-backed application and the sale
-- operation that committed it. Every identity must reconcile, otherwise a
-- caller could consume one coupon while attaching the fact to another sale.
CREATE FUNCTION enforce_coupon_redemption_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  application_sale UUID;
  application_promotion UUID;
  application_coupon UUID;
  application_mode TEXT;
  coupon_promotion UUID;
  sale_operation TEXT;
BEGIN
  SELECT "saleId", "promotionId", "couponId", "activationMode"
    INTO application_sale, application_promotion, application_coupon, application_mode
    FROM "sale_promotion_applications"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."applicationId"
   FOR SHARE;

  SELECT "promotionId" INTO coupon_promotion
    FROM "coupons"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."couponId"
   FOR SHARE;

  SELECT "operationId" INTO sale_operation
    FROM "sales"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."saleId"
   FOR SHARE;

  IF application_sale IS NULL OR coupon_promotion IS NULL OR sale_operation IS NULL THEN
    RAISE EXCEPTION 'coupon redemption references an unknown application, coupon or sale'
      USING ERRCODE = '23503';
  END IF;

  IF
    application_mode IS DISTINCT FROM 'coupon'
    OR application_sale IS DISTINCT FROM NEW."saleId"
    OR application_promotion IS DISTINCT FROM NEW."promotionId"
    OR application_coupon IS DISTINCT FROM NEW."couponId"
    OR coupon_promotion IS DISTINCT FROM NEW."promotionId"
    OR sale_operation IS DISTINCT FROM NEW."operationId"
  THEN
    RAISE EXCEPTION 'coupon redemption does not reconcile to its application and sale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "coupon_redemptions_link_guard"
BEFORE INSERT ON "coupon_redemptions"
FOR EACH ROW EXECUTE FUNCTION enforce_coupon_redemption_link();

COMMIT;
