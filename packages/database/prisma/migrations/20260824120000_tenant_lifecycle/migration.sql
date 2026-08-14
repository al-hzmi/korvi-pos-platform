-- Korvi POS — Strike 4A: tenant lifecycle and provisioning authority.
--
-- Forward only. It adds lifecycle columns to `tenants`, constrains the status
-- column to the three states the code knows about, and makes a provisioning
-- operation id unique across the installation. It drops no table, rewrites no
-- history, and leaves every existing policy exactly as it was.
--
-- The one thing it deliberately changes for everybody is the NEW-ROW default:
-- a tenant created from now on starts in `provisioning`, not `active`. Rows
-- that already say `active` keep saying it (ADR-0018).
--
-- The governing rule for everything below the "Legacy rows" heading is:
--
--     an unknown historical fact is not a guessed fact.
--
-- A tenant that existed before this migration has a status. It does not have a
-- recorded admission time, and if it was already suspended it has no recorded
-- suspension time or reason. This migration says so, in the schema, rather than
-- reaching for whatever timestamp happens to be nearby.

-- ---------------------------------------------------------------------------
-- This migration owns its own transaction
-- ---------------------------------------------------------------------------
--
-- Explicit, and not an appeal to what the runner might do. Prisma Migrate does
-- not wrap a PostgreSQL migration file in a transaction on its own; a file that
-- wants one says BEGIN. Some clients also give a multi-statement string an
-- implicit transaction, which is exactly the kind of behaviour this file must
-- not depend on — it varies by driver, by protocol and by how a script is fed
-- to psql.
--
-- The dependency is not cosmetic. Between the NO FORCE below and the FORCE that
-- restores it, `tenants` is a table whose row-level security does not apply to
-- its owner. Every statement from BEGIN to COMMIT therefore has to commit
-- together or roll back together, so that the weakened state is never a state
-- anything can observe or, worse, be left in by a migration that failed
-- half-way. If any statement between here and COMMIT fails, PostgreSQL aborts
-- the transaction and FORCE was never off in any committed state.
BEGIN;

-- ---------------------------------------------------------------------------
-- The safe default
-- ---------------------------------------------------------------------------

-- A default applies to rows inserted after this statement and to nothing else,
-- so no existing merchant is deactivated by it.
ALTER TABLE "tenants" ALTER COLUMN "status" SET DEFAULT 'provisioning';

-- ---------------------------------------------------------------------------
-- Lifecycle columns
-- ---------------------------------------------------------------------------

-- The control-plane operation that created the tenant, and the canonical
-- fingerprint of what it asked for. Nullable because every tenant provisioned
-- before this migration was created without one, and inventing an operation id
-- for them would be a claim about history that nobody made.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "provisioningOperationId" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "provisioningRequestHash" TEXT;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspensionReason" TEXT;

-- Whether this row's lifecycle history is known or merely inherited.
--
--   recorded — Korvi provisioned this tenant and every transition since has
--              gone through the control plane. Its history is complete, and
--              the strict invariants below apply in full.
--   legacy   — the tenant predates lifecycle recording. Its current status is
--              known; when it was admitted is not, and if it arrived suspended,
--              when and why is not either.
--
-- This is one column rather than a per-fact "known" flag because there is
-- exactly one cause of unknown history — existing before this migration — and
-- a row either has that cause or does not. It is set once and never promoted:
-- a legacy tenant that Korvi later suspends gains a real suspension time and
-- reason, but its admission time stays unknown for ever, so the row stays
-- legacy (ADR-0018).
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "lifecycleProvenance" TEXT;

-- ---------------------------------------------------------------------------
-- Legacy rows, with FORCE temporarily lifted
-- ---------------------------------------------------------------------------
--
-- `tenants` is under FORCE ROW LEVEL SECURITY, which — this being the whole
-- point of FORCE — applies to the table's owner as well, and the migration
-- runs as the owner. With no `app.tenant_id` set, `id = current_tenant_id()`
-- is NULL for every row, so a plain UPDATE here would silently touch nothing
-- and the constraints below would then fail on rows this statement was meant
-- to repair.
--
-- So FORCE is lifted for the duration and restored a few statements later.
--
-- The alternative — connecting as a BYPASSRLS or superuser role to run
-- migrations — trades a permanent installation-wide privilege for one
-- backfill, which is exactly the trade ADR-0004 refuses.
--
-- Safe because of the explicit BEGIN above and the COMMIT at the end of this
-- file, and for no other reason:
--
--   every statement in this file is in one transaction, so no other session
--   ever observes the table with FORCE off, and no failure can leave it off;
--
--   ALTER TABLE takes an ACCESS EXCLUSIVE lock, so nothing else can read or
--   write `tenants` while it is off.
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;

-- Every row that already exists inherited its state from before Korvi recorded
-- lifecycle. That is what `legacy` means, and it is true of an active tenant
-- as much as a suspended one: neither has a recorded admission.
UPDATE "tenants" SET "lifecycleProvenance" = 'legacy' WHERE "lifecycleProvenance" IS NULL;

-- A status this code cannot interpret becomes `suspended`, not `active`: a row
-- whose state cannot be read must not be one that can trade.
--
-- Unlike a row that already said `suspended`, this one is being suspended
-- *now*, by this migration — so `suspendedAt` and the reason are recorded, and
-- both are true statements about a Korvi action rather than guesses about the
-- merchant's past. The old value is quoted so the fact is recoverable.
UPDATE "tenants"
   SET "status" = 'suspended',
       "suspendedAt" = now(),
       "suspensionReason" =
         'Suspended by the 4A lifecycle migration: stored status "'
         || left("status", 40) || '" is not a Korvi lifecycle state.'
 WHERE "status" NOT IN ('provisioning', 'active', 'suspended');

