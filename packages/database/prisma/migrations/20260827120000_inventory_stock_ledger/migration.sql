-- Korvi POS — Strike 5A: stock ledger integrity.
--
-- `inventory_movements` stays the causal ledger and `inventory_balances` stays
-- its transactional materialized quantity (ADR-0024 §1). This migration does
-- not add a second stock truth: it adds the finalized *documents* that explain
-- why a merchant moved stock deliberately, plus the concurrency evidence the
-- balance needed in order to be counted safely.
--
-- Additive and forward-only. No existing table, column, policy, constraint or
-- historical row is rewritten. Balances that predate this migration keep
-- revision 0 rather than having a history invented for them.

BEGIN;

-- ---------------------------------------------------------------------------
-- Balance revision
-- ---------------------------------------------------------------------------

-- The concurrency evidence a stock count needs.
--
-- Counting is the one stock operation whose input is an *absolute* observation:
-- "there are four on the shelf". Between the moment somebody counts and the
-- moment the count is submitted, a sale, a return, a transfer or another
-- adjustment may have moved the same balance — and applying the observation
-- afterwards would silently erase that movement. The revision is what lets the
-- server notice, under the row lock, that the shelf it is being told about is
-- not the shelf it now holds.
--
-- DEFAULT 0 and no backfill: an existing balance has no known revision history,
-- and a fabricated one would be a lie that a count could not detect (§A).
ALTER TABLE "inventory_balances"
  ADD COLUMN "revision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "inventory_balances_revision_non_negative"
  CHECK ("revision" >= 0);

-- ---------------------------------------------------------------------------
-- Movement causality
-- ---------------------------------------------------------------------------

-- Which *line* of the document caused this movement.
--
-- A transfer posts two legs for one line — negative at source, positive at
-- destination — and both carry the same sourceType and sourceId. Without a line
-- reference the two legs of product A and the two legs of product B are four
-- rows that can only be told apart by guessing from the quantity. Nullable and
-- forward-only: historical movements have no line to point at and are left
-- null rather than given invented provenance (§K).
ALTER TABLE "inventory_movements"
  ADD COLUMN "sourceLineId" UUID;

CREATE INDEX "inventory_movements_tenantId_sourceLineId_idx"
  ON "inventory_movements"("tenantId", "sourceLineId");

-- Deleting a branch must not delete the ledger that explains its stock.
--
-- The causal ledger has carried `ON DELETE CASCADE` to `branches` since the
-- SaaS foundation, which means removing a branch row silently erases every
-- movement ever posted in it — the exact opposite of what an append-only
-- causal ledger is for (ADR-0024 §10). Stock history is not a detail of the
-- branch record; it is the evidence that explains where goods went, and it has
-- to outlive an administrative tidy-up.
--
-- Repaired forward-only. The historical migration is immutable, so the
-- constraint is dropped and recreated here with the same name, the same
-- tenant-consistent `(tenantId, branchId)` composite shape and the same
-- `ON UPDATE CASCADE`; only the delete action changes. A branch that still has
-- movements can no longer be deleted, which is the intended answer: correcting
-- stock is a compensating operation, never a deletion of what happened.
ALTER TABLE "inventory_movements"
  DROP CONSTRAINT "inventory_movements_tenantId_branchId_fkey";

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_tenantId_branchId_fkey"
  FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Adjustments
-- ---------------------------------------------------------------------------

CREATE TABLE "inventory_adjustments" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,

  -- Required. An adjustment is a merchant asserting that the book is wrong,
  -- and an assertion with no stated cause is an unexplained shrinkage.
  "reason" TEXT NOT NULL,

  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_adjustments_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- Tenant-consistent: the branch is referenced by (tenantId, id), so
  -- PostgreSQL itself refuses a document that reaches across tenants (ADR-0004).
  CONSTRAINT "inventory_adjustments_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_adjustments_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_adjustments_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "inventory_adjustments_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "inventory_adjustments_reason_bounded"
    CHECK (
      "reason" = btrim("reason")
      AND char_length("reason") BETWEEN 1 AND 200
    )
);

CREATE UNIQUE INDEX "inventory_adjustments_tenantId_id_key"
  ON "inventory_adjustments"("tenantId", "id");

CREATE UNIQUE INDEX "inventory_adjustments_tenantId_operationId_key"
  ON "inventory_adjustments"("tenantId", "operationId");

CREATE INDEX "inventory_adjustments_tenantId_branchId_occurredAt_idx"
  ON "inventory_adjustments"("tenantId", "branchId", "occurredAt");

