import type { TenantScope } from '../ports/persistence.js';
import type { ZatcaFatooraSecretHandle } from './csid-provisioning.js';
import type { ZatcaCsidEnvironment } from './csid-provisioning.js';

export type ZatcaInvoiceSubmissionMode = 'reporting' | 'clearance';

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

export type ZatcaInvoiceSubmissionUncertaintyReason =
  'credential-store' | 'transport' | 'response-invalid';

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
