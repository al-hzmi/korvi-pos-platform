-- Korvi POS — P0 Migration Engine durable job/row provenance.
-- Parsed rows are untrusted onboarding input. These tables are orchestration
-- evidence only; controlled commit reuses the existing domain writers.

BEGIN;

CREATE TABLE "migration_import_jobs" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "sourceFileName" TEXT,
  "sourceSystem" TEXT,
  "sourceSha256" CHAR(64) NOT NULL,
  "createOperationId" UUID NOT NULL,
  "createRequestHash" CHAR(64) NOT NULL,
  "commitOperationId" UUID,
  "status" TEXT NOT NULL DEFAULT 'reviewed',
  "mappingVersion" INTEGER NOT NULL DEFAULT 1,
  "mapping" JSONB NOT NULL,
  "conflictPolicy" TEXT NOT NULL DEFAULT 'reject',
  "totalRows" INTEGER NOT NULL,
  "validRows" INTEGER NOT NULL,
  "warningRows" INTEGER NOT NULL,
  "errorRows" INTEGER NOT NULL,
  "blockedRows" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "dryRunAt" TIMESTAMPTZ,
  "commitAt" TIMESTAMPTZ,
  CONSTRAINT "migration_import_jobs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "migration_import_jobs_tenantId_actorUserId_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "migration_import_jobs_mapping_version_positive" CHECK ("mappingVersion" > 0),
  CONSTRAINT "migration_import_jobs_counts_nonnegative"
    CHECK (
      "totalRows" >= 0 AND "validRows" >= 0 AND "warningRows" >= 0
      AND "errorRows" >= 0 AND "blockedRows" >= 0
      AND "validRows" + "warningRows" + "errorRows" + "blockedRows" = "totalRows"
    ),
  CONSTRAINT "migration_import_jobs_source_sha256_hex"
    CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "migration_import_jobs_request_hash_hex"
    CHECK ("createRequestHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "migration_import_jobs_tenantId_id_key"
  ON "migration_import_jobs"("tenantId", "id");
CREATE UNIQUE INDEX "migration_import_jobs_tenantId_createOperationId_key"
  ON "migration_import_jobs"("tenantId", "createOperationId");
CREATE UNIQUE INDEX "migration_import_jobs_tenantId_commitOperationId_key"
  ON "migration_import_jobs"("tenantId", "commitOperationId");
CREATE INDEX "migration_import_jobs_tenantId_status_createdAt_idx"
  ON "migration_import_jobs"("tenantId", "status", "createdAt");
CREATE INDEX "migration_import_jobs_tenantId_actorUserId_createdAt_idx"
  ON "migration_import_jobs"("tenantId", "actorUserId", "createdAt");

CREATE TABLE "migration_import_rows" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "sourceRow" INTEGER NOT NULL,
  "rowFingerprint" CHAR(64) NOT NULL,
  "sourceIdentifier" TEXT,
  "sourceData" JSONB,
  "canonicalData" JSONB,
  "issues" JSONB NOT NULL,
  "classification" TEXT NOT NULL,
  "plannedAction" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "targetEntityId" UUID,
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "migration_import_rows_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "migration_import_rows_tenantId_jobId_fkey"
    FOREIGN KEY ("tenantId", "jobId") REFERENCES "migration_import_jobs"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "migration_import_rows_source_row_positive" CHECK ("sourceRow" > 1),
  CONSTRAINT "migration_import_rows_fingerprint_hex"
    CHECK ("rowFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "migration_import_rows_tenantId_id_key"
  ON "migration_import_rows"("tenantId", "id");
CREATE UNIQUE INDEX "migration_import_rows_tenantId_jobId_sourceRow_key"
  ON "migration_import_rows"("tenantId", "jobId", "sourceRow");
CREATE INDEX "migration_import_rows_tenantId_jobId_status_sourceRow_idx"
  ON "migration_import_rows"("tenantId", "jobId", "status", "sourceRow");
CREATE INDEX "migration_import_rows_tenantId_jobId_rowFingerprint_idx"
  ON "migration_import_rows"("tenantId", "jobId", "rowFingerprint");

ALTER TABLE "migration_import_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "migration_import_jobs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "migration_import_jobs_isolation" ON "migration_import_jobs";
CREATE POLICY "migration_import_jobs_isolation" ON "migration_import_jobs"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "migration_import_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "migration_import_rows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "migration_import_rows_isolation" ON "migration_import_rows";
CREATE POLICY "migration_import_rows_isolation" ON "migration_import_rows"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
