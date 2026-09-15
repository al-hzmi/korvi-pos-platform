-- Korvi POS — forward-only repair for native device/session schema integrity.
-- Historical migrations are immutable. This migration establishes the
-- canonical tenant composite key name and makes the latest Native Auth
-- RLS policy definitions explicitly recreatable.
-- The legacy composite unique index is intentionally retained: existing
-- foreign keys may already depend on that historical index identity, while
-- this canonical key gives later tenant-consistent references a stable target.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "device_enrollments_tenantId_id_key"
  ON "device_enrollments"("tenantId", "id");

ALTER TABLE "native_auth_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_auth_challenges" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "native_auth_challenges_isolation" ON "native_auth_challenges";
CREATE POLICY "native_auth_challenges_isolation" ON "native_auth_challenges"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "native_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "native_sessions_isolation" ON "native_sessions";
CREATE POLICY "native_sessions_isolation" ON "native_sessions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
