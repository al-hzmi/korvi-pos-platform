-- STRIKE V2-5 — finalized sale modifier history + menu-policy serialization.
-- Forward-only follow-up to 20261001090000_restaurant_modifiers_authority.
BEGIN;

-- ---------------------------------------------------------------------------
-- Finalized SaleLine financial decomposition.
-- ---------------------------------------------------------------------------

ALTER TABLE "sale_lines"
  ADD COLUMN "baseUnitPriceMinor" BIGINT;

UPDATE "sale_lines"
   SET "baseUnitPriceMinor" = "unitPriceMinor";

ALTER TABLE "sale_lines"
  ALTER COLUMN "baseUnitPriceMinor" SET NOT NULL,
  ADD COLUMN "modifierTotalMinor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "sale_lines"
  ADD CONSTRAINT "sale_lines_modifier_price_reconciles"
  CHECK (
    "baseUnitPriceMinor" >= 0
    AND "modifierTotalMinor" >= 0
    AND "unitPriceMinor" = "baseUnitPriceMinor" + "modifierTotalMinor"
  );

CREATE TABLE "sale_line_modifier_selections" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "saleLineId" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "optionId" UUID NOT NULL,

  "groupCode" TEXT NOT NULL,
  "groupNameAr" TEXT NOT NULL,
  "groupRevision" BIGINT NOT NULL,
  "groupSortOrder" INTEGER NOT NULL,

  "optionCode" TEXT NOT NULL,
  "optionNameAr" TEXT NOT NULL,
  "optionRevision" BIGINT NOT NULL,
  "optionSortOrder" INTEGER NOT NULL,

  "priceDeltaMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sale_line_modifier_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sale_line_modifier_selections_snapshot"
    CHECK (
      "groupRevision" > 0
      AND "optionRevision" > 0
      AND "groupSortOrder" >= 0
      AND "optionSortOrder" >= 0
      AND "priceDeltaMinor" >= 0
      AND char_length(btrim("groupCode")) BETWEEN 1 AND 40
      AND char_length(btrim("optionCode")) BETWEEN 1 AND 40
      AND char_length(btrim("groupNameAr")) BETWEEN 1 AND 120
      AND char_length(btrim("optionNameAr")) BETWEEN 1 AND 120
    ),
  CONSTRAINT "sale_line_modifier_selections_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_line_modifier_selections_sale_line_fk"
    FOREIGN KEY ("tenantId","saleLineId")
    REFERENCES "sale_lines"("tenantId","id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_line_modifier_selections_group_fk"
    FOREIGN KEY ("tenantId","groupId")
    REFERENCES "restaurant_modifier_groups"("tenantId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sale_line_modifier_selections_option_fk"
    FOREIGN KEY ("tenantId","groupId","optionId")
    REFERENCES "restaurant_modifier_options"("tenantId","groupId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sale_line_modifier_selections_tenant_id_key"
  ON "sale_line_modifier_selections"("tenantId","id");
CREATE UNIQUE INDEX "sale_line_modifier_selections_line_option_key"
  ON "sale_line_modifier_selections"("tenantId","saleLineId","optionId");
CREATE INDEX "sale_line_modifier_selections_line_sort_idx"
  ON "sale_line_modifier_selections"(
    "tenantId","saleLineId","groupSortOrder","optionSortOrder"
  );
CREATE INDEX "sale_line_modifier_selections_group_option_idx"
  ON "sale_line_modifier_selections"("tenantId","groupId","optionId");

-- ---------------------------------------------------------------------------
-- Menu-policy serialization.
-- ---------------------------------------------------------------------------

CREATE FUNCTION lock_restaurant_menu_policy_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tenant UUID;
BEGIN
  tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('korvi:restaurant-menu-policy:' || tenant::text, 0)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "restaurant_modifier_groups_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_modifier_groups"
FOR EACH ROW EXECUTE FUNCTION lock_restaurant_menu_policy_mutation();

CREATE TRIGGER "restaurant_modifier_options_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_modifier_options"
FOR EACH ROW EXECUTE FUNCTION lock_restaurant_menu_policy_mutation();

CREATE TRIGGER "restaurant_product_modifier_groups_policy_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "restaurant_product_modifier_groups"
FOR EACH ROW EXECUTE FUNCTION lock_restaurant_menu_policy_mutation();

-- Group and option configuration uses active lifecycle. Physical deletion is
-- not a merchant operation because historical snapshots may depend on the
-- definition. Tenant lifecycle cascades remain permitted.
CREATE FUNCTION reject_restaurant_modifier_definition_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'restaurant modifier definitions must be deactivated, not deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "restaurant_modifier_groups_no_direct_delete"
BEFORE DELETE ON "restaurant_modifier_groups"
FOR EACH ROW EXECUTE FUNCTION reject_restaurant_modifier_definition_delete();

CREATE TRIGGER "restaurant_modifier_options_no_direct_delete"
BEFORE DELETE ON "restaurant_modifier_options"
FOR EACH ROW EXECUTE FUNCTION reject_restaurant_modifier_definition_delete();

-- ---------------------------------------------------------------------------
-- Finalized SaleLine modifier history.
-- ---------------------------------------------------------------------------

CREATE FUNCTION guard_sale_line_modifier_selection_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'finalized sale modifier selection snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "sale_line_modifier_selection_guard_insert"
BEFORE INSERT ON "sale_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_sale_line_modifier_selection_mutation();

CREATE TRIGGER "sale_line_modifier_selection_guard_update"
BEFORE UPDATE ON "sale_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_sale_line_modifier_selection_mutation();

CREATE TRIGGER "sale_line_modifier_selection_guard_delete"
BEFORE DELETE ON "sale_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_sale_line_modifier_selection_mutation();

CREATE FUNCTION assert_sale_line_modifier_total_reconciles() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_tenant UUID;
  selected_line UUID;
  expected_total BIGINT;
  actual_total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'sale_lines' THEN
    selected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
    selected_line := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSE
    selected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
    selected_line := CASE WHEN TG_OP = 'DELETE' THEN OLD."saleLineId" ELSE NEW."saleLineId" END;
  END IF;

  SELECT "modifierTotalMinor"
    INTO expected_total
    FROM "sale_lines"
   WHERE "tenantId" = selected_tenant AND "id" = selected_line;

  -- Parent tenant/sale lifecycle cascades legitimately leave no line.
  IF expected_total IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("priceDeltaMinor"), 0)
    INTO actual_total
    FROM "sale_line_modifier_selections"
   WHERE "tenantId" = selected_tenant AND "saleLineId" = selected_line;

  IF actual_total IS DISTINCT FROM expected_total THEN
    RAISE EXCEPTION 'sale modifier snapshots do not reconcile to sale line modifier total'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "sale_lines_modifier_total_reconciles"
AFTER INSERT OR UPDATE ON "sale_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_sale_line_modifier_total_reconciles();

CREATE CONSTRAINT TRIGGER "sale_line_modifier_selections_reconcile"
AFTER INSERT OR UPDATE OR DELETE ON "sale_line_modifier_selections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_sale_line_modifier_total_reconciles();

-- ---------------------------------------------------------------------------
-- Tenant isolation.
-- ---------------------------------------------------------------------------

ALTER TABLE "sale_line_modifier_selections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_line_modifier_selections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_line_modifier_selections_isolation"
  ON "sale_line_modifier_selections";
CREATE POLICY "sale_line_modifier_selections_isolation"
  ON "sale_line_modifier_selections"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