-- Nothing else is written. An `active` legacy tenant keeps a NULL
-- `activatedAt`, and a legacy tenant that was already `suspended` keeps a NULL
-- `suspendedAt` and a NULL reason. "Unknown" is the honest value, and the
-- constraints below are written so it stays sayable.

ALTER TABLE "tenants" ALTER COLUMN "lifecycleProvenance" SET NOT NULL;
-- Rows created from here on are the control plane's, and their history is
-- complete by construction.
ALTER TABLE "tenants" ALTER COLUMN "lifecycleProvenance" SET DEFAULT 'recorded';

ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- The state machine, in the database. The application's transition table is
-- the thing that decides *which* move is legal; this decides that no move can
-- land anywhere the application has never heard of, including by way of a
-- typo in a hand-written UPDATE at three in the morning.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_status_known";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_known"
  CHECK ("status" IN ('provisioning', 'active', 'suspended'));

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_lifecycle_provenance_known";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_lifecycle_provenance_known"
  CHECK ("lifecycleProvenance" IN ('legacy', 'recorded'));

-- A tenant still being provisioned has no history at all, whatever its
-- provenance. Nothing has happened to it yet.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_provisioning_has_no_history";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_provisioning_has_no_history"
  CHECK (
    "status" <> 'provisioning'
    OR ("activatedAt" IS NULL AND "suspendedAt" IS NULL AND "suspensionReason" IS NULL)
  );

-- Suspension facts describe the present, not the past: a merchant that is
-- running carries none. Reactivation clears them, and the history of past
-- suspensions lives in `audit_events`, which nothing rewrites.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_suspension_evidence_current";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_suspension_evidence_current"
  CHECK (
    "status" = 'suspended'
    OR ("suspendedAt" IS NULL AND "suspensionReason" IS NULL)
  );

-- When and why arrive together or not at all. A time with no reason is not a
-- record, and a reason with no time is not a fact.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_suspension_evidence_paired";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_suspension_evidence_paired"
  CHECK (("suspendedAt" IS NULL) = ("suspensionReason" IS NULL));

-- Trimmed and bounded, never truncated. Half an explanation on the row that
-- stopped a merchant trading reads like the whole one.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_suspension_reason_bounded";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_suspension_reason_bounded"
  CHECK (
    "suspensionReason" IS NULL
    OR (
      "suspensionReason" = btrim("suspensionReason")
      AND char_length("suspensionReason") BETWEEN 1 AND 200
    )
  );

-- The strict all-or-nothing invariant, applied to every tenant whose history
-- Korvi actually recorded: admission is present exactly when the tenant has
-- been admitted, and a suspended tenant always carries when and why.
--
-- Legacy rows are exempt from this one clause and only this one, because the
-- facts it demands do not exist for them. The exemption is deliberately not
-- "suspension may be incomplete" — the pairing rule above still applies to
-- legacy rows, so a legacy tenant either says nothing about its suspension or
-- says both halves. What it may not do is say half.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_recorded_lifecycle_complete";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_recorded_lifecycle_complete"
  CHECK (
    "lifecycleProvenance" <> 'recorded'
    OR (
      (("status" = 'provisioning') = ("activatedAt" IS NULL))
      AND (("status" = 'suspended') = ("suspendedAt" IS NOT NULL))
    )
  );

-- The operation id and the fingerprint of what it asked for arrive together or
-- not at all. An id with no fingerprint could not answer "is this the same
-- request?", which is the only question it exists to answer.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_provisioning_evidence_paired";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_provisioning_evidence_paired"
  CHECK (("provisioningOperationId" IS NULL) = ("provisioningRequestHash" IS NULL));

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_provisioning_evidence_bounded";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_provisioning_evidence_bounded"
  CHECK (
    (
      "provisioningOperationId" IS NULL
      OR char_length("provisioningOperationId") BETWEEN 1 AND 120
    )
    AND (
      "provisioningRequestHash" IS NULL
      OR char_length("provisioningRequestHash") BETWEEN 1 AND 128
    )
  );

-- ---------------------------------------------------------------------------
-- Provisioning idempotency
-- ---------------------------------------------------------------------------
--
-- Installation-wide rather than per-tenant, because the operation this id
-- names is the one that decides a tenant exists — there is no tenant to scope
-- it to until it has succeeded. Two racing provisioning calls carrying the
-- same id therefore contend on this index, exactly one inserts, and the loser
-- resolves the winner's row rather than minting a second merchant.
--
-- NULLs are distinct in a PostgreSQL unique index, so every tenant provisioned
-- before this migration coexists here without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_provisioningOperationId_key"
  ON "tenants"("provisioningOperationId");

-- ---------------------------------------------------------------------------
-- Unchanged on purpose
-- ---------------------------------------------------------------------------
--
-- `tenants_isolation` and `tenants_login_resolution` are not touched. The
-- control plane writes through the isolation policy by establishing the new
-- tenant's own context before inserting its row, so the WITH CHECK holds
-- without a new door being opened, and it resolves a provisioning replay
-- through the existing login-slug policy, which is FOR SELECT only (ADR-0018).

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------
--
-- Last, and only once the lifecycle columns, the legacy marking, the backfill,
-- the FORCE restoration, every constraint and the unique index have all
-- succeeded. Everything above lands together or none of it does.
COMMIT;
