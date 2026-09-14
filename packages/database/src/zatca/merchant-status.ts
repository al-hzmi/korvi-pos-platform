import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { TenantScope } from '@korvi/domain';

export const MAX_ZATCA_STATUS_TERMINALS = 100;
export const MAX_ZATCA_STATUS_SUBMISSIONS = 50;

export type MerchantZatcaEnvironment = 'sandbox' | 'simulation' | 'production';
export type MerchantZatcaProvisioningState =
  | 'prepared'
  | 'in-flight'
  | 'issued'
  | 'rejected'
  | 'uncertain';
export type MerchantZatcaSubmissionMode = 'reporting' | 'clearance';
export type MerchantZatcaSubmissionState =
  | 'pending'
  | 'in-flight'
  | 'accepted'
  | 'rejected'
  | 'uncertain';
export type MerchantZatcaUncertaintyReason = 'credential-store' | 'transport' | 'response-invalid';

export interface MerchantZatcaStatusQuery {
  readonly terminalLimit?: number;
  readonly submissionLimit?: number;
}

export type MerchantZatcaStatusRefusal = 'invalid-limit';

export class MerchantZatcaStatusRefusedError extends Error {
  public override readonly name = 'MerchantZatcaStatusRefusedError';

  public constructor(public readonly detail: MerchantZatcaStatusRefusal) {
    super(detail);
  }
}

export interface MerchantZatcaProvisioningStatus {
  readonly attemptId: string;
  readonly environment: MerchantZatcaEnvironment;
  readonly state: MerchantZatcaProvisioningState;
  readonly preparedAt: string;
  readonly requestStartedAt: string | null;
  readonly resolvedAt: string | null;
  readonly remoteRequestId: string | null;
  readonly credentialId: string | null;
  readonly rejectionCode: string | null;
  readonly uncertaintyReason: MerchantZatcaUncertaintyReason | null;
}

export interface MerchantZatcaTerminalStatus {
  readonly terminalId: string;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
  readonly latestProvisioning: MerchantZatcaProvisioningStatus | null;
  /** Latest accepted compliance evidence. This is not a certificate-health assertion. */
  readonly complianceAcceptedAt: string | null;
}

export interface MerchantZatcaSubmissionStatus {
  readonly submissionId: string;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly environment: MerchantZatcaEnvironment;
  readonly mode: MerchantZatcaSubmissionMode;
  readonly state: MerchantZatcaSubmissionState;
  readonly attemptCount: number;
  readonly queuedAt: string;
  readonly requestStartedAt: string | null;
  readonly resolvedAt: string | null;
  readonly httpStatus: number | null;
  readonly authorityStatus: 'REPORTED' | 'CLEARED' | null;
  readonly rejectionCode: string | null;
  readonly uncertaintyReason: MerchantZatcaUncertaintyReason | null;
}

export interface MerchantZatcaStatusSummary {
  /** Decimal integer strings keep counts exact across the JSON boundary. */
  readonly terminalCount: string;
  readonly complianceReadyTerminalCount: string;
  readonly acceptedSubmissionCount: string;
  readonly rejectedSubmissionCount: string;
  readonly unresolvedSubmissionCount: string;
}

export interface MerchantZatcaStatus {
  readonly summary: MerchantZatcaStatusSummary;
  readonly terminals: readonly MerchantZatcaTerminalStatus[];
  readonly terminalHasMore: boolean;
  readonly recentSubmissions: readonly MerchantZatcaSubmissionStatus[];
}

interface TerminalStatusRow {
  terminalId: string;
  branchId: string;
  code: string;
  label: string;
  isActive: boolean;
  lastSeenAt: Date | null;
  attemptId: string | null;
  environment: MerchantZatcaEnvironment | null;
  provisioningState: MerchantZatcaProvisioningState | null;
  preparedAt: Date | null;
  requestStartedAt: Date | null;
  resolvedAt: Date | null;
  remoteRequestId: string | null;
  credentialId: string | null;
  rejectionCode: string | null;
  uncertaintyReason: MerchantZatcaUncertaintyReason | null;
  complianceAcceptedAt: Date | null;
}

