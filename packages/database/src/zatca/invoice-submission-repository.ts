import {
  ZatcaInvoiceSubmissionError,
  assertSameTenant,
  assertZatcaInvoiceSubmissionReplay,
  tenantId,
  type TenantScope,
  type ZatcaAcceptedDurableInvoiceSubmission,
  type ZatcaDurableInvoiceSubmission,
  type ZatcaInvoiceSubmissionMode,
  type ZatcaInvoiceSubmissionRepository,
  type ZatcaInvoiceSubmissionUncertaintyReason,
  type ZatcaInFlightInvoiceSubmission,
  type ZatcaPendingInvoiceSubmission,
  type ZatcaRejectedDurableInvoiceSubmission,
  type ZatcaUncertainDurableInvoiceSubmission,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import { withTenant, type TransactionClient } from '../tenant-context.js';

interface SubmissionRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  terminalId: string;
  environment: 'sandbox' | 'simulation' | 'production';
  mode: ZatcaInvoiceSubmissionMode;
  invoiceUuid: string;
  invoiceHash: Uint8Array;
  sealedInvoiceXml: Uint8Array;
  secretProvider: string;
  secretId: string;
  state: 'pending' | 'in-flight' | 'accepted' | 'rejected' | 'uncertain';
  attemptCount: number;
  queuedAt: Date;
  requestStartedAt: Date | null;
  resolvedAt: Date | null;
  httpStatus: number | null;
  authorityStatus: 'REPORTED' | 'CLEARED' | null;
  rejectionCode: string | null;
  uncertaintyReason: ZatcaInvoiceSubmissionUncertaintyReason | null;
  clearedInvoiceXml: Uint8Array | null;
}

export function createZatcaInvoiceSubmissionRepository(
  prisma: PrismaClient,
): ZatcaInvoiceSubmissionRepository {
  return {
    findByInvoice: (scope, invoiceId, mode) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const row = await findByInvoiceWithin(tx, scope, invoiceId, mode);
        return row === null ? null : mapSubmission(scope, row);
      }),

    reservePending: (scope, submission) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        assertScopeMatches(scope, submission);
        const inserted = await tx.$queryRaw<SubmissionRow[]>`
          INSERT INTO "zatca_invoice_submissions" (
            "id", "tenantId", "invoiceId", "terminalId", "environment", "mode",
            "invoiceUuid", "invoiceHash", "sealedInvoiceXml", "secretProvider", "secretId",
            "state", "attemptCount", "queuedAt", "updatedAt"
          ) VALUES (
            ${submission.submissionId}::uuid,
            ${scope.tenantId as string}::uuid,
            ${submission.invoiceId}::uuid,
            ${submission.terminalId}::uuid,
            ${submission.environment},
            ${submission.mode},
            ${submission.invoiceUuid}::uuid,
            ${Buffer.from(submission.invoiceHash)},
            ${Buffer.from(submission.sealedInvoiceXml)},
            ${submission.productionSecret.provider},
            ${submission.productionSecret.secretId},
            'pending', 0,
            ${new Date(submission.queuedAt)},
            ${new Date(submission.queuedAt)}
          )
          ON CONFLICT ("tenantId", "invoiceId", "mode") DO NOTHING
          RETURNING *`;
        const row =
          inserted[0] ??
          (await findByInvoiceWithin(tx, scope, submission.invoiceId, submission.mode));
        if (row === null) {
          throw new ZatcaInvoiceSubmissionError(
            'ZATCA submission reservation lost its durable row.',
          );
        }
        const durable = mapSubmission(scope, row);
        // Reservation identity is the immutable business request, not the
        // caller's locally generated row id or queue timestamp. Concurrent
        // callers must converge on the first durable winner instead of turning
        // a harmless retry into a conflict.
        assertZatcaInvoiceSubmissionReplay(durable, submission);
        return durable;
      }),

    markRequestStarted: (scope, submissionId, requestStartedAt) =>
      transitionRequestStarted(prisma, scope, submissionId, requestStartedAt),

    markAccepted: (scope, submissionId, result) =>
      finalizeAccepted(prisma, scope, submissionId, result),

    markRejected: (scope, submissionId, result) =>
      finalizeRejected(prisma, scope, submissionId, result),

    markUncertain: (scope, submissionId, result) =>
      finalizeUncertain(prisma, scope, submissionId, result),
  };
}

