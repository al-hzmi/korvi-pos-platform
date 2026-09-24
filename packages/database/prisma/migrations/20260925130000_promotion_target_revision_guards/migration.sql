-- Mastermind V2-2 — promotion target revision authority
-- Forward-only hardening after the initial V2-2 persistence migrations.
--
-- A product allow-list is part of merchant pricing policy. Changing it without
-- changing the promotion revision would let a checkout commit against a policy
-- revision whose meaning changed underneath it.
BEGIN;

CREATE FUNCTION bump_promotion_revision_from_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_tenant UUID;
  old_promotion UUID;
  new_tenant UUID;
  new_promotion UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "promotions"
       SET "revision" = "revision" + 1,
           "updatedAt" = now()
     WHERE "tenantId" = NEW."tenantId"
       AND "id" = NEW."promotionId";
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE "promotions"
       SET "revision" = "revision" + 1,
           "updatedAt" = now()
     WHERE "tenantId" = OLD."tenantId"
       AND "id" = OLD."promotionId";
    RETURN OLD;
  END IF;

  old_tenant := OLD."tenantId";
  old_promotion := OLD."promotionId";
  new_tenant := NEW."tenantId";
  new_promotion := NEW."promotionId";

  IF old_tenant = new_tenant AND old_promotion = new_promotion THEN
    UPDATE "promotions"
       SET "revision" = "revision" + 1,
           "updatedAt" = now()
     WHERE "tenantId" = new_tenant
       AND "id" = new_promotion;
  ELSE
    -- Deterministic UUID order avoids opposite lock order if two administrators
    -- move allow-list rows between the same pair of promotions concurrently.
    IF old_promotion::text < new_promotion::text THEN
      UPDATE "promotions"
         SET "revision" = "revision" + 1, "updatedAt" = now()
       WHERE "tenantId" = old_tenant AND "id" = old_promotion;
      UPDATE "promotions"
         SET "revision" = "revision" + 1, "updatedAt" = now()
       WHERE "tenantId" = new_tenant AND "id" = new_promotion;
    ELSE
      UPDATE "promotions"
         SET "revision" = "revision" + 1, "updatedAt" = now()
       WHERE "tenantId" = new_tenant AND "id" = new_promotion;
      UPDATE "promotions"
         SET "revision" = "revision" + 1, "updatedAt" = now()
       WHERE "tenantId" = old_tenant AND "id" = old_promotion;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotion_products_revision_insert"
AFTER INSERT ON "promotion_products"
FOR EACH ROW EXECUTE FUNCTION bump_promotion_revision_from_target();

CREATE TRIGGER "promotion_products_revision_update"
AFTER UPDATE ON "promotion_products"
FOR EACH ROW EXECUTE FUNCTION bump_promotion_revision_from_target();

CREATE TRIGGER "promotion_products_revision_delete"
AFTER DELETE ON "promotion_products"
FOR EACH ROW EXECUTE FUNCTION bump_promotion_revision_from_target();

-- Product-targeted policy is not executable without a target. New definitions
-- therefore enter as draft, receive their allow-list rows (which advance the
-- revision), and only then may become active.
CREATE FUNCTION enforce_active_product_target_shape() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'active' AND NEW."targetKind" = 'products' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'product-targeted promotion must be configured before activation'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM "promotion_products"
       WHERE "tenantId" = NEW."tenantId"
         AND "promotionId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'active product-targeted promotion requires at least one product'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotions_active_product_target_insert"
BEFORE INSERT ON "promotions"
FOR EACH ROW EXECUTE FUNCTION enforce_active_product_target_shape();

CREATE TRIGGER "promotions_active_product_target_update"
BEFORE UPDATE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION enforce_active_product_target_shape();

COMMIT;
