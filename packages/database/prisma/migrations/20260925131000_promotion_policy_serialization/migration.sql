-- Mastermind V2-2 — serialize promotion-policy mutation against checkout commit.
-- Forward-only. The sale path takes the matching SHARED advisory lock while it
-- re-resolves policy. Every configuration mutation takes EXCLUSIVE here, at
-- PostgreSQL authority, so a future admin writer cannot accidentally bypass it.
BEGIN;

CREATE FUNCTION lock_promotion_policy_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tenant UUID;
BEGIN
  tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('korvi:promotion-policy:' || tenant::text, 0)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "promotions_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "promotions"
FOR EACH ROW EXECUTE FUNCTION lock_promotion_policy_mutation();

CREATE TRIGGER "promotion_products_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "promotion_products"
FOR EACH ROW EXECUTE FUNCTION lock_promotion_policy_mutation();

CREATE TRIGGER "coupons_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "coupons"
FOR EACH ROW EXECUTE FUNCTION lock_promotion_policy_mutation();

COMMIT;