async function transitionRequestStarted(
  prisma: PrismaClient,
  scope: TenantScope,
  submissionId: string,
  requestStartedAt: string,
): Promise<ZatcaInFlightInvoiceSubmission> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<SubmissionRow[]>`
      UPDATE "zatca_invoice_submissions"
         SET "state" = 'in-flight',
             "attemptCount" = 1,
             "requestStartedAt" = ${new Date(requestStartedAt)},
             "updatedAt" = ${new Date(requestStartedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${submissionId}::uuid
         AND "state" = 'pending'
         AND "attemptCount" = 0
      RETURNING *`;
    return expectState(
      mapSubmission(scope, singleTransition(rows, submissionId, 'pending', 'in-flight')),
      'in-flight',
    );
  });
}

async function finalizeAccepted(
  prisma: PrismaClient,
  scope: TenantScope,
  submissionId: string,
  result: {
    readonly resolvedAt: string;
    readonly httpStatus: number;
    readonly authorityStatus: 'REPORTED' | 'CLEARED';
    readonly clearedInvoiceXml?: Uint8Array;
  },
): Promise<ZatcaAcceptedDurableInvoiceSubmission> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const cleared =
      result.clearedInvoiceXml === undefined ? null : Buffer.from(result.clearedInvoiceXml);
    const rows = await tx.$queryRaw<SubmissionRow[]>`
      UPDATE "zatca_invoice_submissions"
         SET "state" = 'accepted',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "httpStatus" = ${result.httpStatus},
             "authorityStatus" = ${result.authorityStatus},
             "clearedInvoiceXml" = ${cleared},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${submissionId}::uuid
         AND "state" IN ('in-flight', 'uncertain')
      RETURNING *`;
    return expectState(
      mapSubmission(scope, singleTransition(rows, submissionId, 'in-flight/uncertain', 'accepted')),
      'accepted',
    );
  });
}

async function finalizeRejected(
  prisma: PrismaClient,
  scope: TenantScope,
  submissionId: string,
  result: {
    readonly resolvedAt: string;
    readonly httpStatus: number;
    readonly rejectionCode: string;
  },
): Promise<ZatcaRejectedDurableInvoiceSubmission> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<SubmissionRow[]>`
      UPDATE "zatca_invoice_submissions"
         SET "state" = 'rejected',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "httpStatus" = ${result.httpStatus},
             "rejectionCode" = ${result.rejectionCode},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${submissionId}::uuid
         AND "state" IN ('in-flight', 'uncertain')
      RETURNING *`;
    return expectState(
      mapSubmission(scope, singleTransition(rows, submissionId, 'in-flight/uncertain', 'rejected')),
      'rejected',
    );
  });
}

async function finalizeUncertain(
  prisma: PrismaClient,
  scope: TenantScope,
  submissionId: string,
  result: {
    readonly resolvedAt: string;
    readonly uncertaintyReason: ZatcaInvoiceSubmissionUncertaintyReason;
    readonly httpStatus?: number;
  },
): Promise<ZatcaUncertainDurableInvoiceSubmission> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const status = result.httpStatus ?? null;
    const rows = await tx.$queryRaw<SubmissionRow[]>`
      UPDATE "zatca_invoice_submissions"
         SET "state" = 'uncertain',
             "resolvedAt" = ${new Date(result.resolvedAt)},
             "httpStatus" = ${status},
             "uncertaintyReason" = ${result.uncertaintyReason},
             "updatedAt" = ${new Date(result.resolvedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "id" = ${submissionId}::uuid
         AND "state" = 'in-flight'
      RETURNING *`;
    return expectState(
      mapSubmission(scope, singleTransition(rows, submissionId, 'in-flight', 'uncertain')),
      'uncertain',
    );
  });
}

async function findByInvoiceWithin(
  tx: TransactionClient,
  scope: TenantScope,
  invoiceId: string,
  mode: ZatcaInvoiceSubmissionMode,
): Promise<SubmissionRow | null> {
  const rows = await tx.$queryRaw<SubmissionRow[]>`
    SELECT * FROM "zatca_invoice_submissions"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "invoiceId" = ${invoiceId}::uuid
       AND "mode" = ${mode}
     LIMIT 1`;
  const row = rows[0] ?? null;
  if (row !== null) assertSameTenant(scope, row.tenantId);
  return row;
}

