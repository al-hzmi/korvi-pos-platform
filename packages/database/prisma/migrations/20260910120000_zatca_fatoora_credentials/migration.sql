-- Korvi POS — Gate 39: encrypted Fatoora credential persistence.
--
-- ZATCA returns a binarySecurityToken + secret after Compliance CSID issuance.
-- Neither value may be stored in plaintext. The application encrypts the exact
-- authentication bundle with AES-256-GCM before this table is reached; this
-- table stores authenticated ciphertext and key metadata only. The encryption
-- key itself is process/secret-manager configuration and has no database column.

BEGIN;

CREATE TABLE "zatca_fatoora_credentials" (
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "credentialId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "nonce" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "authTag" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_fatoora_credentials_pkey"
    PRIMARY KEY ("tenantId", "terminalId", "credentialId"),
  CONSTRAINT "zatca_fatoora_credentials_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_fatoora_credentials_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,

  CONSTRAINT "zatca_fatoora_credential_id_bounded"
    CHECK (
      "credentialId" = btrim("credentialId")
      AND char_length("credentialId") BETWEEN 1 AND 500
      AND "credentialId" ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT "zatca_fatoora_key_id_bounded"
    CHECK ("keyId" = btrim("keyId") AND char_length("keyId") BETWEEN 1 AND 100),
  CONSTRAINT "zatca_fatoora_nonce_size"
    CHECK (octet_length("nonce") = 12),
  CONSTRAINT "zatca_fatoora_auth_tag_size"
    CHECK (octet_length("authTag") = 16),
  CONSTRAINT "zatca_fatoora_ciphertext_bounded"
    CHECK (octet_length("ciphertext") BETWEEN 1 AND 65536)
);

-- One issued certificate identity belongs to exactly one terminal inside a
-- tenant. This is the conflict target used by the idempotent reserve path.
CREATE UNIQUE INDEX "zatca_fatoora_credentials_tenantId_credentialId_key"
  ON "zatca_fatoora_credentials"("tenantId", "credentialId");
CREATE INDEX "zatca_fatoora_credentials_tenantId_terminalId_idx"
  ON "zatca_fatoora_credentials"("tenantId", "terminalId");

-- Identity columns are immutable. A future key-rotation operation may replace
-- keyId/nonce/ciphertext/authTag, but it cannot move a credential across tenant
-- or terminal boundaries or change the certificate identity it belongs to.
CREATE FUNCTION zatca_fatoora_credential_identity_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."tenantId" <> NEW."tenantId"
     OR OLD."terminalId" <> NEW."terminalId"
     OR OLD."credentialId" <> NEW."credentialId"
     OR OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'ZATCA Fatoora credential identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zatca_fatoora_credential_identity_guard"
  BEFORE UPDATE ON "zatca_fatoora_credentials"
  FOR EACH ROW EXECUTE FUNCTION zatca_fatoora_credential_identity_guard();

ALTER TABLE "zatca_fatoora_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_fatoora_credentials" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "zatca_fatoora_credentials_isolation" ON "zatca_fatoora_credentials";
CREATE POLICY "zatca_fatoora_credentials_isolation" ON "zatca_fatoora_credentials"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
