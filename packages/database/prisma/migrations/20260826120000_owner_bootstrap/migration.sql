-- Korvi POS — Strike 4D-3: initial owner bootstrap.
--
-- Provisioning creates a tenant and no merchant user (ADR-0018), and the
-- merchant surfaces all require a real session. This table is the one bridge
-- across that gap: a control-plane operator issues an invitation, and the
-- invitee sets the first password against it.
--
-- Additive only. No existing table, column, policy or constraint is touched.
--
-- Two things are deliberately absent from this schema and must stay absent:
-- the raw capability token, and the key that signs it. The token is derivable
-- from this row plus the signing key, so storing it would keep a live
-- credential in a table for no gain; the key is configuration and belongs
-- nowhere near a backup (ADR-0021).

BEGIN;

CREATE TABLE "tenant_owner_bootstrap_invitations" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,

  -- Control-plane idempotency, the same shape 4A and 4C already use.
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,

  -- The account this invitation may establish, bound at issue time. Public
  -- acceptance never sends an address; it is read from this column under the
  -- row's own lock, so the invitee cannot redirect the invitation to somebody
  -- else by presenting a different email.
  "email" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,

  "controlPlaneActorRef" TEXT NOT NULL,

  "expiresAt" TIMESTAMP(3) NOT NULL,
  -- Set exactly once, by a successful acceptance, and by nothing else. Single
  -- use is this column plus a FOR UPDATE lock.
  --
  -- Expiry never writes here. An invitation that simply ran out of time keeps
  -- "consumedAt" NULL and stays a historical row: it was never presented, and
  -- stamping it as consumed would make this column — the one the audit trail
  -- and every replay check read — assert an acceptance that did not happen.
  -- "Is this invitation still live" is therefore two facts, not one, and both
  -- are asked wherever it matters.
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tobi_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "tobi_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  -- The same base64url SHA-256 shape every other control-plane fingerprint in
  -- Korvi carries, so a hand-written row cannot pretend to be a fingerprint.
  CONSTRAINT "tobi_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  -- Normalised by the domain before it arrives: lower-cased, NFKC, trimmed.
  -- Asserted here too, because this column decides which account is created.
  CONSTRAINT "tobi_email_shape"
    CHECK (
      "email" = btrim("email")
      AND "email" = lower("email")
      AND char_length("email") BETWEEN 3 AND 254
      AND "email" LIKE '%_@_%.__%'
    ),

  CONSTRAINT "tobi_display_name_bounded"
    CHECK (
      "displayName" = btrim("displayName")
      AND char_length("displayName") BETWEEN 1 AND 120
    ),

  CONSTRAINT "tobi_actor_bounded"
    CHECK (
      "controlPlaneActorRef" = btrim("controlPlaneActorRef")
      AND char_length("controlPlaneActorRef") BETWEEN 1 AND 120
    ),

  -- An invitation that expires before it exists is not an invitation.
  CONSTRAINT "tobi_expiry_after_creation"
    CHECK ("expiresAt" > "createdAt"),

  -- An acceptance cannot predate the invitation it accepted. Named for what it
  -- actually checks: it does not bound consumption by "expiresAt", because the
  -- expiry rule lives in the acceptance transaction, under the row's own lock,
  -- where it can be evaluated against the same clock as everything else.
  CONSTRAINT "tobi_consumed_after_creation"
    CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
);

-- Short, explicit names throughout: PostgreSQL truncates identifiers at 63
-- bytes, and `tenant_owner_bootstrap_invitations_tenantId_operationId_key`
-- would be silently cut — two constraints could then collide under one name.
CREATE UNIQUE INDEX "tobi_tenantId_id_key"
  ON "tenant_owner_bootstrap_invitations"("tenantId", "id");

-- Control-plane idempotency: one operation, one invitation.
CREATE UNIQUE INDEX "tobi_tenantId_operationId_key"
  ON "tenant_owner_bootstrap_invitations"("tenantId", "operationId");

-- There is deliberately no partial unique index on "one open invitation per
-- tenant". Prisma's schema language cannot express a partial index, so one
-- would read as permanent schema drift — and the rule does not need an index:
-- issuing takes the tenant row FOR UPDATE first, so two operators issuing at
-- the same moment serialise there and the second sees the first's row. The
-- lock is the boundary; an index would be a second, weaker statement of it.

CREATE INDEX "tobi_tenantId_expiresAt_idx"
  ON "tenant_owner_bootstrap_invitations"("tenantId", "expiresAt");

-- Private merchant data, inside the same boundary as users and sales. An
-- invitation names a person and a shop, and neither is anybody else's business
-- (ADR-0004).
ALTER TABLE "tenant_owner_bootstrap_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_owner_bootstrap_invitations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tobi_isolation" ON "tenant_owner_bootstrap_invitations";
CREATE POLICY "tobi_isolation" ON "tenant_owner_bootstrap_invitations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
