-- Korvi POS — Strike 5B: purchasing and receiving.
--
-- One sentence governs this whole file:
--
--   A PURCHASE ORDER IS NOT A STOCK MOVEMENT.
--
-- Nothing here touches `inventory_movements` or `inventory_balances`. The
-- causal ledger and its materialized balance stay exactly as Strike 5A left
-- them, and the only way a row in this migration reaches stock is through a
-- *receipt* — evidence that goods physically arrived and were accepted — going
-- through the shared movement primitive (ADR-0024 §7).
--
-- `inventory_movements.kind` has permitted 'receipt' since the SaaS foundation
-- migration, so receiving needs no widening of historical vocabulary and
-- overloads nothing. `sourceType = 'purchase-receipt'` is what distinguishes a
-- purchasing arrival from any other receipt-shaped movement.
--
-- Additive and forward-only. No existing table, column, policy, constraint or
-- historical row is rewritten, and no purchasing history is fabricated for
-- stock that arrived before this migration existed.
--
-- There is no cost of any kind in this file. Costing is Strike 5C, and the
-- absence is deliberate rather than an omission (§3).

BEGIN;

-- ---------------------------------------------------------------------------
-- Durable operation results
-- ---------------------------------------------------------------------------

-- What the operation actually returned, frozen at the moment it committed.
--
-- Korvi's idempotency doctrine promises that the same operation id carrying the
-- same intent *replays the committed result*. Recording only `resultId` keeps
-- that promise for exactly as long as nothing else changes: after a second,
-- perfectly legitimate mutation, reconstructing the answer by reading the
-- document back returns today's state rather than what the operation produced.
--
-- Concretely, and this is the defect this column exists to remove: a receipt
-- that took a purchase order from `open` to `partially_received`, replayed
-- after a later receipt completed the order, would report `received` — a status
-- that operation never produced. The same reasoning applies to a purchase order
-- replayed after goods arrived against it, and to a supplier replayed after a
-- rename.
--
-- So the answer is stored, not recomputed. It is written in the same
-- transaction as the mutation it describes, which is what makes it evidence
-- rather than a cache: a rolled-back operation has no snapshot, and a committed
-- one cannot lack it.
--
-- Nullable, with no backfill. Operations that committed before this column
-- existed have no recorded answer and must not be given an invented one; the
-- 5A stock scopes keep their existing behaviour untouched, and only the
-- purchasing scopes write here. A NULL on a purchasing scope is therefore
-- unreachable rather than merely unlikely, and the authority treats it as a
-- fault instead of guessing.
--
-- JSONB rather than TEXT: it is a structured answer, it is read back
-- structurally, and PostgreSQL should refuse malformed content at write time.
-- It contains only what the caller was already shown — identifiers, quantities
-- as decimal strings, statuses and timestamps. Never a credential.
ALTER TABLE "idempotency_keys"
  ADD COLUMN "resultSnapshot" JSONB;

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

-- Deliberately minimal. A supplier here is a name a merchant can order from
-- and sign for; contact, tax, banking and terms are all real needs and all
-- belong to strikes that have somewhere to put them (§5).
CREATE TABLE "suppliers" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,

  "name" TEXT NOT NULL,

  -- Administrative state, not deletion. A deactivated supplier cannot be
  -- chosen for a *new* purchase order, and every order and receipt that
  -- already names them stays exactly as valid as the day it was signed.
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "suppliers_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "suppliers_name_bounded"
    CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 160)
);

-- No unique index on the name. Two genuinely different companies can trade
-- under the same name, and a merchant with two accounts at one wholesaler is
-- ordinary. A uniqueness rule nobody asked for would block real data entry to
-- prevent a problem that has not been shown to exist (§5).
CREATE UNIQUE INDEX "suppliers_tenantId_id_key" ON "suppliers"("tenantId", "id");
CREATE INDEX "suppliers_tenantId_isActive_name_idx"
  ON "suppliers"("tenantId", "isActive", "name");

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------

