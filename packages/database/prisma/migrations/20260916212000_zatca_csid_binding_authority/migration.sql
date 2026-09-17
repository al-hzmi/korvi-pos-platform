-- Korvi POS — durable active Production-CSID stamping authority.
--
-- Invoice callers must never choose a CSID, signing-key handle or Fatoora
-- secret. This table is the tenant/terminal authority resolved by the sealer.
-- Every inserted binding must prove provenance from an issued durable ZATCA
-- provisioning attempt for the same tenant, terminal, credential, key, leaf
-- certificate and opaque Fatoora-secret handle.

BEGIN;

CREATE TABLE "zatca_csid_bindings" (
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "credentialId" TEXT NOT NULL,
  "sourceAttemptId" UUID NOT NULL,

  "state" TEXT NOT NULL,
  "keyProvider" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "keyExportable" BOOLEAN NOT NULL,

  -- Public certificate/status material only. DER values inside certificatePath
  -- are base64-encoded; no private key or raw Fatoora secret is stored here.
  "certificatePath" JSONB NOT NULL,
  "certificateStatus" JSONB NOT NULL,
  "signingPublicKeySpkiDer" BYTEA NOT NULL,
  "notBefore" TIMESTAMP(3) NOT NULL,
  "notAfter" TIMESTAMP(3) NOT NULL,
  "secretProvider" TEXT NOT NULL,
  "secretId" TEXT NOT NULL,

  "activatedAt" TIMESTAMP(3) NOT NULL,
  "supersededAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_csid_bindings_pkey" PRIMARY KEY ("tenantId", "credentialId"),
  CONSTRAINT "zatca_csid_bindings_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_csid_bindings_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_csid_bindings_tenantId_sourceAttemptId_fkey"
    FOREIGN KEY ("tenantId", "sourceAttemptId")
    REFERENCES "zatca_csid_provisioning_attempts"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "zatca_csid_bindings_credential_bounded"
    CHECK ("credentialId" = btrim("credentialId") AND char_length("credentialId") BETWEEN 1 AND 500),
  CONSTRAINT "zatca_csid_bindings_state_check"
    CHECK ("state" IN ('active', 'superseded', 'revoked')),
  CONSTRAINT "zatca_csid_bindings_key_provider_bounded"
    CHECK ("keyProvider" = btrim("keyProvider") AND char_length("keyProvider") BETWEEN 1 AND 100),
  CONSTRAINT "zatca_csid_bindings_key_id_bounded"
    CHECK ("keyId" = btrim("keyId") AND char_length("keyId") BETWEEN 1 AND 500),
  CONSTRAINT "zatca_csid_bindings_key_non_exportable"
    CHECK ("keyExportable" = FALSE),
  CONSTRAINT "zatca_csid_bindings_spki_bounded"
    CHECK (octet_length("signingPublicKeySpkiDer") BETWEEN 1 AND 2048),
  CONSTRAINT "zatca_csid_bindings_secret_provider_bounded"
    CHECK ("secretProvider" = btrim("secretProvider") AND char_length("secretProvider") BETWEEN 1 AND 100),
  CONSTRAINT "zatca_csid_bindings_secret_id_bounded"
    CHECK ("secretId" = btrim("secretId") AND char_length("secretId") BETWEEN 1 AND 1000),
  CONSTRAINT "zatca_csid_bindings_certificate_window"
    CHECK ("notBefore" < "notAfter"),
  CONSTRAINT "zatca_csid_bindings_exact_second_times"
    CHECK (
      date_trunc('second', "notBefore") = "notBefore" AND
      date_trunc('second', "notAfter") = "notAfter" AND
      date_trunc('second', "activatedAt") = "activatedAt" AND
      ("supersededAt" IS NULL OR date_trunc('second', "supersededAt") = "supersededAt") AND
      ("revokedAt" IS NULL OR date_trunc('second', "revokedAt") = "revokedAt")
    ),
  CONSTRAINT "zatca_csid_bindings_state_shape"
    CHECK (
      ("state" = 'active' AND "supersededAt" IS NULL AND "revokedAt" IS NULL) OR
      ("state" = 'superseded' AND "supersededAt" IS NOT NULL AND "revokedAt" IS NULL AND "supersededAt" >= "activatedAt") OR
      ("state" = 'revoked' AND "revokedAt" IS NOT NULL AND "supersededAt" IS NULL AND "revokedAt" >= "activatedAt")
    ),
  CONSTRAINT "zatca_csid_bindings_path_array"
    CHECK (jsonb_typeof("certificatePath") = 'array' AND jsonb_array_length("certificatePath") >= 2),
  CONSTRAINT "zatca_csid_bindings_status_array"
    CHECK (
      jsonb_typeof("certificateStatus") = 'array' AND
      jsonb_array_length("certificateStatus") = jsonb_array_length("certificatePath") - 1
    )
);

CREATE UNIQUE INDEX "zatca_csid_bindings_tenantId_sourceAttemptId_key"
  ON "zatca_csid_bindings"("tenantId", "sourceAttemptId");
CREATE UNIQUE INDEX "zatca_csid_bindings_one_active_per_terminal_key"
  ON "zatca_csid_bindings"("tenantId", "terminalId")
  WHERE "state" = 'active';
CREATE INDEX "zatca_csid_bindings_tenantId_terminalId_state_idx"
  ON "zatca_csid_bindings"("tenantId", "terminalId", "state");

ALTER TABLE "zatca_csid_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_csid_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "zatca_csid_bindings_isolation" ON "zatca_csid_bindings";
CREATE POLICY "zatca_csid_bindings_isolation" ON "zatca_csid_bindings"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

