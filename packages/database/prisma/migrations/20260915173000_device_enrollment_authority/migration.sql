-- Korvi POS — Gate 13: installed-cashier device enrollment authority.
--
-- A terminal is a business/register concept. A device enrollment is the
-- cryptographic identity of one installed cashier instance. Keeping those
-- separate prevents a copied browser/local-store identifier from becoming
-- cloud authority merely because it names a valid terminal.
--
-- This table intentionally stores only a normalized fingerprint digest and a
-- public key. Raw motherboard/MAC/disk identifiers and private device keys have
-- no column by design.

BEGIN;

CREATE TABLE "device_enrollments" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,

  "operationId" VARCHAR(160) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "controlPlaneActorRef" VARCHAR(120) NOT NULL,

  "installationId" UUID NOT NULL,
  "platform" VARCHAR(16) NOT NULL,
  "normalizedFingerprintDigest" CHAR(64) NOT NULL,
  "publicKeySpki" BYTEA NOT NULL,
  "publicKeySha256" CHAR(64) NOT NULL,
  "keyAlgorithm" VARCHAR(16) NOT NULL,
  "appVersion" VARCHAR(64) NOT NULL,

  "state" VARCHAR(16) NOT NULL DEFAULT 'active',
  "enrolledAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,

  "revokedAt" TIMESTAMPTZ(6),
  "revocationOperationId" VARCHAR(160),
  "revocationRequestHash" CHAR(64),
  "revokedByActorRef" VARCHAR(120),
  "revocationReason" VARCHAR(500),

  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "device_enrollments_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_enrollments_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "device_enrollments_request_hash_sha256"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "device_enrollments_fingerprint_sha256"
    CHECK ("normalizedFingerprintDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "device_enrollments_public_key_sha256"
    CHECK ("publicKeySha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "device_enrollments_public_key_bounded"
    CHECK (octet_length("publicKeySpki") BETWEEN 32 AND 512),
  CONSTRAINT "device_enrollments_platform"
    CHECK ("platform" IN ('windows', 'android')),
  CONSTRAINT "device_enrollments_key_algorithm"
    CHECK ("keyAlgorithm" IN ('ed25519', 'p256')),
  CONSTRAINT "device_enrollments_app_version_bounded"
    CHECK (
      "appVersion" = btrim("appVersion")
      AND char_length("appVersion") BETWEEN 1 AND 64
    ),
  CONSTRAINT "device_enrollments_actor_bounded"
    CHECK (
      "controlPlaneActorRef" = btrim("controlPlaneActorRef")
      AND char_length("controlPlaneActorRef") BETWEEN 1 AND 120
    ),
  CONSTRAINT "device_enrollments_state"
    CHECK ("state" IN ('active', 'suspended', 'revoked', 'replaced')),
  CONSTRAINT "device_enrollments_times"
    CHECK (
      "lastSeenAt" >= "enrolledAt"
      AND "updatedAt" >= "enrolledAt"
    ),
  CONSTRAINT "device_enrollments_revocation_shape"
    CHECK (
      (
        "state" IN ('active', 'suspended')
        AND "revokedAt" IS NULL
        AND "revocationOperationId" IS NULL
        AND "revocationRequestHash" IS NULL
        AND "revokedByActorRef" IS NULL
        AND "revocationReason" IS NULL
      ) OR (
        "state" IN ('revoked', 'replaced')
        AND "revokedAt" IS NOT NULL
        AND "revocationOperationId" IS NOT NULL
        AND "revocationRequestHash" ~ '^[0-9a-f]{64}$'
        AND "revokedByActorRef" IS NOT NULL
        AND "revocationReason" IS NOT NULL
        AND "revokedAt" >= "enrolledAt"
      )
    )
);

CREATE UNIQUE INDEX "device_enrollments_tenant_operation_key"
  ON "device_enrollments"("tenantId", "operationId");
CREATE UNIQUE INDEX "device_enrollments_tenant_installation_key"
  ON "device_enrollments"("tenantId", "installationId");
CREATE UNIQUE INDEX "device_enrollments_tenant_public_key_key"
  ON "device_enrollments"("tenantId", "publicKeySha256");
CREATE UNIQUE INDEX "device_enrollments_tenant_revocation_operation_key"
  ON "device_enrollments"("tenantId", "revocationOperationId")
  WHERE "revocationOperationId" IS NOT NULL;

-- A suspended device still owns its slot. Only an explicit revoke/replacement
-- releases a terminal or fingerprint for a new enrollment.
CREATE UNIQUE INDEX "device_enrollments_live_terminal_key"
  ON "device_enrollments"("tenantId", "terminalId")
  WHERE "state" IN ('active', 'suspended');
CREATE UNIQUE INDEX "device_enrollments_live_fingerprint_key"
  ON "device_enrollments"("tenantId", "normalizedFingerprintDigest")
  WHERE "state" IN ('active', 'suspended');

CREATE INDEX "device_enrollments_tenant_state_last_seen_idx"
  ON "device_enrollments"("tenantId", "state", "lastSeenAt" DESC);

-- Identity fields are immutable. Lifecycle changes may update state/timestamps,
-- but an attacker or bug cannot turn one enrolled device into another by
-- rewriting installation/fingerprint/public-key/terminal identity in place.
CREATE FUNCTION device_enrollment_identity_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."tenantId" <> NEW."tenantId"
     OR OLD."terminalId" <> NEW."terminalId"
     OR OLD."operationId" <> NEW."operationId"
     OR OLD."requestHash" <> NEW."requestHash"
     OR OLD."controlPlaneActorRef" <> NEW."controlPlaneActorRef"
     OR OLD."installationId" <> NEW."installationId"
     OR OLD."platform" <> NEW."platform"
     OR OLD."normalizedFingerprintDigest" <> NEW."normalizedFingerprintDigest"
     OR OLD."publicKeySpki" <> NEW."publicKeySpki"
     OR OLD."publicKeySha256" <> NEW."publicKeySha256"
     OR OLD."keyAlgorithm" <> NEW."keyAlgorithm"
     OR OLD."appVersion" <> NEW."appVersion"
     OR OLD."enrolledAt" <> NEW."enrolledAt"
     OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'device enrollment identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD."state" = NEW."state" THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."state" = 'active' AND NEW."state" IN ('suspended', 'revoked', 'replaced'))
    OR (OLD."state" = 'suspended' AND NEW."state" IN ('active', 'revoked', 'replaced'))
  ) THEN
    RAISE EXCEPTION 'illegal device enrollment state transition: % -> %', OLD."state", NEW."state"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "device_enrollment_identity_guard"
  BEFORE UPDATE ON "device_enrollments"
  FOR EACH ROW EXECUTE FUNCTION device_enrollment_identity_guard();

ALTER TABLE "device_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_enrollments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "device_enrollments_isolation" ON "device_enrollments"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