CREATE TABLE "purchase_orders" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  -- Where the goods are expected to physically arrive, and therefore the only
  -- branch a receipt against this order may move stock in.
  "branchId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,

  -- The merchant's own document number, if they keep one. Optional, because
  -- plenty of shops order by phone.
  "reference" TEXT,

  -- Server-controlled, always. Derived from the line accumulators inside the
  -- transaction that changed them, never submitted and never stored
  -- independently of the lines it summarises (§7).
  "status" TEXT NOT NULL DEFAULT 'open',

  "actorUserId" UUID NOT NULL,
  "orderedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "purchase_orders_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- NO ACTION, not CASCADE. Deleting a supplier row must not silently erase
  -- the record of what was bought from them: that record is the evidence a
  -- merchant reconciles a delivery against, and it has to outlive an
  -- administrative tidy-up (ADR-0024 §10, §21).
  CONSTRAINT "purchase_orders_tenantId_supplierId_fkey"
    FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_orders_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_orders_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  -- The closed status vocabulary, asserted by the database. Strike 5B has no
  -- cancellation and no draft state, and a value outside these three would be
  -- a status nothing in the codebase knows how to interpret.
  CONSTRAINT "purchase_orders_status"
    CHECK ("status" IN ('open', 'partially_received', 'received')),

  CONSTRAINT "purchase_orders_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "purchase_orders_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "purchase_orders_reference_bounded"
    CHECK (
      "reference" IS NULL
      OR ("reference" = btrim("reference") AND char_length("reference") BETWEEN 1 AND 120)
    )
);

CREATE UNIQUE INDEX "purchase_orders_tenantId_id_key" ON "purchase_orders"("tenantId", "id");

CREATE UNIQUE INDEX "purchase_orders_tenantId_operationId_key"
  ON "purchase_orders"("tenantId", "operationId");

CREATE INDEX "purchase_orders_tenantId_status_orderedAt_idx"
  ON "purchase_orders"("tenantId", "status", "orderedAt");

CREATE INDEX "purchase_orders_tenantId_supplierId_orderedAt_idx"
  ON "purchase_orders"("tenantId", "supplierId", "orderedAt");

CREATE INDEX "purchase_orders_tenantId_branchId_orderedAt_idx"
  ON "purchase_orders"("tenantId", "branchId", "orderedAt");

CREATE TABLE "purchase_order_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "purchaseOrderId" UUID NOT NULL,
  "productId" UUID NOT NULL,

  -- What was asked for. Fixed at creation: this strike has no draft-edit
  -- workflow, and a quantity that could be revised after a partial receipt
  -- would let a merchant retroactively legalise an over-receipt.
  "orderedQuantityScaled" BIGINT NOT NULL,

  -- What has actually been accepted so far, accumulated one receipt at a time
  -- under this row's lock. Starts at zero — creating an order moves no stock
  -- and receives nothing (§8).
  "receivedQuantityScaled" BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT "purchase_order_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- CASCADE to its own header, because a line has no meaning without the order
  -- it belongs to and the two are one document. Everything *outside* the
  -- document is NO ACTION.
  CONSTRAINT "purchase_order_lines_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId")
    REFERENCES "purchase_orders"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "purchase_order_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_order_lines_ordered_positive"
    CHECK ("orderedQuantityScaled" > 0),

  -- The over-receipt invariant, written where it cannot be forgotten.
  --
  -- The authority enforces this under the line's row lock, which is what makes
  -- two concurrent receipts unable to spend the same remaining quantity. This
  -- constraint is the second, independent statement of the same rule: if a
  -- future code path ever accumulates without holding the lock, the database
  -- refuses the row rather than quietly recording stock that was never
  -- ordered (§11).
  CONSTRAINT "purchase_order_lines_received_within_ordered"
    CHECK (
      "receivedQuantityScaled" >= 0
      AND "receivedQuantityScaled" <= "orderedQuantityScaled"
    )
);

CREATE UNIQUE INDEX "purchase_order_lines_tenantId_id_key"
  ON "purchase_order_lines"("tenantId", "id");

-- One line per product per order: two accumulators for one physical thing
-- would leave a receipt choosing which one it was filling.
CREATE UNIQUE INDEX "purchase_order_lines_tenantId_purchaseOrderId_productId_key"
  ON "purchase_order_lines"("tenantId", "purchaseOrderId", "productId");

CREATE INDEX "purchase_order_lines_tenantId_productId_idx"
  ON "purchase_order_lines"("tenantId", "productId");

-- ---------------------------------------------------------------------------
-- Purchase receipts
-- ---------------------------------------------------------------------------

-- The document that *is* allowed to move stock.
--
-- Every receipt is immutable historical evidence. There is no update path and
-- no delete route; a mistake is corrected by a compensating business operation
-- that leaves both records standing, never by editing what was signed for
-- (ADR-0024 §10).
CREATE TABLE "purchase_receipts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "purchaseOrderId" UUID NOT NULL,

  -- Denormalized from the order at receipt time, and deliberately so: these
  -- are the branch the goods entered and the supplier who delivered them, as
  -- they stood when somebody signed. Rederiving them later from a mutable
  -- order would make the evidence depend on the present.
  "branchId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,

  -- The supplier's delivery-note number, if the merchant records one.
  "reference" TEXT,

  "actorUserId" UUID NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "purchase_receipts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- NO ACTION even to its own order. A receipt is not a detail of the order:
  -- it is the record that goods physically arrived and stock moved, and the
  -- movements it caused are still in the ledger. Deleting the order out from
  -- under it would leave balance history no document explains (§21).
  CONSTRAINT "purchase_receipts_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId")
    REFERENCES "purchase_orders"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipts_tenantId_branchId_fkey"
    FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipts_tenantId_supplierId_fkey"
    FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipts_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipts_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "purchase_receipts_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "purchase_receipts_reference_bounded"
    CHECK (
      "reference" IS NULL
      OR ("reference" = btrim("reference") AND char_length("reference") BETWEEN 1 AND 120)
    )
);

