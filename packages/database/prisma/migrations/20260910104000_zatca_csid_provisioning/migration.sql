-- Korvi POS — Gate 39: durable ZATCA Compliance CSID provisioning.
--
-- A CSID issuance POST is not safely replayable after the first outbound byte:
-- ZATCA may have accepted the request even when Korvi never receives a response.
-- This table therefore persists the uncertainty boundary before networking and
-- makes every subsequent state transition compare-and-set. It stores public
-- certificate material and opaque provider handles only. OTPs and the Fatoora
-- secret plaintext have no column by design.

BEGIN;

CREATE TABLE "zatca_csid_provisioning_attempts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,

  "operationId" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "environment" TEXT NOT NULL,

  "keyProvider" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "keyExportable" BOOLEAN NOT NULL,
  "csrSha256Hex" CHAR(64) NOT NULL,

  "state" TEXT NOT NULL,
  "preparedAt" TIMESTAMP(3) NOT NULL,
  "requestStartedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),

  -- Populated only when issuance is proven successful. The certificate is
  -- public X.509 DER. The Fatoora secret itself is deliberately absent: only
  -- the approved secret-manager locator may cross this boundary.
  "remoteRequestId" TEXT,
  "credentialId" TEXT,
  "certificateDer" BYTEA,
  "secretProvider" TEXT,
  "secretId" TEXT,

  -- Mutually exclusive terminal outcomes.
  "rejectionCode" TEXT,
  "uncertaintyReason" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_csid_provisioning_attempts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_csid_provisioning_attempts_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "zatca_csid_attempt_operation_bounded"
    CHECK ("operationId" = btrim("operationId") AND char_length("operationId") BETWEEN 1 AND 200),
  CONSTRAINT "zatca_csid_attempt_request_hash_sha256"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "zatca_csid_attempt_csr_hash_sha256"
    CHECK ("csrSha256Hex" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "zatca_csid_attempt_environment"
    CHECK ("environment" IN ('sandbox', 'simulation', 'production')),
  CONSTRAINT "zatca_csid_attempt_key_provider_bounded"
    CHECK ("keyProvider" = btrim("keyProvider") AND char_length("keyProvider") BETWEEN 1 AND 100),
  CONSTRAINT "zatca_csid_attempt_key_id_bounded"
    CHECK ("keyId" = btrim("keyId") AND char_length("keyId") BETWEEN 1 AND 500),
  CONSTRAINT "zatca_csid_attempt_key_non_exportable"
    CHECK ("keyExportable" = FALSE),
  CONSTRAINT "zatca_csid_attempt_state"
    CHECK ("state" IN ('prepared', 'in-flight', 'issued', 'rejected', 'uncertain')),
  CONSTRAINT "zatca_csid_attempt_uncertainty_reason"
    CHECK (
      "uncertaintyReason" IS NULL
      OR "uncertaintyReason" IN ('transport', 'response-invalid', 'credential-store')
    ),
  CONSTRAINT "zatca_csid_attempt_remote_request_bounded"
    CHECK (
      "remoteRequestId" IS NULL
      OR ("remoteRequestId" = btrim("remoteRequestId") AND char_length("remoteRequestId") BETWEEN 1 AND 500)
    ),
  CONSTRAINT "zatca_csid_attempt_credential_bounded"
    CHECK (
      "credentialId" IS NULL
      OR ("credentialId" = btrim("credentialId") AND char_length("credentialId") BETWEEN 1 AND 500)
    ),
  CONSTRAINT "zatca_csid_attempt_secret_provider_bounded"
    CHECK (
      "secretProvider" IS NULL
      OR ("secretProvider" = btrim("secretProvider") AND char_length("secretProvider") BETWEEN 1 AND 100)
    ),
  CONSTRAINT "zatca_csid_attempt_secret_id_bounded"
    CHECK (
      "secretId" IS NULL
      OR ("secretId" = btrim("secretId") AND char_length("secretId") BETWEEN 1 AND 1000)
    ),
  CONSTRAINT "zatca_csid_attempt_rejection_bounded"
    CHECK (
      "rejectionCode" IS NULL
      OR ("rejectionCode" = btrim("rejectionCode") AND char_length("rejectionCode") BETWEEN 1 AND 200)
    ),
  CONSTRAINT "zatca_csid_attempt_certificate_bounded"
    CHECK ("certificateDer" IS NULL OR octet_length("certificateDer") BETWEEN 1 AND 16384),
  CONSTRAINT "zatca_csid_attempt_exact_second_times"
    CHECK (
      date_trunc('second', "preparedAt") = "preparedAt"
      AND ("requestStartedAt" IS NULL OR date_trunc('second', "requestStartedAt") = "requestStartedAt")
      AND ("resolvedAt" IS NULL OR date_trunc('second', "resolvedAt") = "resolvedAt")
    ),
  CONSTRAINT "zatca_csid_attempt_causal_times"
    CHECK (
      ("requestStartedAt" IS NULL OR "requestStartedAt" >= "preparedAt")
      AND ("resolvedAt" IS NULL OR ("requestStartedAt" IS NOT NULL AND "resolvedAt" >= "requestStartedAt"))
    ),

  -- The row shape is a second state machine. A malformed half-issued credential
  -- cannot be committed even by raw SQL that bypasses the TypeScript mapper.
  CONSTRAINT "zatca_csid_attempt_state_shape"
    CHECK (
      (
        "state" = 'prepared'
        AND "requestStartedAt" IS NULL AND "resolvedAt" IS NULL
        AND "remoteRequestId" IS NULL AND "credentialId" IS NULL
        AND "certificateDer" IS NULL AND "secretProvider" IS NULL AND "secretId" IS NULL
        AND "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'in-flight'
        AND "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NULL
        AND "remoteRequestId" IS NULL AND "credentialId" IS NULL
        AND "certificateDer" IS NULL AND "secretProvider" IS NULL AND "secretId" IS NULL
        AND "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'issued'
        AND "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL
        AND "remoteRequestId" IS NOT NULL AND "credentialId" IS NOT NULL
        AND "certificateDer" IS NOT NULL AND "secretProvider" IS NOT NULL AND "secretId" IS NOT NULL
        AND "rejectionCode" IS NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'rejected'
        AND "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL
        AND "remoteRequestId" IS NULL AND "credentialId" IS NULL
        AND "certificateDer" IS NULL AND "secretProvider" IS NULL AND "secretId" IS NULL
        AND "rejectionCode" IS NOT NULL AND "uncertaintyReason" IS NULL
      ) OR (
        "state" = 'uncertain'
        AND "requestStartedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL
        AND "remoteRequestId" IS NULL AND "credentialId" IS NULL
        AND "certificateDer" IS NULL AND "secretProvider" IS NULL AND "secretId" IS NULL
        AND "rejectionCode" IS NULL AND "uncertaintyReason" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "zatca_csid_attempts_tenantId_operationId_key"
  ON "zatca_csid_provisioning_attempts"("tenantId", "operationId");
CREATE UNIQUE INDEX "zatca_csid_attempts_tenantId_id_key"
  ON "zatca_csid_provisioning_attempts"("tenantId", "id");
CREATE UNIQUE INDEX "zatca_csid_attempts_tenantId_credentialId_key"
  ON "zatca_csid_provisioning_attempts"("tenantId", "credentialId");
CREATE UNIQUE INDEX "zatca_csid_attempts_tenantId_remoteRequestId_key"
  ON "zatca_csid_provisioning_attempts"("tenantId", "remoteRequestId");
CREATE INDEX "zatca_csid_attempts_tenantId_terminalId_state_idx"
  ON "zatca_csid_provisioning_attempts"("tenantId", "terminalId", "state");
CREATE INDEX "zatca_csid_attempts_tenantId_state_resolvedAt_idx"
  ON "zatca_csid_provisioning_attempts"("tenantId", "state", "resolvedAt");

-- DB-level transition guard. This is intentionally stricter than a state CHECK:
-- final rows cannot be reopened, prepared cannot jump directly to a result, and
-- uncertain may only be reconciled to a definite issued/rejected result.
CREATE FUNCTION zatca_csid_provisioning_transition_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."tenantId" <> NEW."tenantId"
     OR OLD."terminalId" <> NEW."terminalId"
     OR OLD."operationId" <> NEW."operationId"
     OR OLD."requestHash" <> NEW."requestHash"
     OR OLD."environment" <> NEW."environment"
     OR OLD."keyProvider" <> NEW."keyProvider"
     OR OLD."keyId" <> NEW."keyId"
     OR OLD."keyExportable" <> NEW."keyExportable"
     OR OLD."csrSha256Hex" <> NEW."csrSha256Hex"
     OR OLD."preparedAt" <> NEW."preparedAt"
     OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'ZATCA CSID provisioning identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."state" = 'prepared' AND NEW."state" = 'in-flight')
    OR (OLD."state" = 'in-flight' AND NEW."state" IN ('issued', 'rejected', 'uncertain'))
    OR (OLD."state" = 'uncertain' AND NEW."state" IN ('issued', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'illegal ZATCA CSID provisioning state transition: % -> %', OLD."state", NEW."state"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zatca_csid_provisioning_transition_guard"
  BEFORE UPDATE ON "zatca_csid_provisioning_attempts"
  FOR EACH ROW EXECUTE FUNCTION zatca_csid_provisioning_transition_guard();

ALTER TABLE "zatca_csid_provisioning_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_csid_provisioning_attempts" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zatca_csid_provisioning_attempts_isolation" ON "zatca_csid_provisioning_attempts";
CREATE POLICY "zatca_csid_provisioning_attempts_isolation" ON "zatca_csid_provisioning_attempts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;