CREATE TABLE "inventory_adjustment_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "adjustmentId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  -- Signed and scaled by 1000, like every quantity in Korvi.
  "deltaQuantityScaled" BIGINT NOT NULL,
  "beforeQuantityScaled" BIGINT NOT NULL,
  "afterQuantityScaled" BIGINT NOT NULL,
  "resultRevision" BIGINT NOT NULL,

  CONSTRAINT "inventory_adjustment_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_adjustment_lines_tenantId_adjustmentId_fkey"
    FOREIGN KEY ("tenantId", "adjustmentId")
    REFERENCES "inventory_adjustments"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_adjustment_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  -- A line that moves nothing is not an adjustment.
  CONSTRAINT "inventory_adjustment_lines_delta_non_zero"
    CHECK ("deltaQuantityScaled" <> 0),

  -- The arithmetic is asserted by the database, so a line cannot record a
  -- before/after pair that its own delta does not explain.
  CONSTRAINT "inventory_adjustment_lines_arithmetic"
    CHECK ("afterQuantityScaled" = "beforeQuantityScaled" + "deltaQuantityScaled"),

  CONSTRAINT "inventory_adjustment_lines_revision_positive"
    CHECK ("resultRevision" >= 1)
);

CREATE UNIQUE INDEX "inventory_adjustment_lines_tenantId_id_key"
  ON "inventory_adjustment_lines"("tenantId", "id");

-- One line per product per document: two deltas for one balance would be two
-- answers to the same question.
CREATE UNIQUE INDEX "inventory_adjustment_lines_tenantId_adjustmentId_productId_key"
  ON "inventory_adjustment_lines"("tenantId", "adjustmentId", "productId");

CREATE INDEX "inventory_adjustment_lines_tenantId_productId_idx"
  ON "inventory_adjustment_lines"("tenantId", "productId");

-- ---------------------------------------------------------------------------
-- Stock counts
-- ---------------------------------------------------------------------------

CREATE TABLE "inventory_counts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,

  -- Optional: "the monthly count" needs no justification the way an
  -- adjustment does.
  "reason" TEXT,

  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_counts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_counts_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_counts_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_counts_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "inventory_counts_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "inventory_counts_reason_bounded"
    CHECK (
      "reason" IS NULL
      OR ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 200)
    )
);

CREATE UNIQUE INDEX "inventory_counts_tenantId_id_key"
  ON "inventory_counts"("tenantId", "id");

CREATE UNIQUE INDEX "inventory_counts_tenantId_operationId_key"
  ON "inventory_counts"("tenantId", "operationId");

CREATE INDEX "inventory_counts_tenantId_branchId_occurredAt_idx"
  ON "inventory_counts"("tenantId", "branchId", "occurredAt");

CREATE TABLE "inventory_count_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "countId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  -- The revision the counter was looking at. This is the whole of the
  -- concurrency contract: the server compares it with truth under the lock.
  "expectedRevision" BIGINT NOT NULL,

  "beforeQuantityScaled" BIGINT NOT NULL,
  -- The observation. Absolute, non-negative, and never an instruction.
  "countedQuantityScaled" BIGINT NOT NULL,
  -- Derived by the server under the lock, never supplied by the client.
  "deltaQuantityScaled" BIGINT NOT NULL,
  -- Unchanged from `expectedRevision` when the delta was zero: evidence was
  -- recorded, but no movement happened, so nothing incremented (§C).
  "resultRevision" BIGINT NOT NULL,

  CONSTRAINT "inventory_count_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_count_lines_tenantId_countId_fkey"
    FOREIGN KEY ("tenantId", "countId")
    REFERENCES "inventory_counts"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_count_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_count_lines_counted_non_negative"
    CHECK ("countedQuantityScaled" >= 0),

  -- The derived delta must be exactly what the observation implies.
  CONSTRAINT "inventory_count_lines_arithmetic"
    CHECK ("countedQuantityScaled" = "beforeQuantityScaled" + "deltaQuantityScaled"),

  CONSTRAINT "inventory_count_lines_revision_non_negative"
    CHECK ("expectedRevision" >= 0 AND "resultRevision" >= 0),

  -- A zero delta writes no movement, so the revision cannot have moved; a
  -- non-zero delta writes exactly one, so it must have moved by exactly one.
  CONSTRAINT "inventory_count_lines_revision_step"
    CHECK (
      ("deltaQuantityScaled" = 0 AND "resultRevision" = "expectedRevision")
      OR ("deltaQuantityScaled" <> 0 AND "resultRevision" = "expectedRevision" + 1)
    )
);