CREATE UNIQUE INDEX "purchase_receipts_tenantId_id_key"
  ON "purchase_receipts"("tenantId", "id");

CREATE UNIQUE INDEX "purchase_receipts_tenantId_operationId_key"
  ON "purchase_receipts"("tenantId", "operationId");

CREATE INDEX "purchase_receipts_tenantId_purchaseOrderId_receivedAt_idx"
  ON "purchase_receipts"("tenantId", "purchaseOrderId", "receivedAt");

CREATE INDEX "purchase_receipts_tenantId_branchId_receivedAt_idx"
  ON "purchase_receipts"("tenantId", "branchId", "receivedAt");

CREATE TABLE "purchase_receipt_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "purchaseReceiptId" UUID NOT NULL,
  "purchaseOrderLineId" UUID NOT NULL,

  -- Derived from the locked PO line, never supplied by the client. Stored
  -- rather than joined so the movement this line caused can be checked against
  -- the line itself without trusting that the order still says the same thing.
  "productId" UUID NOT NULL,

  "acceptedQuantityScaled" BIGINT NOT NULL,

  -- The accumulator either side of this receipt, and the order quantity it was
  -- measured against. Three numbers rather than one, because the arithmetic
  -- below can then be asserted by the database instead of trusted.
  "orderedQuantityScaled" BIGINT NOT NULL,
  "beforeReceivedQuantityScaled" BIGINT NOT NULL,
  "afterReceivedQuantityScaled" BIGINT NOT NULL,

  -- The stock effect this line produced, as evidence. The revision is the
  -- balance's counter *after* this line's movement, so a reader can line the
  -- receipt up against `inventory_balances` without replaying the ledger.
  "beforeQuantityScaled" BIGINT NOT NULL,
  "afterQuantityScaled" BIGINT NOT NULL,
  "resultRevision" BIGINT NOT NULL,

  CONSTRAINT "purchase_receipt_lines_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipt_lines_tenantId_purchaseReceiptId_fkey"
    FOREIGN KEY ("tenantId", "purchaseReceiptId")
    REFERENCES "purchase_receipts"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipt_lines_tenantId_purchaseOrderLineId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderLineId")
    REFERENCES "purchase_order_lines"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "purchase_receipt_lines_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  -- Nothing arrives in a negative quantity, and a line that accepted nothing
  -- is not a receipt line.
  CONSTRAINT "purchase_receipt_lines_accepted_positive"
    CHECK ("acceptedQuantityScaled" > 0),

  -- afterReceived = beforeReceived + accepted, asserted rather than trusted.
  -- A line cannot record an accumulator pair its own accepted quantity does
  -- not explain (§14).
  CONSTRAINT "purchase_receipt_lines_received_arithmetic"
    CHECK (
      "afterReceivedQuantityScaled"
        = "beforeReceivedQuantityScaled" + "acceptedQuantityScaled"
    ),

  -- afterReceived <= ordered. The over-receipt rule again, stated on the
  -- evidence as well as on the accumulator, so a receipt line that claims to
  -- have taken delivery of more than was ordered cannot be written even if the
  -- order row were somehow wrong (§11, §14).
  CONSTRAINT "purchase_receipt_lines_within_ordered"
    CHECK (
      "beforeReceivedQuantityScaled" >= 0
      AND "afterReceivedQuantityScaled" <= "orderedQuantityScaled"
    ),

  -- The stock effect is exactly the accepted quantity. A receipt line that
  -- moved a different amount than it accepted would be the "stock effect
  -- without receipt evidence" case this strike exists to make impossible.
  CONSTRAINT "purchase_receipt_lines_stock_arithmetic"
    CHECK ("afterQuantityScaled" = "beforeQuantityScaled" + "acceptedQuantityScaled"),

  -- Every receipt line writes exactly one movement, so the balance it touched
  -- has been incremented at least once and its revision cannot be zero.
  CONSTRAINT "purchase_receipt_lines_revision_positive"
    CHECK ("resultRevision" >= 1)
);

CREATE UNIQUE INDEX "purchase_receipt_lines_tenantId_id_key"
  ON "purchase_receipt_lines"("tenantId", "id");

