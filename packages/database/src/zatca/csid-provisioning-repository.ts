import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  ZatcaCsidProvisioningError,
  assertSameTenant,
  tenantId,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import type {
  TenantScope,
  ZatcaCsidProvisioningAttempt,
  ZatcaCsidProvisioningRepository,
  ZatcaInFlightCsidProvisioning,
  ZatcaIssuedCsidProvisioning,
  ZatcaPreparedCsidProvisioning,
  ZatcaRejectedCsidProvisioning,
  ZatcaUncertainCsidProvisioning,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

interface AttemptRow {
  id: string;
  tenantId: string;
  terminalId: string;
  operationId: string;
  requestHash: string;
  environment: 'sandbox' | 'simulation' | 'production';
  keyProvider: string;
  keyId: string;
  keyExportable: boolean;
  csrSha256Hex: string;
  state: 'prepared' | 'in-flight' | 'issued' | 'rejected' | 'uncertain';
  preparedAt: Date;
  requestStartedAt: Date | null;
  resolvedAt: Date | null;
  remoteRequestId: string | null;
  credentialId: string | null;
  certificateDer: Uint8Array | null;
  secretProvider: string | null;
  secretId: string | null;
  rejectionCode: string | null;
  uncertaintyReason: 'transport' | 'response-invalid' | 'credential-store' | null;
}

/**
 * PostgreSQL authority for the irreversible Compliance-CSID issuance boundary.
 *
 * Every method establishes tenant RLS through `withTenant`. State changes are
 * compare-and-set in SQL and are independently checked by the migration's
 * transition trigger, so a second process cannot reopen or double-finalize an
 * attempt even if it raced after reading the same prepared row.
 */
export function createZatcaCsidProvisioningRepository(
  prisma: PrismaClient,
): ZatcaCsidProvisioningRepository {
  return {
    findByOperationId: (scope, operationId) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const row = await findByOperationIdWithin(tx, scope, operationId);
        return row === null ? null : mapAttempt(scope, row);
      }),

    reservePrepared: (scope, attempt) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        assertScopeMatches(scope, attempt);
        const inserted = await tx.$queryRaw<AttemptRow[]>`
          INSERT INTO "zatca_csid_provisioning_attempts" (
            "id", "tenantId", "terminalId", "operationId", "requestHash", "environment",
            "keyProvider", "keyId", "keyExportable", "csrSha256Hex", "state",
            "preparedAt", "updatedAt"
          ) VALUES (
            ${attempt.attemptId}::uuid,
            ${scope.tenantId as string}::uuid,
            ${attempt.terminalId}::uuid,
            ${attempt.operationId},
            ${attempt.requestHash},
            ${attempt.environment},
            ${attempt.key.provider},
            ${attempt.key.keyId},
            ${attempt.key.exportable},
            ${attempt.csrSha256Hex},
            'prepared',
            ${new Date(attempt.preparedAt)},
            ${new Date(attempt.preparedAt)}
          )
          ON CONFLICT ("tenantId", "operationId") DO NOTHING
          RETURNING *`;

        const row = inserted[0] ?? (await findByOperationIdWithin(tx, scope, attempt.operationId));
        if (row === null) {
          throw new ZatcaCsidProvisioningError(
            'ZATCA CSID reservation lost its durable operation record.',
          );
        }
        assertReservedIdentity(attempt, row);
        return mapAttempt(scope, row);
      }),

    markRequestStarted: (scope, attemptId, requestStartedAt) =>
      transitionFromPrepared(prisma, scope, attemptId, requestStartedAt),

    markIssued: (scope, attemptId, result) => finalizeIssued(prisma, scope, attemptId, result),

    markRejected: (scope, attemptId, result) => finalizeRejected(prisma, scope, attemptId, result),

    markUncertain: (scope, attemptId, result) =>
      finalizeUncertain(prisma, scope, attemptId, result),
  };
}