CREATE UNIQUE INDEX "inventory_count_lines_tenantId_id_key"
  ON "inventory_count_lines"("tenantId", "id");

CREATE UNIQUE INDEX "inventory_count_lines_tenantId_countId_productId_key"
  ON "inventory_count_lines"("tenantId", "countId", "productId");

CREATE INDEX "inventory_count_lines_tenantId_productId_idx"
  ON "inventory_count_lines"("tenantId", "productId");

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

CREATE TABLE "inventory_transfers" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "fromBranchId" UUID NOT NULL,
  "toBranchId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reason" TEXT,

  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_transfers_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfers_tenantId_fromBranchId_fkey"
    FOREIGN KEY ("tenantId", "fromBranchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfers_tenantId_toBranchId_fkey"
    FOREIGN KEY ("tenantId", "toBranchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfers_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  -- Stock cannot be transferred to where it already is. Allowing it would let
  -- a transfer post two legs against one balance row.
  CONSTRAINT "inventory_transfers_distinct_branches"
    CHECK ("fromBranchId" <> "toBranchId"),

  CONSTRAINT "inventory_transfers_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "inventory_transfers_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "inventory_transfers_reason_bounded"
    CHECK (
      "reason" IS NULL
      OR ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 200)
    )
);

CREATE UNIQUE INDEX "inventory_transfers_tenantId_id_key"
  ON "inventory_transfers"("tenantId", "id");

CREATE UNIQUE INDEX "inventory_transfers_tenantId_operationId_key"
  ON "inventory_transfers"("tenantId", "operationId");

CREATE INDEX "inventory_transfers_tenantId_fromBranchId_occurredAt_idx"
  ON "inventory_transfers"("tenantId", "fromBranchId", "occurredAt");

CREATE INDEX "inventory_transfers_tenantId_toBranchId_occurredAt_idx"
  ON "inventory_transfers"("tenantId", "toBranchId", "occurredAt");

CREATE TABLE "inventory_transfer_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "transferId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  -- Positive. Direction is the branch pair, not a sign.
  "quantityScaled" BIGINT NOT NULL,

  "sourceBeforeQuantityScaled" BIGINT NOT NULL,
  "sourceAfterQuantityScaled" BIGINT NOT NULL,
  "destinationBeforeQuantityScaled" BIGINT NOT NULL,
  "destinationAfterQuantityScaled" BIGINT NOT NULL,
  "sourceResultRevision" BIGINT NOT NULL,
  "destinationResultRevision" BIGINT NOT NULL,

  CONSTRAINT "inventory_transfer_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfer_lines_tenantId_transferId_fkey"
    FOREIGN KEY ("tenantId", "transferId")
    REFERENCES "inventory_transfers"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfer_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "inventory_transfer_lines_quantity_positive"
    CHECK ("quantityScaled" > 0),

  -- Both legs, asserted. A row that recorded a source decrement without the
  -- matching destination increment would be a one-sided transfer written down.
  CONSTRAINT "inventory_transfer_lines_source_arithmetic"
    CHECK ("sourceAfterQuantityScaled" = "sourceBeforeQuantityScaled" - "quantityScaled"),

  CONSTRAINT "inventory_transfer_lines_destination_arithmetic"
    CHECK (
      "destinationAfterQuantityScaled"
        = "destinationBeforeQuantityScaled" + "quantityScaled"
    ),

  -- Physical stock cannot be moved out of a branch that does not hold it,
  -- whatever the tenant's checkout oversell policy says (ADR-0024 §6).
  CONSTRAINT "inventory_transfer_lines_source_not_negative"
    CHECK ("sourceAfterQuantityScaled" >= 0),

  CONSTRAINT "inventory_transfer_lines_revisions_positive"
    CHECK ("sourceResultRevision" >= 1 AND "destinationResultRevision" >= 1)
);

CREATE UNIQUE INDEX "inventory_transfer_lines_tenantId_id_key"
  ON "inventory_transfer_lines"("tenantId", "id");

CREATE UNIQUE INDEX "inventory_transfer_lines_tenantId_transferId_productId_key"
  ON "inventory_transfer_lines"("tenantId", "transferId", "productId");

