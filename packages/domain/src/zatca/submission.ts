import { DomainError } from '../errors.js';
import type { TenantScope } from '../ports/persistence.js';
import type { ZatcaCsidEnvironment } from './csid-provisioning.js';
import type { ZatcaFatooraSecretHandle } from './csid-lifecycle.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type ZatcaInvoiceSubmissionMode = 'reporting' | 'clearance';
export type ZatcaInvoiceSubmissionState =
  'pending' | 'in-flight' | 'accepted' | 'rejected' | 'uncertain';

export type ZatcaInvoiceSubmissionUncertaintyReason =
  'credential-store' | 'transport' | 'response-invalid';

export class ZatcaInvoiceSubmissionError extends DomainError {
  public override readonly name = 'ZatcaInvoiceSubmissionError';
}

export interface SubmitZatcaInvoiceInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly mode: ZatcaInvoiceSubmissionMode;
  /** UUID frozen into the sealed UBL invoice. It must never be regenerated on retry. */
  readonly invoiceUuid: string;
  /** Base64 SHA-256 of the exact ZATCA invoice-reference canonical bytes. */
  readonly invoiceHashBase64: string;
  /** Base64 of the exact sealed UBL XML bytes. It must never be regenerated on retry. */
  readonly invoiceBase64: string;
  /** Opaque encrypted Production-CSID credential handle. Plaintext never crosses this boundary. */
  readonly productionSecret: ZatcaFatooraSecretHandle;
}

export interface ZatcaAcceptedInvoiceSubmission {
  readonly kind: 'accepted';
  readonly httpStatus: number;
  readonly authorityStatus: 'REPORTED' | 'CLEARED';
  /** Present only when ZATCA returns a cleared invoice. Never required for reporting. */
  readonly clearedInvoiceBase64?: string;
}

export interface ZatcaRejectedInvoiceSubmission {
  readonly kind: 'rejected';
  readonly httpStatus: number;
  readonly rejectionCode: string;
}

export interface ZatcaUncertainInvoiceSubmission {
  readonly kind: 'uncertain';
  readonly reason: ZatcaInvoiceSubmissionUncertaintyReason;
  readonly httpStatus?: number;
}

export type ZatcaInvoiceSubmissionResult =
  ZatcaAcceptedInvoiceSubmission | ZatcaRejectedInvoiceSubmission | ZatcaUncertainInvoiceSubmission;

/**
 * One HTTP attempt against FATOORA. This port MUST NOT retry internally: once
 * request bytes may have left the process, a missing response is an ambiguous
 * remote side effect and belongs to the durable submission state machine.
 */
export interface ZatcaInvoiceSubmissionPort {
  submit(input: SubmitZatcaInvoiceInput): Promise<ZatcaInvoiceSubmissionResult>;
}

interface ZatcaDurableInvoiceSubmissionBase {
  readonly submissionId: string;
  readonly scope: TenantScope;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly mode: ZatcaInvoiceSubmissionMode;
  readonly invoiceUuid: string;
  /** Exact SHA-256 invoice digest bytes. */
  readonly invoiceHash: Uint8Array;
  /** Exact sealed XML bytes submitted to ZATCA. */
  readonly sealedInvoiceXml: Uint8Array;
  readonly productionSecret: ZatcaFatooraSecretHandle;
  readonly queuedAt: string;
}

export interface ZatcaPendingInvoiceSubmission extends ZatcaDurableInvoiceSubmissionBase {
  readonly state: 'pending';
  readonly attemptCount: 0;
}

export interface ZatcaInFlightInvoiceSubmission extends ZatcaDurableInvoiceSubmissionBase {
  readonly state: 'in-flight';
  readonly attemptCount: 1;
  /** Persisted before the first outbound byte may be sent. */
  readonly requestStartedAt: string;
}

export interface ZatcaAcceptedDurableInvoiceSubmission extends ZatcaDurableInvoiceSubmissionBase {
  readonly state: 'accepted';
  readonly attemptCount: 1;
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  readonly httpStatus: number;
  readonly authorityStatus: 'REPORTED' | 'CLEARED';
  readonly clearedInvoiceXml?: Uint8Array;
}

export interface ZatcaRejectedDurableInvoiceSubmission extends ZatcaDurableInvoiceSubmissionBase {
  readonly state: 'rejected';
  readonly attemptCount: 1;
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  readonly httpStatus: number;
  readonly rejectionCode: string;
}

export interface ZatcaUncertainDurableInvoiceSubmission extends ZatcaDurableInvoiceSubmissionBase {
  readonly state: 'uncertain';
  readonly attemptCount: 1;
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  readonly uncertaintyReason: ZatcaInvoiceSubmissionUncertaintyReason;
  readonly httpStatus?: number;
}

export type ZatcaDurableInvoiceSubmission =
  | ZatcaPendingInvoiceSubmission
  | ZatcaInFlightInvoiceSubmission
  | ZatcaAcceptedDurableInvoiceSubmission
  | ZatcaRejectedDurableInvoiceSubmission
  | ZatcaUncertainDurableInvoiceSubmission;

