-- V2-3 lifecycle repair: configuration identities are not directly deletable,
-- while tenant/product lifecycle cascades must still be able to remove the
-- aggregate. Forward-only; the original migration remains immutable.
BEGIN;

CREATE OR REPLACE FUNCTION reject_product_package_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'product package identity is archived/deactivated, not deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_price_list_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'price-list identity is archived, not deleted'
    USING ERRCODE = '55000';
END;
$$;

COMMIT;