interface SubmissionStatusRow {
  submissionId: string;
  invoiceId: string;
  terminalId: string;
  environment: MerchantZatcaEnvironment;
  mode: MerchantZatcaSubmissionMode;
  state: MerchantZatcaSubmissionState;
  attemptCount: number;
  queuedAt: Date;
  requestStartedAt: Date | null;
  resolvedAt: Date | null;
  httpStatus: number | null;
  authorityStatus: 'REPORTED' | 'CLEARED' | null;
  rejectionCode: string | null;
  uncertaintyReason: MerchantZatcaUncertaintyReason | null;
}

interface SummaryRow {
  terminalCount: bigint | string;
  complianceReadyTerminalCount: bigint | string;
  acceptedSubmissionCount: bigint | string;
  rejectedSubmissionCount: bigint | string;
  unresolvedSubmissionCount: bigint | string;
}

function validatedLimit(value: number | undefined, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MerchantZatcaStatusRefusedError('invalid-limit');
  }
  return value;
}

function count(value: bigint | string): string {
  return (typeof value === 'bigint' ? value : BigInt(value)).toString();
}

function instant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function mapTerminal(row: TerminalStatusRow): MerchantZatcaTerminalStatus {
  const latestProvisioning =
    row.attemptId === null ||
    row.environment === null ||
    row.provisioningState === null ||
    row.preparedAt === null
      ? null
      : {
          attemptId: row.attemptId,
          environment: row.environment,
          state: row.provisioningState,
          preparedAt: row.preparedAt.toISOString(),
          requestStartedAt: instant(row.requestStartedAt),
          resolvedAt: instant(row.resolvedAt),
          remoteRequestId: row.remoteRequestId,
          credentialId: row.credentialId,
          rejectionCode: row.rejectionCode,
          uncertaintyReason: row.uncertaintyReason,
        };

  return {
    terminalId: row.terminalId,
    branchId: row.branchId,
    code: row.code,
    label: row.label,
    isActive: row.isActive,
    lastSeenAt: instant(row.lastSeenAt),
    latestProvisioning,
    complianceAcceptedAt: instant(row.complianceAcceptedAt),
  };
}

function mapSubmission(row: SubmissionStatusRow): MerchantZatcaSubmissionStatus {
  return {
    submissionId: row.submissionId,
    invoiceId: row.invoiceId,
    terminalId: row.terminalId,
    environment: row.environment,
    mode: row.mode,
    state: row.state,
    attemptCount: row.attemptCount,
    queuedAt: row.queuedAt.toISOString(),
    requestStartedAt: instant(row.requestStartedAt),
    resolvedAt: instant(row.resolvedAt),
    httpStatus: row.httpStatus,
    authorityStatus: row.authorityStatus,
    rejectionCode: row.rejectionCode,
    uncertaintyReason: row.uncertaintyReason,
  };
}

/**
 * Merchant-safe projection of Korvi's durable ZATCA evidence.
 *
 * This intentionally never selects private-key handles, secret handles,
 * ciphertext, certificate bytes, invoice hashes or sealed/cleared XML. It
 * reports only operational state already made durable by the ZATCA state
 * machines, under the same tenant RLS context as those repositories.
 */