export interface PrepareZatcaInvoiceSubmissionInput {
  readonly submissionId: string;
  readonly scope: TenantScope;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly mode: ZatcaInvoiceSubmissionMode;
  readonly invoiceUuid: string;
  readonly invoiceHash: Uint8Array;
  readonly sealedInvoiceXml: Uint8Array;
  readonly productionSecret: ZatcaFatooraSecretHandle;
  readonly queuedAt: string;
}

export interface ZatcaInvoiceSubmissionRepository {
  findByInvoice(
    scope: TenantScope,
    invoiceId: string,
    mode: ZatcaInvoiceSubmissionMode,
  ): Promise<ZatcaDurableInvoiceSubmission | null>;
  reservePending(
    scope: TenantScope,
    submission: ZatcaPendingInvoiceSubmission,
  ): Promise<ZatcaDurableInvoiceSubmission>;
  markRequestStarted(
    scope: TenantScope,
    submissionId: string,
    requestStartedAt: string,
  ): Promise<ZatcaInFlightInvoiceSubmission>;
  markAccepted(
    scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly httpStatus: number;
      readonly authorityStatus: 'REPORTED' | 'CLEARED';
      readonly clearedInvoiceXml?: Uint8Array;
    },
  ): Promise<ZatcaAcceptedDurableInvoiceSubmission>;
  markRejected(
    scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly httpStatus: number;
      readonly rejectionCode: string;
    },
  ): Promise<ZatcaRejectedDurableInvoiceSubmission>;
  markUncertain(
    scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly uncertaintyReason: ZatcaInvoiceSubmissionUncertaintyReason;
      readonly httpStatus?: number;
    },
  ): Promise<ZatcaUncertainDurableInvoiceSubmission>;
}

export function prepareZatcaInvoiceSubmission(
  input: PrepareZatcaInvoiceSubmissionInput,
): ZatcaPendingInvoiceSubmission {
  assertUuid('submission id', input.submissionId);
  assertNonEmpty('tenant id', input.scope.tenantId);
  assertUuid('invoice id', input.invoiceId);
  assertUuid('terminal id', input.terminalId);
  assertUuid('invoice UUID', input.invoiceUuid);
  if (input.invoiceHash.length !== 32) {
    throw new ZatcaInvoiceSubmissionError('ZATCA invoice hash must be exactly 32 bytes.');
  }
  if (input.sealedInvoiceXml.length < 16) {
    throw new ZatcaInvoiceSubmissionError('ZATCA sealed invoice XML is unexpectedly small.');
  }
  assertSecretHandle(input.productionSecret);
  assertUtcSecond('queue time', input.queuedAt);
  return {
    ...input,
    scope: { tenantId: input.scope.tenantId },
    invoiceHash: Uint8Array.from(input.invoiceHash),
    sealedInvoiceXml: Uint8Array.from(input.sealedInvoiceXml),
    productionSecret: { ...input.productionSecret },
    state: 'pending',
    attemptCount: 0,
  };
}

/**
 * Automatic submission is allowed exactly once. In-flight and uncertain rows
 * are reconciliation work; blindly retransmitting them can duplicate a remote
 * side effect if ZATCA accepted the first request before the response was lost.
 */
export function assertAutomaticZatcaInvoiceSubmissionAllowed(
  submission: ZatcaDurableInvoiceSubmission,
): asserts submission is ZatcaPendingInvoiceSubmission {
  if (submission.state !== 'pending' || submission.attemptCount !== 0) {
    throw new ZatcaInvoiceSubmissionError(
      `ZATCA invoice submission in state ${submission.state} cannot be sent automatically.`,
    );
  }
}

export function assertZatcaInvoiceSubmissionReplay(
  existing: ZatcaDurableInvoiceSubmission,
  candidate: ZatcaPendingInvoiceSubmission,
): void {
  const same =
    existing.invoiceId === candidate.invoiceId &&
    existing.terminalId === candidate.terminalId &&
    existing.environment === candidate.environment &&
    existing.mode === candidate.mode &&
    existing.invoiceUuid === candidate.invoiceUuid &&
    equalBytes(existing.invoiceHash, candidate.invoiceHash) &&
    equalBytes(existing.sealedInvoiceXml, candidate.sealedInvoiceXml) &&
    existing.productionSecret.provider === candidate.productionSecret.provider &&
    existing.productionSecret.secretId === candidate.productionSecret.secretId;
  if (!same) {
    throw new ZatcaInvoiceSubmissionError(
      'ZATCA invoice submission was replayed with different immutable request identity.',
    );
  }
}

function assertUuid(label: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ZatcaInvoiceSubmissionError(`ZATCA ${label} must be a UUID.`);
  }
}

function assertUtcSecond(label: string, value: string): void {
  if (!UTC_SECOND.test(value)) {
    throw new ZatcaInvoiceSubmissionError(`ZATCA ${label} must be an exact UTC second.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    throw new ZatcaInvoiceSubmissionError(`ZATCA ${label} is not a real UTC instant.`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim() === '') {
    throw new ZatcaInvoiceSubmissionError(`ZATCA ${label} must not be empty.`);
  }
}

function assertSecretHandle(handle: ZatcaFatooraSecretHandle): void {
  assertNonEmpty('secret provider', handle.provider);
  assertNonEmpty('secret id', handle.secretId);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