CREATE FUNCTION guard_zatca_csid_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  issued_attempt "zatca_csid_provisioning_attempts"%ROWTYPE;
  path_entry JSONB;
  status_entry JSONB;
  decoded_bytes BYTEA;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA CSID binding history cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
       OLD."terminalId" IS DISTINCT FROM NEW."terminalId" OR
       OLD."credentialId" IS DISTINCT FROM NEW."credentialId" OR
       OLD."sourceAttemptId" IS DISTINCT FROM NEW."sourceAttemptId" OR
       OLD."keyProvider" IS DISTINCT FROM NEW."keyProvider" OR
       OLD."keyId" IS DISTINCT FROM NEW."keyId" OR
       OLD."keyExportable" IS DISTINCT FROM NEW."keyExportable" OR
       OLD."certificatePath" IS DISTINCT FROM NEW."certificatePath" OR
       OLD."certificateStatus" IS DISTINCT FROM NEW."certificateStatus" OR
       OLD."signingPublicKeySpkiDer" IS DISTINCT FROM NEW."signingPublicKeySpkiDer" OR
       OLD."notBefore" IS DISTINCT FROM NEW."notBefore" OR
       OLD."notAfter" IS DISTINCT FROM NEW."notAfter" OR
       OLD."secretProvider" IS DISTINCT FROM NEW."secretProvider" OR
       OLD."secretId" IS DISTINCT FROM NEW."secretId" OR
       OLD."activatedAt" IS DISTINCT FROM NEW."activatedAt" OR
       OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'ZATCA CSID binding identity and evidence are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NOT (OLD."state" = 'active' AND NEW."state" IN ('superseded', 'revoked')) THEN
      RAISE EXCEPTION 'illegal ZATCA CSID binding state transition: % -> %', OLD."state", NEW."state"
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."state" <> 'active' OR NEW."supersededAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'new ZATCA CSID binding must start active'
      USING ERRCODE = '23514';
  END IF;

  -- Validate every persisted public path object so malformed JSON cannot become
  -- stamping authority through raw SQL. Base64 decode also rejects bad DER text.
  FOR path_entry IN SELECT value FROM jsonb_array_elements(NEW."certificatePath") LOOP
    IF jsonb_typeof(path_entry) <> 'object' OR
       jsonb_typeof(path_entry->'certificateDerBase64') <> 'string' OR
       jsonb_typeof(path_entry->'issuerName') <> 'string' OR
       jsonb_typeof(path_entry->'serialNumber') <> 'string' OR
       char_length(btrim(path_entry->>'issuerName')) < 1 OR
       (path_entry->>'serialNumber') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'malformed ZATCA CSID certificate path evidence'
        USING ERRCODE = '23514';
    END IF;
    decoded_bytes := decode(path_entry->>'certificateDerBase64', 'base64');
    IF octet_length(decoded_bytes) NOT BETWEEN 1 AND 16384 THEN
      RAISE EXCEPTION 'ZATCA CSID certificate DER is outside storage bounds'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR status_entry IN SELECT value FROM jsonb_array_elements(NEW."certificateStatus") LOOP
    IF jsonb_typeof(status_entry) <> 'object' OR
       jsonb_typeof(status_entry->'certificateSha256') <> 'string' OR
       jsonb_typeof(status_entry->'status') <> 'string' OR
       jsonb_typeof(status_entry->'source') <> 'string' OR
       jsonb_typeof(status_entry->'checkedAt') <> 'string' OR
       jsonb_typeof(status_entry->'validUntil') <> 'string' OR
       (status_entry->>'status') NOT IN ('good', 'revoked', 'unknown') OR
       (status_entry->>'source') NOT IN ('crl', 'ocsp') THEN
      RAISE EXCEPTION 'malformed ZATCA CSID certificate-status evidence'
        USING ERRCODE = '23514';
    END IF;
    decoded_bytes := decode(status_entry->>'certificateSha256', 'base64');
    IF octet_length(decoded_bytes) <> 32 THEN
      RAISE EXCEPTION 'ZATCA CSID certificate-status fingerprint must be SHA-256'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT * INTO issued_attempt
    FROM "zatca_csid_provisioning_attempts"
   WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."sourceAttemptId";

  IF NOT FOUND OR issued_attempt."state" <> 'issued' THEN
    RAISE EXCEPTION 'ZATCA CSID binding lacks an issued provisioning authority record'
      USING ERRCODE = '23514';
  END IF;

  IF issued_attempt."terminalId" IS DISTINCT FROM NEW."terminalId" OR
     issued_attempt."credentialId" IS DISTINCT FROM NEW."credentialId" OR
     issued_attempt."keyProvider" IS DISTINCT FROM NEW."keyProvider" OR
     issued_attempt."keyId" IS DISTINCT FROM NEW."keyId" OR
     issued_attempt."keyExportable" IS DISTINCT FROM NEW."keyExportable" OR
     issued_attempt."secretProvider" IS DISTINCT FROM NEW."secretProvider" OR
     issued_attempt."secretId" IS DISTINCT FROM NEW."secretId" THEN
    RAISE EXCEPTION 'ZATCA CSID binding contradicts its issued provisioning authority record'
      USING ERRCODE = '23514';
  END IF;

  decoded_bytes := decode(NEW."certificatePath"->0->>'certificateDerBase64', 'base64');
  IF issued_attempt."certificateDer" IS NULL OR issued_attempt."certificateDer" <> decoded_bytes THEN
    RAISE EXCEPTION 'ZATCA CSID signing certificate differs from issued provisioning evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "zatca_csid_binding_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "zatca_csid_bindings"
FOR EACH ROW EXECUTE FUNCTION guard_zatca_csid_binding();

COMMIT;
