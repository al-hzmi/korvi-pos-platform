-- Korvi POS — Strike 2B: authentication and authorization.
--
-- Forward only. It adds auth state to users, creates the sessions table, and
-- opens exactly one new door in the tenancy boundary — the login-resolution
-- policy described below. It drops no table and rewrites no data.
--
-- The Strike 2A migration is history and is not touched.

-- ---------------------------------------------------------------------------
-- User authentication state
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

-- A negative attempt count would mean the counter was written by something
-- other than the login path.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_failed_login_non_negative";
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_non_negative"
  CHECK ("failedLoginCount" >= 0);
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_auth_version_positive";
ALTER TABLE "users" ADD CONSTRAINT "users_auth_version_positive"
  CHECK ("authVersion" >= 1);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE "sessions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  -- The hash, never the token. A database backup is not a set of credentials.
  "tokenHash" TEXT NOT NULL,
  "authVersion" INTEGER NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "sessions_expires_after_creation" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The Strike 2A tenant-consistency strategy: (tenantId, userId) rather than
  -- userId alone, so a session cannot be minted against another tenant's user.
  CONSTRAINT "sessions_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");
CREATE INDEX "sessions_tenantId_userId_idx" ON "sessions"("tenantId", "userId");
CREATE INDEX "sessions_tenantId_expiresAt_idx" ON "sessions"("tenantId", "expiresAt");

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_isolation" ON "sessions";
CREATE POLICY "sessions_isolation" ON "sessions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Login tenant resolution
-- ---------------------------------------------------------------------------
--
-- The bootstrap problem: authentication has to turn an untrusted tenant slug
-- into the tenant that will *become* the scope, and `tenants` is under FORCE
-- RLS keyed on a scope that does not exist yet.
--
-- The three wrong answers are disabling RLS, connecting as a superuser, and
-- granting BYPASSRLS. Each of them trades a permanent, installation-wide hole
-- for one lookup.
--
-- What this does instead is add a second, deliberately tiny policy. It is
-- FOR SELECT only, so no INSERT, UPDATE or DELETE can travel through it —
-- PostgreSQL will not even consider it for those commands. It matches on
-- equality against one transaction-local setting, so it returns at most the
-- single row whose slug was submitted, never a list. And the setting defaults
-- to NULL, so on every ordinary request the added term contributes nothing and
-- the isolation policy is the only one in effect.
--
-- Permissive policies combine with OR. The existing `tenants_isolation` policy
-- is unchanged and still governs everything else.

-- STABLE for the same reason current_tenant_id() is: the value changes between
-- transactions, and IMMUTABLE would let the planner cache one login's slug
-- into another's plan.
CREATE OR REPLACE FUNCTION login_tenant_slug() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.login_tenant_slug', TRUE), '');
$$ LANGUAGE SQL STABLE;

DROP POLICY IF EXISTS "tenants_login_resolution" ON "tenants";
CREATE POLICY "tenants_login_resolution" ON "tenants"
  FOR SELECT
  USING ("slug" = login_tenant_slug());

-- No WITH CHECK, because a FOR SELECT policy cannot carry one — PostgreSQL
-- rejects the syntax. That is the point rather than an omission: this door
-- reads, and there is no version of it that writes.
