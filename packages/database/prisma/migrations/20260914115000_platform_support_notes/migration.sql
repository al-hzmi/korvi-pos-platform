-- Korvi POS — append-only Platform Support Notes.
--
-- These records belong to the SaaS control plane, not to merchant staff. The
-- tenant foreign key anchors a note to the merchant it concerns, but access is
-- authorized only by the transaction-local control-plane actor established
-- after Platform Admin authentication.
--
-- This table is intentionally not mapped into the Prisma merchant schema. All
-- access goes through the reviewed raw control-plane authority so ordinary
-- tenant repositories cannot accidentally expose support content.
--
-- FORCE RLS plus SELECT/INSERT-only policies makes the record append-only to
-- the runtime role. There is deliberately no UPDATE or DELETE policy.

CREATE TABLE "platform_support_notes" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "operationId" VARCHAR(120) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "actorRef" VARCHAR(120) NOT NULL,
  "body" VARCHAR(4000) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_support_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_support_notes_tenantId_operationId_key"
  ON "platform_support_notes"("tenantId", "operationId");
CREATE INDEX "platform_support_notes_tenantId_createdAt_id_idx"
  ON "platform_support_notes"("tenantId", "createdAt" DESC, "id" DESC);

ALTER TABLE "platform_support_notes"
  ADD CONSTRAINT "platform_support_notes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_support_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_support_notes" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_support_notes_control_plane_read" ON "platform_support_notes";
CREATE POLICY "platform_support_notes_control_plane_read" ON "platform_support_notes"
  FOR SELECT
  USING (current_control_plane_actor() IS NOT NULL);

DROP POLICY IF EXISTS "platform_support_notes_control_plane_insert" ON "platform_support_notes";
CREATE POLICY "platform_support_notes_control_plane_insert" ON "platform_support_notes"
  FOR INSERT
  WITH CHECK (
    current_control_plane_actor() IS NOT NULL
    AND "actorRef" = current_control_plane_actor()
  );