CREATE INDEX "inventory_transfer_lines_tenantId_productId_idx"
  ON "inventory_transfer_lines"("tenantId", "productId");

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- All six tables are private merchant operational data — they name a shop's
-- shelves, its staff and what went missing — so they sit inside exactly the
-- same boundary as sales and users (ADR-0004).

ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_adjustments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_adjustments_isolation" ON "inventory_adjustments";
CREATE POLICY "inventory_adjustments_isolation" ON "inventory_adjustments"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_adjustment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_adjustment_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_adjustment_lines_isolation" ON "inventory_adjustment_lines";
CREATE POLICY "inventory_adjustment_lines_isolation" ON "inventory_adjustment_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_counts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_counts_isolation" ON "inventory_counts";
CREATE POLICY "inventory_counts_isolation" ON "inventory_counts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_count_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_count_lines_isolation" ON "inventory_count_lines";
CREATE POLICY "inventory_count_lines_isolation" ON "inventory_count_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_transfers_isolation" ON "inventory_transfers";
CREATE POLICY "inventory_transfers_isolation" ON "inventory_transfers"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_transfer_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_transfer_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_transfer_lines_isolation" ON "inventory_transfer_lines";
CREATE POLICY "inventory_transfer_lines_isolation" ON "inventory_transfer_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- The new permission
-- ---------------------------------------------------------------------------

-- The catalogue row is global application vocabulary, not tenant data, and the
-- boot-time `provisionPermissionCatalogue` writes the same row idempotently.
-- Doing it here as well means a deployment that migrates before it boots has a
-- consistent catalogue in between.
INSERT INTO "permissions" ("key", "descriptionAr", "descriptionEn")
VALUES (
  'inventory.transfer',
  'تحويل المخزون بين الفروع',
  'Transfer inventory'
)
ON CONFLICT ("key") DO NOTHING;

-- Grant it to the *system* manager, admin and owner roles of every existing
-- tenant, matching what `ROLE_PERMISSIONS` will now give a freshly provisioned
-- one (§G).
--
-- `isSystem = TRUE` is the whole condition. A merchant's own custom role named
-- "manager" is their label, not Korvi's authority, and silently widening it
-- would hand a permission to people an administrator never chose. Cashier is
-- excluded here because it is excluded in the canonical map.
--
-- ## Why FORCE is lifted for this statement
--
-- `roles` and `role_permissions` are both under FORCE ROW LEVEL SECURITY,
-- which — this being the point of FORCE — applies to the table's owner too,
-- and the migration runs as the owner. With no `app.tenant_id` set,
-- `tenantId = current_tenant_id()` is NULL for every row: the SELECT would
-- read nothing and the INSERT would write nothing, and this migration would
-- silently grant the permission to no one while reporting success.
--
-- Per-tenant `set_config` is not an option either: a migration cannot enumerate
-- tenants it is forbidden to see. Connecting as a BYPASSRLS or superuser role
-- would trade a permanent installation-wide privilege for one backfill, which
-- is the trade ADR-0004 refuses.
--
-- Safe because of the explicit BEGIN at the top of this file and the COMMIT at
-- the bottom, and for no other reason:
--
--   every statement here is in one transaction, so no other session ever
--   observes these tables with FORCE off, and no failure can leave it off;
--
--   ALTER TABLE takes an ACCESS EXCLUSIVE lock, so nothing else can read or
--   write either table while it is off.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" NO FORCE ROW LEVEL SECURITY;

-- The id is UUIDv7, like every other id Korvi mints (ADR-0003), built from
-- core functions only: no extension, no permanent function, nothing left
-- behind. `gen_random_uuid()` has been in core since PostgreSQL 13 and is used
-- purely as a source of random bits here.
--
--   12 hex  48-bit big-endian unix milliseconds
--    1 hex  version nibble, literally '7'
--    3 hex  rand_a, taken from a v4's random bits
--   16 hex  the variant nibble and rand_b, taken from a second v4 — position 17
--           of a v4 already carries the correct RFC 4122 variant (8, 9, a or b),
--           so it is reused rather than re-derived
--
-- Two separate `gen_random_uuid()` calls, so the discarded bits of one are not
-- silently correlated with the kept bits of the other.
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
  'inventory.transfer'
FROM "roles" r
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager', 'admin', 'owner')
-- Named target, not a bare DO NOTHING. "Already granted" is the only collision
-- this statement is entitled to swallow; an id collision or any other
-- constraint violation is a fault and must fail the migration rather than
-- quietly leave a role without the permission it was supposed to receive.
ON CONFLICT ("tenantId", "roleId", "permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
