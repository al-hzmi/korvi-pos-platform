-- Korvi POS — durable Platform Admin session revocation.
--
-- Platform control-plane cookies are signed, but signing alone cannot revoke a
-- stolen cookie before its TTL expires. This table stores only session identity
-- and lifecycle state; no access key, signing key, or bearer token is persisted.
--
-- Access is restricted to the configured control-plane actor through the
-- transaction-local app.control_plane_actor boundary. Tenant sessions and
-- merchant RLS are untouched.

BEGIN;

CREATE TABLE "platform_admin_sessions" (
  "id" UUID PRIMARY KEY,
  "actorRef" VARCHAR(120) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),

  CONSTRAINT "platform_admin_sessions_actor_bounded"
    CHECK (
      "actorRef" = btrim("actorRef")
      AND char_length("actorRef") BETWEEN 1 AND 120
    ),
  CONSTRAINT "platform_admin_sessions_expiry"
    CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "platform_admin_sessions_revocation_time"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

CREATE INDEX "platform_admin_sessions_actor_expiry_idx"
  ON "platform_admin_sessions"("actorRef", "expiresAt" DESC);

ALTER TABLE "platform_admin_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_admin_sessions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_admin_sessions_select" ON "platform_admin_sessions";
CREATE POLICY "platform_admin_sessions_select" ON "platform_admin_sessions"
  FOR SELECT
  USING (
    current_control_plane_actor() IS NOT NULL
    AND "actorRef" = current_control_plane_actor()
  );

DROP POLICY IF EXISTS "platform_admin_sessions_insert" ON "platform_admin_sessions";
CREATE POLICY "platform_admin_sessions_insert" ON "platform_admin_sessions"
  FOR INSERT
  WITH CHECK (
    current_control_plane_actor() IS NOT NULL
    AND "actorRef" = current_control_plane_actor()
  );

DROP POLICY IF EXISTS "platform_admin_sessions_update" ON "platform_admin_sessions";
CREATE POLICY "platform_admin_sessions_update" ON "platform_admin_sessions"
  FOR UPDATE
  USING (
    current_control_plane_actor() IS NOT NULL
    AND "actorRef" = current_control_plane_actor()
  )
  WITH CHECK (
    current_control_plane_actor() IS NOT NULL
    AND "actorRef" = current_control_plane_actor()
  );

COMMIT;
