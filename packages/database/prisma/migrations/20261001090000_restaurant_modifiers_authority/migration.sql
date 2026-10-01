-- STRIKE V2-5 — governed restaurant modifier authority.
-- Forward-only. Existing restaurant order lines are exact zero-modifier history.
BEGIN;

-- ---------------------------------------------------------------------------
-- Historical order-line price decomposition.
-- ---------------------------------------------------------------------------

ALTER TABLE "restaurant_order_lines"
  ADD COLUMN "baseUnitPriceMinor" BIGINT;

UPDATE "restaurant_order_lines"
   SET "baseUnitPriceMinor" = "unitPriceMinor";

ALTER TABLE "restaurant_order_lines"
  ALTER COLUMN "baseUnitPriceMinor" SET NOT NULL,
  ADD COLUMN "modifierTotalMinor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "restaurant_order_lines"
  ADD CONSTRAINT "restaurant_order_lines_modifier_price_reconciles"
  CHECK (
    "baseUnitPriceMinor" >= 0
    AND "modifierTotalMinor" >= 0
    AND "unitPriceMinor" = "baseUnitPriceMinor" + "modifierTotalMinor"
  );

ALTER TABLE "restaurant_preparation_tasks"
  ADD COLUMN "modifierSummary" TEXT;

-- ---------------------------------------------------------------------------
-- Merchant modifier policy.
-- ---------------------------------------------------------------------------

CREATE TABLE "restaurant_modifier_groups" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "minSelections" INTEGER NOT NULL DEFAULT 0,
  "maxSelections" INTEGER NOT NULL DEFAULT 1,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_modifier_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_modifier_groups_bounds"
    CHECK (
      "minSelections" >= 0
      AND "maxSelections" >= 1
      AND "maxSelections" <= 32
      AND "minSelections" <= "maxSelections"
    ),
  CONSTRAINT "restaurant_modifier_groups_sort_order" CHECK ("sortOrder" >= 0),
  CONSTRAINT "restaurant_modifier_groups_revision" CHECK ("revision" > 0),
  CONSTRAINT "restaurant_modifier_groups_code"
    CHECK (char_length("code") BETWEEN 1 AND 40 AND "code" !~ '[[:space:]]'),
  CONSTRAINT "restaurant_modifier_groups_name_ar"
    CHECK (char_length(btrim("nameAr")) BETWEEN 1 AND 120),
  CONSTRAINT "restaurant_modifier_groups_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_modifier_groups_tenant_id_key"
  ON "restaurant_modifier_groups"("tenantId","id");
CREATE UNIQUE INDEX "restaurant_modifier_groups_tenant_code_key"
  ON "restaurant_modifier_groups"("tenantId","code");
CREATE INDEX "restaurant_modifier_groups_tenant_active_sort_idx"
  ON "restaurant_modifier_groups"("tenantId","isActive","sortOrder");

