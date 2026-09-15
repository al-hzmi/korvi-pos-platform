-- Korvi POS — Native installed-cashier authentication authority.
--
-- Browser sessions remain in `sessions` and are deliberately untouched.
-- Installed clients get a separate realm with a separate token store bound to
-- one Gate 13 enrollment, terminal, branch and immutable device public key.
-- Private keys are not accepted or stored anywhere in this schema.

BEGIN;

-- Composite tenant keys let every child foreign key repeat the tenant. The
-- device enrollment id is globally unique already, but the repeated tenant id
-- makes a cross-tenant binding impossible at the database boundary too.
CREATE UNIQUE INDEX IF NOT EXISTS "device_enrollments_tenant_id_key"
  ON "device_enrollments"("tenantId", "id");

CREATE TABLE "native_auth_challenges" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "deviceEnrollmentId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "nonce" BYTEA NOT NULL,
  "issuedAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "native_auth_challenges_nonce_256_bit"
    CHECK (octet_length("nonce") = 32),
  CONSTRAINT "native_auth_challenges_expiry"
    CHECK ("expiresAt" > "issuedAt"),
  CONSTRAINT "native_auth_challenges_consumption_time"
    CHECK ("consumedAt" IS NULL OR "consumedAt" >= "issuedAt"),

  CONSTRAINT "native_auth_challenges_tenant_device_fkey"
    FOREIGN KEY ("tenantId", "deviceEnrollmentId")
    REFERENCES "device_enrollments"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_auth_challenges_tenant_terminal_fkey"
    FOREIGN KEY ("tenantId", "terminalId")
    REFERENCES "terminals"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_auth_challenges_tenant_branch_fkey"
    FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "native_auth_challenges_expiry_idx"
  ON "native_auth_challenges"("tenantId", "expiresAt")
  WHERE "consumedAt" IS NULL;
CREATE INDEX "native_auth_challenges_device_idx"
  ON "native_auth_challenges"("tenantId", "deviceEnrollmentId", "issuedAt" DESC);

ALTER TABLE "native_auth_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_auth_challenges" FORCE ROW LEVEL SECURITY;
CREATE POLICY "native_auth_challenges_isolation" ON "native_auth_challenges"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

CREATE TABLE "native_sessions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  -- Hash only. The kns1 bearer value exists only in the native process.
  "tokenHash" TEXT NOT NULL,
  "authVersion" INTEGER NOT NULL,

  "deviceEnrollmentId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "devicePublicKeySha256" CHAR(64) NOT NULL,

  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),

  CONSTRAINT "native_sessions_key_sha256"
    CHECK ("devicePublicKeySha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "native_sessions_expiry"
    CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "native_sessions_seen_time"
    CHECK ("lastSeenAt" >= "createdAt"),
  CONSTRAINT "native_sessions_revocation_time"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt"),

  CONSTRAINT "native_sessions_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_sessions_tenant_user_fkey"
    FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_sessions_tenant_device_fkey"
    FOREIGN KEY ("tenantId", "deviceEnrollmentId")
    REFERENCES "device_enrollments"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "native_sessions_tenant_terminal_fkey"
    FOREIGN KEY ("tenantId", "terminalId")
    REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "native_sessions_tenant_branch_fkey"
    FOREIGN KEY ("tenantId", "branchId")
    REFERENCES "branches"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "native_sessions_token_hash_key" ON "native_sessions"("tokenHash");
CREATE INDEX "native_sessions_user_idx"
  ON "native_sessions"("tenantId", "userId", "expiresAt" DESC);
CREATE INDEX "native_sessions_device_idx"
  ON "native_sessions"("tenantId", "deviceEnrollmentId", "expiresAt" DESC);

ALTER TABLE "native_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "native_sessions_isolation" ON "native_sessions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