-- One line per PO line per receipt. Two would be two claims on one remaining
-- quantity inside a single document.
CREATE UNIQUE INDEX "purchase_receipt_lines_tenantId_receiptId_orderLineId_key"
  ON "purchase_receipt_lines"("tenantId", "purchaseReceiptId", "purchaseOrderLineId");

CREATE INDEX "purchase_receipt_lines_tenantId_purchaseOrderLineId_idx"
  ON "purchase_receipt_lines"("tenantId", "purchaseOrderLineId");

CREATE INDEX "purchase_receipt_lines_tenantId_productId_idx"
  ON "purchase_receipt_lines"("tenantId", "productId");

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- All five tables are private merchant commercial data — who a shop buys from,
-- at what volume, and when their deliveries arrive — so they sit inside
-- exactly the same boundary as sales and stock (ADR-0004).

ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "suppliers_isolation" ON "suppliers";
CREATE POLICY "suppliers_isolation" ON "suppliers"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_orders_isolation" ON "purchase_orders";
CREATE POLICY "purchase_orders_isolation" ON "purchase_orders"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_order_lines_isolation" ON "purchase_order_lines";
CREATE POLICY "purchase_order_lines_isolation" ON "purchase_order_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "purchase_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_receipts_isolation" ON "purchase_receipts";
CREATE POLICY "purchase_receipts_isolation" ON "purchase_receipts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "purchase_receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_receipt_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_receipt_lines_isolation" ON "purchase_receipt_lines";
CREATE POLICY "purchase_receipt_lines_isolation" ON "purchase_receipt_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- The new permissions
-- ---------------------------------------------------------------------------

-- Global application vocabulary, not tenant data. The boot-time
-- `provisionPermissionCatalogue` writes the same rows idempotently; doing it
-- here as well means a deployment that migrates before it boots has a
-- consistent catalogue in between.
INSERT INTO "permissions" ("key", "descriptionAr", "descriptionEn")
VALUES
  ('purchasing.read', 'عرض المشتريات والموردين', 'View purchasing and suppliers'),
  ('purchasing.manage', 'إدارة الموردين وأوامر الشراء', 'Manage suppliers and purchase orders'),
  ('purchasing.receive', 'استلام بضاعة أوامر الشراء', 'Receive purchase order goods')
ON CONFLICT ("key") DO NOTHING;

-- Grant all three to the *system* manager, admin and owner roles of every
-- existing tenant, matching what `ROLE_PERMISSIONS` now gives a freshly
-- provisioned one (§18).
--
-- `isSystem = TRUE` is the whole condition. A merchant's own custom role named
-- "manager" is their label, not Korvi's authority, and silently widening it
-- would hand purchasing power to people an administrator never chose. Cashier
-- is excluded here because it is excluded in the canonical map: a till neither
-- orders from suppliers nor signs for a delivery.
--
-- ## Why FORCE is lifted for this statement
--
-- `roles` and `role_permissions` are both under FORCE ROW LEVEL SECURITY,
-- which — this being the point of FORCE — applies to the table's owner too,
-- and the migration runs as the owner. With no `app.tenant_id` set,
-- `tenantId = current_tenant_id()` is NULL for every row: the SELECT would
-- read nothing and the INSERT would write nothing, and this migration would
-- silently grant the permissions to no one while reporting success.
--
-- Per-tenant `set_config` is not an option either: a migration cannot
-- enumerate tenants it is forbidden to see. Connecting as a BYPASSRLS or
-- superuser role would trade a permanent installation-wide privilege for one
-- backfill, which is the trade ADR-0004 refuses.
--
-- Safe because of the explicit BEGIN at the top of this file and the COMMIT at
-- the bottom, and for no other reason:
--
--   every statement here is in one transaction, so no other session ever
--   observes these tables with FORCE off, and no failure can leave it off;
--
--   ALTER TABLE takes an ACCESS EXCLUSIVE lock, so nothing else can read or
--   write either table while it is off.
--
-- This is the pattern Strike 5A proved for `inventory.transfer` and Strike 4A
-- proved before it, reused rather than reinvented.
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
  granted."permissionKey"
FROM "roles" r
CROSS JOIN (
  VALUES ('purchasing.read'), ('purchasing.manage'), ('purchasing.receive')
) AS granted("permissionKey")
WHERE r."isSystem" = TRUE
  AND r."key" IN ('manager', 'admin', 'owner')
-- Named target, not a bare DO NOTHING. "Already granted" is the only collision
-- this statement is entitled to swallow; an id collision or any other
-- constraint violation is a fault and must fail the migration rather than
-- quietly leave a role without a permission it was supposed to receive.
ON CONFLICT ("tenantId", "roleId", "permissionKey") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

COMMIT;