async function transitionFromPrepared(
  prisma: PrismaClient,
  scope: TenantScope,
  attemptId: string,
  requestStartedAt: string,
): Promise<ZatcaInFlightCsidProvisioning> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<AttemptRow[]>`
      UPDATE "zatca_csid_provisioning_attempts"
         SET "state" = 'in-flight',
             "requestStartedAt" = ${new Date(requestStartedAt)},
             "updatedAt" = ${new Date(requestStartedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${attemptId}::uuid
         AND "state" = 'prepared'
      RETURNING *`;
    const row = singleTransition(rows, attemptId, 'prepared', 'in-flight');
    return expectState(mapAttempt(scope, row), 'in-flight');
  });
}

async function finalizeIssued(
  prisma: PrismaClient,
  scope: TenantScope,
  attemptId: string,
  result: {
    readonly resolvedAt: string;
    readonly remoteRequestId: string;
    readonly credentialId: string;
    readonly certificateDer: Uint8Array;
    readonly fatooraSecret: { readonly provider: string; readonly secretId: string };
  },
): Promise<ZatcaIssuedCsidProvisioning> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<AttemptRow[]>`
      UPDATE "zatca_csid_provisioning_attempts"
         SET "state" = 'issued',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "remoteRequestId" = ${result.remoteRequestId},
             "credentialId" = ${result.credentialId},
             "certificateDer" = ${Buffer.from(result.certificateDer)},
             "secretProvider" = ${result.fatooraSecret.provider},
             "secretId" = ${result.fatooraSecret.secretId},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${attemptId}::uuid
         AND "state" IN ('in-flight', 'uncertain')
      RETURNING *`;
    const row = singleTransition(rows, attemptId, 'in-flight/uncertain', 'issued');
    return expectState(mapAttempt(scope, row), 'issued');
  });
}

async function finalizeRejected(
  prisma: PrismaClient,
  scope: TenantScope,
  attemptId: string,
  result: { readonly resolvedAt: string; readonly rejectionCode: string },
): Promise<ZatcaRejectedCsidProvisioning> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<AttemptRow[]>`
      UPDATE "zatca_csid_provisioning_attempts"
         SET "state" = 'rejected',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "rejectionCode" = ${result.rejectionCode},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${attemptId}::uuid
         AND "state" IN ('in-flight', 'uncertain')
      RETURNING *`;
    const row = singleTransition(rows, attemptId, 'in-flight/uncertain', 'rejected');
    return expectState(mapAttempt(scope, row), 'rejected');
  });
}

async function finalizeUncertain(
  prisma: PrismaClient,
  scope: TenantScope,
  attemptId: string,
  result: {
    readonly resolvedAt: string;
    readonly uncertaintyReason: ZatcaUncertainCsidProvisioning['uncertaintyReason'];
  },
): Promise<ZatcaUncertainCsidProvisioning> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<AttemptRow[]>`
      UPDATE "zatca_csid_provisioning_attempts"
         SET "state" = 'uncertain',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "uncertaintyReason" = ${result.uncertaintyReason},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${attemptId}::uuid
         AND "state" = 'in-flight'
      RETURNING *`;
    const row = singleTransition(rows, attemptId, 'in-flight', 'uncertain');
    return expectState(mapAttempt(scope, row), 'uncertain');
  });
}

async function findByOperationIdWithin(
  tx: TransactionClient,
  scope: TenantScope,
  operationId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.$queryRaw<AttemptRow[]>`
    SELECT *
      FROM "zatca_csid_provisioning_attempts"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "operationId" = ${operationId}
     LIMIT 1`;
  const row = rows[0] ?? null;
  if (row !== null) {
    assertSameTenant(scope, row.tenantId);
  }
  return row;
}

function singleTransition(
  rows: readonly AttemptRow[],
  attemptId: string,
  expected: string,
  target: string,
): AttemptRow {
  const row = rows[0];
  if (row === undefined) {
    throw new ZatcaCsidProvisioningError(
      `ZATCA CSID attempt ${attemptId} did not transition ${expected} -> ${target}; concurrent or stale state refused.`,
    );
  }
  if (rows.length !== 1) {
    throw new ZatcaCsidProvisioningError('ZATCA CSID transition affected more than one row.');
  }
  return row;
}

function assertScopeMatches(scope: TenantScope, attempt: ZatcaPreparedCsidProvisioning): void {
  if (attempt.scope.tenantId !== scope.tenantId) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSID attempt tenant does not match repository tenant scope.',
    );
  }
}