export async function readMerchantZatcaStatus(
  prisma: PrismaClient,
  scope: TenantScope,
  query: MerchantZatcaStatusQuery = {},
): Promise<MerchantZatcaStatus> {
  const terminalLimit = validatedLimit(
    query.terminalLimit,
    MAX_ZATCA_STATUS_TERMINALS,
    MAX_ZATCA_STATUS_TERMINALS,
  );
  const submissionLimit = validatedLimit(
    query.submissionLimit,
    MAX_ZATCA_STATUS_SUBMISSIONS,
    25,
  );
  const tenant = scope.tenantId as string;

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const [terminalRows, submissionRows, summaryRows] = await Promise.all([
      tx.$queryRaw<TerminalStatusRow[]>`
        SELECT terminal."id" AS "terminalId",
               terminal."branchId" AS "branchId",
               terminal."code",
               terminal."label",
               terminal."isActive",
               terminal."lastSeenAt",
               attempt."id" AS "attemptId",
               attempt."environment",
               attempt."state" AS "provisioningState",
               attempt."preparedAt",
               attempt."requestStartedAt",
               attempt."resolvedAt",
               attempt."remoteRequestId",
               attempt."credentialId",
               attempt."rejectionCode",
               attempt."uncertaintyReason",
               evidence."acceptedAt" AS "complianceAcceptedAt"
          FROM "terminals" AS terminal
          LEFT JOIN LATERAL (
            SELECT candidate."id",
                   candidate."environment",
                   candidate."state",
                   candidate."preparedAt",
                   candidate."requestStartedAt",
                   candidate."resolvedAt",
                   candidate."remoteRequestId",
                   candidate."credentialId",
                   candidate."rejectionCode",
                   candidate."uncertaintyReason"
              FROM "zatca_csid_provisioning_attempts" AS candidate
             WHERE candidate."tenantId" = terminal."tenantId"
               AND candidate."terminalId" = terminal."id"
             ORDER BY candidate."preparedAt" DESC, candidate."id" DESC
             LIMIT 1
          ) AS attempt ON TRUE
          LEFT JOIN LATERAL (
            SELECT candidate."acceptedAt"
              FROM "zatca_compliance_evidence" AS candidate
             WHERE candidate."tenantId" = terminal."tenantId"
               AND candidate."terminalId" = terminal."id"
             ORDER BY candidate."acceptedAt" DESC, candidate."id" DESC
             LIMIT 1
          ) AS evidence ON TRUE
         WHERE terminal."tenantId" = ${tenant}::uuid
         ORDER BY terminal."code" ASC, terminal."id" ASC
         LIMIT ${terminalLimit + 1}`,
      tx.$queryRaw<SubmissionStatusRow[]>`
        SELECT submission."id" AS "submissionId",
               submission."invoiceId",
               submission."terminalId",
               submission."environment",
               submission."mode",
               submission."state",
               submission."attemptCount",
               submission."queuedAt",
               submission."requestStartedAt",
               submission."resolvedAt",
               submission."httpStatus",
               submission."authorityStatus",
               submission."rejectionCode",
               submission."uncertaintyReason"
          FROM "zatca_invoice_submissions" AS submission
         WHERE submission."tenantId" = ${tenant}::uuid
         ORDER BY submission."queuedAt" DESC, submission."id" DESC
         LIMIT ${submissionLimit}`,
      tx.$queryRaw<SummaryRow[]>`
        SELECT
          (SELECT COUNT(*)::bigint
             FROM "terminals" AS terminal
            WHERE terminal."tenantId" = ${tenant}::uuid) AS "terminalCount",
          (SELECT COUNT(DISTINCT evidence."terminalId")::bigint
             FROM "zatca_compliance_evidence" AS evidence
            WHERE evidence."tenantId" = ${tenant}::uuid) AS "complianceReadyTerminalCount",
          (SELECT COUNT(*)::bigint
             FROM "zatca_invoice_submissions" AS submission
            WHERE submission."tenantId" = ${tenant}::uuid
              AND submission."state" = 'accepted') AS "acceptedSubmissionCount",
          (SELECT COUNT(*)::bigint
             FROM "zatca_invoice_submissions" AS submission
            WHERE submission."tenantId" = ${tenant}::uuid
              AND submission."state" = 'rejected') AS "rejectedSubmissionCount",
          (SELECT COUNT(*)::bigint
             FROM "zatca_invoice_submissions" AS submission
            WHERE submission."tenantId" = ${tenant}::uuid
              AND submission."state" IN ('pending', 'in-flight', 'uncertain'))
            AS "unresolvedSubmissionCount"`,
    ]);

    const summary = summaryRows[0];
    if (summary === undefined) {
      throw new Error('ZATCA status aggregate did not return a row.');
    }

    return {
      summary: {
        terminalCount: count(summary.terminalCount),
        complianceReadyTerminalCount: count(summary.complianceReadyTerminalCount),
        acceptedSubmissionCount: count(summary.acceptedSubmissionCount),
        rejectedSubmissionCount: count(summary.rejectedSubmissionCount),
        unresolvedSubmissionCount: count(summary.unresolvedSubmissionCount),
      },
      terminals: terminalRows.slice(0, terminalLimit).map(mapTerminal),
      terminalHasMore: terminalRows.length > terminalLimit,
      recentSubmissions: submissionRows.map(mapSubmission),
    };
  });
}