CREATE TABLE "restaurant_modifier_options" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "priceDeltaMinor" BIGINT NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_modifier_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_modifier_options_price_delta"
    CHECK ("priceDeltaMinor" >= 0),
  CONSTRAINT "restaurant_modifier_options_sort_order" CHECK ("sortOrder" >= 0),
  CONSTRAINT "restaurant_modifier_options_revision" CHECK ("revision" > 0),
  CONSTRAINT "restaurant_modifier_options_code"
    CHECK (char_length("code") BETWEEN 1 AND 40 AND "code" !~ '[[:space:]]'),
  CONSTRAINT "restaurant_modifier_options_name_ar"
    CHECK (char_length(btrim("nameAr")) BETWEEN 1 AND 120),
  CONSTRAINT "restaurant_modifier_options_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_modifier_options_group_fk"
    FOREIGN KEY ("tenantId","groupId")
    REFERENCES "restaurant_modifier_groups"("tenantId","id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_modifier_options_tenant_id_key"
  ON "restaurant_modifier_options"("tenantId","id");
CREATE UNIQUE INDEX "restaurant_modifier_options_tenant_group_id_key"
  ON "restaurant_modifier_options"("tenantId","groupId","id");
CREATE UNIQUE INDEX "restaurant_modifier_options_tenant_group_code_key"
  ON "restaurant_modifier_options"("tenantId","groupId","code");
CREATE INDEX "restaurant_modifier_options_tenant_group_active_sort_idx"
  ON "restaurant_modifier_options"("tenantId","groupId","isActive","sortOrder");

CREATE TABLE "restaurant_product_modifier_groups" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "restaurant_product_modifier_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_product_modifier_groups_sort_order" CHECK ("sortOrder" >= 0),
  CONSTRAINT "restaurant_product_modifier_groups_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_product_modifier_groups_product_fk"
    FOREIGN KEY ("tenantId","productId")
    REFERENCES "products"("tenantId","id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_product_modifier_groups_group_fk"
    FOREIGN KEY ("tenantId","groupId")
    REFERENCES "restaurant_modifier_groups"("tenantId","id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_product_modifier_groups_tenant_id_key"
  ON "restaurant_product_modifier_groups"("tenantId","id");
CREATE UNIQUE INDEX "restaurant_product_modifier_groups_product_group_key"
  ON "restaurant_product_modifier_groups"("tenantId","productId","groupId");
CREATE INDEX "restaurant_product_modifier_groups_product_sort_idx"
  ON "restaurant_product_modifier_groups"("tenantId","productId","sortOrder");
CREATE INDEX "restaurant_product_modifier_groups_group_idx"
  ON "restaurant_product_modifier_groups"("tenantId","groupId");

-- ---------------------------------------------------------------------------
-- Immutable order-line selection snapshots.
-- ---------------------------------------------------------------------------

CREATE TABLE "restaurant_order_line_modifier_selections" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "orderLineId" UUID NOT NULL,
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

  CONSTRAINT "restaurant_order_line_modifier_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_order_line_modifier_selections_snapshot"
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
  CONSTRAINT "restaurant_order_line_modifier_selections_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_order_line_modifier_selections_order_line_fk"
    FOREIGN KEY ("tenantId","orderLineId")
    REFERENCES "restaurant_order_lines"("tenantId","id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_order_line_modifier_selections_group_fk"
    FOREIGN KEY ("tenantId","groupId")
    REFERENCES "restaurant_modifier_groups"("tenantId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "restaurant_order_line_modifier_selections_option_fk"
    FOREIGN KEY ("tenantId","groupId","optionId")
    REFERENCES "restaurant_modifier_options"("tenantId","groupId","id")
    ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_order_line_modifier_selections_tenant_id_key"
  ON "restaurant_order_line_modifier_selections"("tenantId","id");
CREATE UNIQUE INDEX "restaurant_order_line_modifier_selections_line_option_key"
  ON "restaurant_order_line_modifier_selections"("tenantId","orderLineId","optionId");
CREATE INDEX "restaurant_order_line_modifier_selections_line_sort_idx"
  ON "restaurant_order_line_modifier_selections"(
    "tenantId","orderLineId","groupSortOrder","optionSortOrder"
  );
CREATE INDEX "restaurant_order_line_modifier_selections_group_option_idx"
  ON "restaurant_order_line_modifier_selections"("tenantId","groupId","optionId");

-- Modifier snapshots remain editable only while the parent order is open and
-- the exact line has not been fired to preparation. Once kitchen execution or
-- settlement exists, they are historical operational/financial truth.
CREATE FUNCTION guard_restaurant_modifier_selection_mutation() RETURNS trigger
LANGUAGE plpgsql AS $
DECLARE
  selected_tenant UUID;
  selected_line UUID;
  order_status TEXT;
  fired BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  selected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
  selected_line := CASE WHEN TG_OP = 'DELETE' THEN OLD."orderLineId" ELSE NEW."orderLineId" END;

  SELECT o."status"
    INTO order_status
    FROM "restaurant_order_lines" l
    JOIN "restaurant_orders" o
      ON o."tenantId" = l."tenantId" AND o."id" = l."orderId"
   WHERE l."tenantId" = selected_tenant AND l."id" = selected_line;

  SELECT EXISTS (
    SELECT 1
      FROM "restaurant_preparation_tasks" t
     WHERE t."tenantId" = selected_tenant AND t."orderLineId" = selected_line
  ) INTO fired;

  IF order_status = 'open' AND NOT fired THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'restaurant modifier selection snapshot is locked by order/preparation history'
    USING ERRCODE = '55000';
END;
$;

CREATE TRIGGER "restaurant_modifier_selection_guard_insert"
BEFORE INSERT ON "restaurant_order_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_restaurant_modifier_selection_mutation();

CREATE TRIGGER "restaurant_modifier_selection_guard_update"
BEFORE UPDATE ON "restaurant_order_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_restaurant_modifier_selection_mutation();

CREATE TRIGGER "restaurant_modifier_selection_guard_delete"
BEFORE DELETE ON "restaurant_order_line_modifier_selections"
FOR EACH ROW EXECUTE FUNCTION guard_restaurant_modifier_selection_mutation();

-- The financial component on the line must exactly equal the selected option
-- snapshots. Deferred checks allow one transaction to replace selections and
-- then update the line (or the reverse) without creating a false intermediate
-- failure.
CREATE FUNCTION assert_restaurant_modifier_total_reconciles() RETURNS trigger
LANGUAGE plpgsql AS $
DECLARE
  selected_tenant UUID;
  selected_line UUID;
  expected_total BIGINT;
  actual_total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'restaurant_order_lines' THEN
    selected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
    selected_line := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSE
    selected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
    selected_line := CASE WHEN TG_OP = 'DELETE' THEN OLD."orderLineId" ELSE NEW."orderLineId" END;
  END IF;

  SELECT "modifierTotalMinor"
    INTO expected_total
    FROM "restaurant_order_lines"
   WHERE "tenantId" = selected_tenant AND "id" = selected_line;

  -- Parent lifecycle cascades legitimately leave no line to reconcile.
  IF expected_total IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("priceDeltaMinor"), 0)
    INTO actual_total
    FROM "restaurant_order_line_modifier_selections"
   WHERE "tenantId" = selected_tenant AND "orderLineId" = selected_line;

  IF actual_total IS DISTINCT FROM expected_total THEN
    RAISE EXCEPTION 'restaurant modifier snapshots do not reconcile to order line modifier total'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$;

CREATE CONSTRAINT TRIGGER "restaurant_order_lines_modifier_total_reconciles"
AFTER INSERT OR UPDATE ON "restaurant_order_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_restaurant_modifier_total_reconciles();

CREATE CONSTRAINT TRIGGER "restaurant_order_line_modifier_selections_reconcile"
AFTER INSERT OR UPDATE OR DELETE ON "restaurant_order_line_modifier_selections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_restaurant_modifier_total_reconciles();

-- ---------------------------------------------------------------------------
-- Tenant isolation.
-- ---------------------------------------------------------------------------

ALTER TABLE "restaurant_modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_modifier_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_modifier_groups_isolation" ON "restaurant_modifier_groups";
CREATE POLICY "restaurant_modifier_groups_isolation" ON "restaurant_modifier_groups"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_modifier_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_modifier_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_modifier_options_isolation" ON "restaurant_modifier_options";
CREATE POLICY "restaurant_modifier_options_isolation" ON "restaurant_modifier_options"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_product_modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_product_modifier_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_product_modifier_groups_isolation" ON "restaurant_product_modifier_groups";
CREATE POLICY "restaurant_product_modifier_groups_isolation" ON "restaurant_product_modifier_groups"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "restaurant_order_line_modifier_selections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_line_modifier_selections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurant_order_line_modifier_selections_isolation"
  ON "restaurant_order_line_modifier_selections";
CREATE POLICY "restaurant_order_line_modifier_selections_isolation"
  ON "restaurant_order_line_modifier_selections"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Dedicated menu administration permission.
-- ---------------------------------------------------------------------------

INSERT INTO "permissions" ("key","descriptionAr","descriptionEn")
VALUES (
  'restaurant.menu.manage',
  'إدارة قائمة المطعم والإضافات',
  'Manage restaurant menu and modifiers'
)
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
  'restaurant.menu.manage'
FROM "roles" r
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager','admin','owner')
ON CONFLICT ("tenantId","roleId","permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