function assertReservedIdentity(attempt: ZatcaPreparedCsidProvisioning, row: AttemptRow): void {
  const same =
    row.id === attempt.attemptId &&
    row.tenantId === (attempt.scope.tenantId as string) &&
    row.terminalId === attempt.terminalId &&
    row.operationId === attempt.operationId &&
    row.requestHash === attempt.requestHash &&
    row.environment === attempt.environment &&
    row.keyProvider === attempt.key.provider &&
    row.keyId === attempt.key.keyId &&
    row.keyExportable === false &&
    row.csrSha256Hex === attempt.csrSha256Hex &&
    toUtcSecond(row.preparedAt) === attempt.preparedAt;
  if (!same) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSID operation already exists with different durable request identity.',
    );
  }
}

function mapAttempt(scope: TenantScope, row: AttemptRow): ZatcaCsidProvisioningAttempt {
  assertSameTenant(scope, row.tenantId);
  const base = {
    attemptId: row.id,
    scope: { tenantId: tenantId(row.tenantId) },
    terminalId: row.terminalId,
    operationId: row.operationId,
    requestHash: row.requestHash,
    environment: row.environment,
    key: {
      provider: row.keyProvider,
      keyId: row.keyId,
      curve: ZATCA_SIGNING_CURVE,
      algorithm: ZATCA_SIGNING_ALGORITHM,
      exportable: false as const,
    },
    csrSha256Hex: row.csrSha256Hex,
    preparedAt: toUtcSecond(row.preparedAt),
  };

  if (row.state === 'prepared') {
    return { ...base, state: 'prepared' };
  }
  if (row.requestStartedAt === null) {
    throw corrupt('requestStartedAt');
  }
  const requestStartedAt = toUtcSecond(row.requestStartedAt);
  if (row.state === 'in-flight') {
    return { ...base, state: 'in-flight', requestStartedAt };
  }
  if (row.resolvedAt === null) {
    throw corrupt('resolvedAt');
  }
  const resolvedAt = toUtcSecond(row.resolvedAt);
  if (row.state === 'issued') {
    if (
      row.remoteRequestId === null ||
      row.credentialId === null ||
      row.certificateDer === null ||
      row.secretProvider === null ||
      row.secretId === null
    ) {
      throw corrupt('issued credential evidence');
    }
    return {
      ...base,
      state: 'issued',
      requestStartedAt,
      resolvedAt,
      remoteRequestId: row.remoteRequestId,
      credentialId: row.credentialId,
      certificateDer: Uint8Array.from(row.certificateDer),
      fatooraSecret: { provider: row.secretProvider, secretId: row.secretId },
    };
  }
  if (row.state === 'rejected') {
    if (row.rejectionCode === null) {
      throw corrupt('rejectionCode');
    }
    return {
      ...base,
      state: 'rejected',
      requestStartedAt,
      resolvedAt,
      rejectionCode: row.rejectionCode,
    };
  }
  if (row.uncertaintyReason === null) {
    throw corrupt('uncertaintyReason');
  }
  return {
    ...base,
    state: 'uncertain',
    requestStartedAt,
    resolvedAt,
    uncertaintyReason: row.uncertaintyReason,
  };
}

function expectState<S extends ZatcaCsidProvisioningAttempt['state']>(
  attempt: ZatcaCsidProvisioningAttempt,
  state: S,
): Extract<ZatcaCsidProvisioningAttempt, { state: S }> {
  if (attempt.state !== state) {
    throw new ZatcaCsidProvisioningError(
      `ZATCA CSID repository returned ${attempt.state}; expected ${state}.`,
    );
  }
  return attempt as Extract<ZatcaCsidProvisioningAttempt, { state: S }>;
}

function toUtcSecond(value: Date): string {
  const iso = value.toISOString();
  if (!iso.endsWith('.000Z')) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSID persisted timestamp is not an exact UTC second.',
    );
  }
  return iso.replace('.000Z', 'Z');
}

function corrupt(field: string): ZatcaCsidProvisioningError {
  return new ZatcaCsidProvisioningError(`ZATCA CSID persisted ${field} contradicts its state.`);
}
