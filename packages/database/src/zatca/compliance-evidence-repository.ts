import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  ZatcaComplianceEvidenceError,
  assertSameTenant,
  assertZatcaAcceptedComplianceEvidence,
  assertZatcaComplianceEvidenceRecordInput,
  tenantId,
  type RecordZatcaAcceptedComplianceEvidenceInput,
  type TenantScope,
  type ZatcaAcceptedComplianceEvidence,
  type ZatcaComplianceEvidenceRepository,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import { withTenant, type TransactionClient } from '../tenant-context.js';

interface EvidenceRow {
  id: string;
  tenantId: string;
  terminalId: string;
  complianceAttemptId: string;
  checkSetHash: string;
  acceptedAt: Date;
  environment: 'sandbox' | 'simulation' | 'production';
  remoteRequestId: string | null;
  credentialId: string | null;
  secretProvider: string | null;
  secretId: string | null;
  keyProvider: string;
  keyId: string;
  keyExportable: boolean;
  attemptState: string;
}

export function createZatcaComplianceEvidenceRepository(
  prisma: PrismaClient,
): ZatcaComplianceEvidenceRepository {
  return {
    findById: (scope, evidenceId) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const row = await findByIdWithin(tx, scope, evidenceId);
        return row === null ? null : mapEvidence(scope, row);
      }),

    recordAccepted: (scope, input) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        assertZatcaComplianceEvidenceRecordInput(input);
        const acceptedAt = new Date(input.acceptedAt);
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "zatca_compliance_evidence" (
            "id", "tenantId", "terminalId", "complianceAttemptId", "checkSetHash", "acceptedAt"
          )
          SELECT
            ${input.evidenceId}::uuid,
            ${scope.tenantId as string}::uuid,
            ${input.terminalId}::uuid,
            ${input.complianceAttemptId}::uuid,
            ${input.checkSetHash},
            ${acceptedAt}
          FROM "zatca_csid_provisioning_attempts" AS attempt
          WHERE attempt."tenantId" = ${scope.tenantId as string}::uuid
            AND attempt."id" = ${input.complianceAttemptId}::uuid
            AND attempt."terminalId" = ${input.terminalId}::uuid
            AND attempt."state" = 'issued'
            AND attempt."resolvedAt" IS NOT NULL
            AND attempt."resolvedAt" <= ${acceptedAt}
          ON CONFLICT ("tenantId", "complianceAttemptId") DO NOTHING
          RETURNING "id"`;

        const row =
          inserted.length === 1
            ? await findByIdWithin(tx, scope, input.evidenceId)
            : await findByComplianceAttemptWithin(tx, scope, input.complianceAttemptId);
        if (row === null) {
          throw new ZatcaComplianceEvidenceError(
            'ZATCA compliance evidence requires an issued same-terminal Compliance CSID.',
          );
        }
        assertReplay(input, row);
        return mapEvidence(scope, row);
      }),
  };
}

async function findByIdWithin(
  tx: TransactionClient,
  scope: TenantScope,
  evidenceId: string,
): Promise<EvidenceRow | null> {
  const rows = await tx.$queryRaw<EvidenceRow[]>`
    SELECT evidence."id",
           evidence."tenantId",
           evidence."terminalId",
           evidence."complianceAttemptId",
           evidence."checkSetHash",
           evidence."acceptedAt",
           attempt."environment",
           attempt."remoteRequestId",
           attempt."credentialId",
           attempt."secretProvider",
           attempt."secretId",
           attempt."keyProvider",
           attempt."keyId",
           attempt."keyExportable",
           attempt."state" AS "attemptState"
      FROM "zatca_compliance_evidence" AS evidence
      JOIN "zatca_csid_provisioning_attempts" AS attempt
        ON attempt."tenantId" = evidence."tenantId"
       AND attempt."id" = evidence."complianceAttemptId"
     WHERE evidence."tenantId" = ${scope.tenantId as string}::uuid
       AND evidence."id" = ${evidenceId}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

async function findByComplianceAttemptWithin(
  tx: TransactionClient,
  scope: TenantScope,
  attemptId: string,
): Promise<EvidenceRow | null> {
  const rows = await tx.$queryRaw<EvidenceRow[]>`
    SELECT evidence."id",
           evidence."tenantId",
           evidence."terminalId",
           evidence."complianceAttemptId",
           evidence."checkSetHash",
           evidence."acceptedAt",
           attempt."environment",
           attempt."remoteRequestId",
           attempt."credentialId",
           attempt."secretProvider",
           attempt."secretId",
           attempt."keyProvider",
           attempt."keyId",
           attempt."keyExportable",
           attempt."state" AS "attemptState"
      FROM "zatca_compliance_evidence" AS evidence
      JOIN "zatca_csid_provisioning_attempts" AS attempt
        ON attempt."tenantId" = evidence."tenantId"
       AND attempt."id" = evidence."complianceAttemptId"
     WHERE evidence."tenantId" = ${scope.tenantId as string}::uuid
       AND evidence."complianceAttemptId" = ${attemptId}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

function assertReplay(input: RecordZatcaAcceptedComplianceEvidenceInput, row: EvidenceRow): void {
  if (
    row.id !== input.evidenceId ||
    row.terminalId !== input.terminalId ||
    row.complianceAttemptId !== input.complianceAttemptId ||
    row.checkSetHash !== input.checkSetHash ||
    toUtcSecond(row.acceptedAt) !== input.acceptedAt
  ) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA Compliance CSID already has different accepted compliance evidence.',
    );
  }
}

function mapEvidence(scope: TenantScope, row: EvidenceRow): ZatcaAcceptedComplianceEvidence {
  assertSameTenant(scope, row.tenantId);
  if (
    row.attemptState !== 'issued' ||
    row.remoteRequestId === null ||
    row.credentialId === null ||
    row.secretProvider === null ||
    row.secretId === null ||
    row.keyExportable !== false
  ) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA persisted compliance evidence is not backed by a complete issued Compliance CSID.',
    );
  }
  const evidence: ZatcaAcceptedComplianceEvidence = {
    evidenceId: row.id,
    scope: { tenantId: tenantId(row.tenantId) },
    terminalId: row.terminalId,
    complianceAttemptId: row.complianceAttemptId,
    environment: row.environment,
    complianceRequestId: row.remoteRequestId,
    currentComplianceCredentialId: row.credentialId,
    currentComplianceSecret: { provider: row.secretProvider, secretId: row.secretId },
    key: {
      provider: row.keyProvider,
      keyId: row.keyId,
      curve: ZATCA_SIGNING_CURVE,
      algorithm: ZATCA_SIGNING_ALGORITHM,
      exportable: false,
    },
    checkSetHash: row.checkSetHash,
    acceptedAt: toUtcSecond(row.acceptedAt),
  };
  assertZatcaAcceptedComplianceEvidence(evidence);
  return evidence;
}

function toUtcSecond(value: Date): string {
  const iso = value.toISOString();
  if (!iso.endsWith('.000Z')) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA compliance evidence timestamp is not an exact UTC second.',
    );
  }
  return iso.replace('.000Z', 'Z');
}
