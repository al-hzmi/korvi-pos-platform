-- Allow a lawful return to reverse earned points even when some have
-- already been redeemed. Only redemption is prohibited from overdrawing.
-- An outstanding negative balance is genuine points debt, not store credit.
-- Forward-only replacement; original applied migration is unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION guard_loyalty_point_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  enrolled RECORD;
  previous_entry RECORD;
  prior_balance BIGINT;
  reversed_points BIGINT;
  sale_customer UUID;
  related_sale UUID;
BEGIN
  SELECT e."customerId", e."programId", e."isActive", p."status", p."revision"
    INTO enrolled
    FROM "loyalty_enrollments" e JOIN "loyalty_programs" p
      ON p."tenantId" = e."tenantId" AND p."id" = e."programId"
   WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."enrollmentId"
   FOR UPDATE OF e;
  IF NOT FOUND OR enrolled."customerId" <> NEW."customerId"
     OR enrolled."programId" <> NEW."programId" THEN
    RAISE EXCEPTION 'loyalty enrollment does not own entry' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" IN ('earn','redeem') AND
     (NOT enrolled."isActive" OR enrolled."status" <> 'active'
      OR enrolled."revision" <> NEW."programRevision") THEN
    RAISE EXCEPTION 'loyalty policy or consent is no longer active' USING ERRCODE = '23514';
  END IF;
  IF NEW."saleId" IS NOT NULL THEN
    SELECT "customerId" INTO sale_customer FROM "sales"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."saleId" AND "status" = 'finalized';
    IF NOT FOUND OR sale_customer IS DISTINCT FROM NEW."customerId" THEN
      RAISE EXCEPTION 'loyalty sale customer identity mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."reversesEntryId" IS NOT NULL THEN
    SELECT "id", "kind", "pointsDelta", "enrollmentId", "saleId" INTO previous_entry
      FROM "loyalty_point_entries"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."reversesEntryId";
    IF NOT FOUND OR previous_entry."enrollmentId" <> NEW."enrollmentId" OR
      NOT (
        (NEW."kind" = 'reverse-earn' AND previous_entry."kind" = 'earn') OR
        (NEW."kind" = 'restore-redeem' AND previous_entry."kind" = 'redeem')
      ) THEN
      RAISE EXCEPTION 'loyalty reversal must identify matching original entry' USING ERRCODE = '23514';
    END IF;
    SELECT "saleId" INTO related_sale FROM "returns"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."returnId" AND "status" = 'finalized';
    IF NOT FOUND OR related_sale <> previous_entry."saleId" THEN
      RAISE EXCEPTION 'loyalty reversal return belongs to a different sale' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(abs("pointsDelta")), 0) INTO reversed_points
      FROM "loyalty_point_entries"
     WHERE "tenantId" = NEW."tenantId" AND "reversesEntryId" = NEW."reversesEntryId";
    IF reversed_points + abs(NEW."pointsDelta") > abs(previous_entry."pointsDelta") THEN
      RAISE EXCEPTION 'loyalty reversal exceeds original points' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM("pointsDelta"), 0) INTO prior_balance
    FROM "loyalty_point_entries"
   WHERE "tenantId" = NEW."tenantId" AND "enrollmentId" = NEW."enrollmentId";
  IF prior_balance + NEW."pointsDelta" < 0 AND NEW."kind" <> 'reverse-earn' THEN
    RAISE EXCEPTION 'loyalty redemption may not overdraw points' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