function assertScopeMatches(scope: TenantScope, submission: ZatcaPendingInvoiceSubmission): void {
  if (submission.scope.tenantId !== scope.tenantId) {
    throw new ZatcaInvoiceSubmissionError(
      'ZATCA submission tenant does not match repository scope.',
    );
  }
}

function mapSubmission(scope: TenantScope, row: SubmissionRow): ZatcaDurableInvoiceSubmission {
  assertSameTenant(scope, row.tenantId);
  const base = {
    submissionId: row.id,
    scope: { tenantId: tenantId(row.tenantId) },
    invoiceId: row.invoiceId,
    terminalId: row.terminalId,
    environment: row.environment,
    mode: row.mode,
    invoiceUuid: row.invoiceUuid,
    invoiceHash: Uint8Array.from(row.invoiceHash),
    sealedInvoiceXml: Uint8Array.from(row.sealedInvoiceXml),
    productionSecret: { provider: row.secretProvider, secretId: row.secretId },
    queuedAt: toUtcSecond(row.queuedAt),
  };

  if (row.state === 'pending') return { ...base, state: 'pending', attemptCount: 0 };
  if (row.requestStartedAt === null || row.attemptCount !== 1) throw corrupt('request start');
  const requestStartedAt = toUtcSecond(row.requestStartedAt);
  if (row.state === 'in-flight')
    return { ...base, state: 'in-flight', attemptCount: 1, requestStartedAt };
  if (row.resolvedAt === null) throw corrupt('resolution time');
  const resolvedAt = toUtcSecond(row.resolvedAt);

  if (row.state === 'accepted') {
    if (row.httpStatus === null || row.authorityStatus === null)
      throw corrupt('accepted authority outcome');
    const result: ZatcaAcceptedDurableInvoiceSubmission = {
      ...base,
      state: 'accepted',
      attemptCount: 1,
      requestStartedAt,
      resolvedAt,
      httpStatus: row.httpStatus,
      authorityStatus: row.authorityStatus,
      ...(row.clearedInvoiceXml === null
        ? {}
        : { clearedInvoiceXml: Uint8Array.from(row.clearedInvoiceXml) }),
    };
    return result;
  }
  if (row.state === 'rejected') {
    if (row.httpStatus === null || row.rejectionCode === null) throw corrupt('rejection outcome');
    return {
      ...base,
      state: 'rejected',
      attemptCount: 1,
      requestStartedAt,
      resolvedAt,
      httpStatus: row.httpStatus,
      rejectionCode: row.rejectionCode,
    };
  }
  if (row.uncertaintyReason === null) throw corrupt('uncertainty outcome');
  return {
    ...base,
    state: 'uncertain',
    attemptCount: 1,
    requestStartedAt,
    resolvedAt,
    uncertaintyReason: row.uncertaintyReason,
    ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
  };
}

function singleTransition(
  rows: readonly SubmissionRow[],
  id: string,
  from: string,
  to: string,
): SubmissionRow {
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new ZatcaInvoiceSubmissionError(
      `ZATCA submission ${id} did not transition ${from} -> ${to}; concurrent or stale state refused.`,
    );
  }
  return row;
}

function expectState<S extends ZatcaDurableInvoiceSubmission['state']>(
  submission: ZatcaDurableInvoiceSubmission,
  state: S,
): Extract<ZatcaDurableInvoiceSubmission, { state: S }> {
  if (submission.state !== state) {
    throw new ZatcaInvoiceSubmissionError(
      `ZATCA repository returned ${submission.state}; expected ${state}.`,
    );
  }
  return submission as Extract<ZatcaDurableInvoiceSubmission, { state: S }>;
}

function toUtcSecond(value: Date): string {
  const iso = value.toISOString();
  if (!iso.endsWith('.000Z')) {
    throw new ZatcaInvoiceSubmissionError('ZATCA persisted timestamp is not an exact UTC second.');
  }
  return iso.replace('.000Z', 'Z');
}

function corrupt(field: string): ZatcaInvoiceSubmissionError {
  return new ZatcaInvoiceSubmissionError(`ZATCA persisted ${field} contradicts submission state.`);
}
