-- Korvi POS — Gate 39: immutable accepted ZATCA compliance-check evidence.
--
-- Production CSID onboarding is not authorized by a request id supplied by an
-- API caller. Evidence references an already-issued Compliance CSID; request
-- id, credential, environment and signing key stay derived from that attempt.
-- No Fatoora plaintext exists in this table.

BEGIN;

CREATE TABLE "zatca_compliance_evidence" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "complianceAttemptId" UUID NOT NULL,
  "checkSetHash" CHAR(64) NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "zatca_compliance_evidence_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_compliance_evidence_tenantId_terminalId_fkey"
    FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_compliance_evidence_attempt_fkey"
    FOREIGN KEY ("tenantId", "complianceAttemptId")
    REFERENCES "zatca_csid_provisioning_attempts"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_compliance_evidence_check_hash"
    CHECK ("checkSetHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "zatca_compliance_evidence_exact_second"
    CHECK (date_trunc('second', "acceptedAt") = "acceptedAt")
);

CREATE UNIQUE INDEX "zatca_compliance_evidence_tenantId_id_key"
  ON "zatca_compliance_evidence"("tenantId", "id");
CREATE UNIQUE INDEX "zatca_compliance_evidence_tenantId_attempt_key"
  ON "zatca_compliance_evidence"("tenantId", "complianceAttemptId");
CREATE INDEX "zatca_compliance_evidence_tenantId_terminalId_acceptedAt_idx"
  ON "zatca_compliance_evidence"("tenantId", "terminalId", "acceptedAt");

CREATE FUNCTION zatca_compliance_evidence_guard() RETURNS trigger AS $$
DECLARE
  source_terminal UUID;
  source_state TEXT;
  source_resolved_at TIMESTAMP(3);
BEGIN
  SELECT attempt."terminalId", attempt."state", attempt."resolvedAt"
    INTO source_terminal, source_state, source_resolved_at
    FROM "zatca_csid_provisioning_attempts" AS attempt
   WHERE attempt."tenantId" = NEW."tenantId"
     AND attempt."id" = NEW."complianceAttemptId";

  IF NOT FOUND OR source_state <> 'issued' OR source_resolved_at IS NULL THEN
    RAISE EXCEPTION 'ZATCA compliance evidence requires an issued Compliance CSID'
      USING ERRCODE = '23514';
  END IF;
  IF source_terminal <> NEW."terminalId" THEN
    RAISE EXCEPTION 'ZATCA compliance evidence terminal does not match Compliance CSID'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" < source_resolved_at THEN
    RAISE EXCEPTION 'ZATCA compliance evidence cannot precede Compliance CSID issuance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zatca_compliance_evidence_guard"
  BEFORE INSERT ON "zatca_compliance_evidence"
  FOR EACH ROW EXECUTE FUNCTION zatca_compliance_evidence_guard();

CREATE FUNCTION zatca_compliance_evidence_immutable_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ZATCA accepted compliance evidence is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zatca_compliance_evidence_immutable_guard"
  BEFORE UPDATE OR DELETE ON "zatca_compliance_evidence"
  FOR EACH ROW EXECUTE FUNCTION zatca_compliance_evidence_immutable_guard();

ALTER TABLE "zatca_compliance_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_compliance_evidence" FORCE ROW LEVEL SECURITY;

CREATE POLICY "zatca_compliance_evidence_isolation" ON "zatca_compliance_evidence"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
