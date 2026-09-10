import type { TenantScope } from './persistence.js';
import type {
  ZatcaCsidProvisioningAttempt,
  ZatcaInFlightCsidProvisioning,
  ZatcaIssuedCsidProvisioning,
  ZatcaPreparedCsidProvisioning,
  ZatcaRejectedCsidProvisioning,
  ZatcaUncertainCsidProvisioning,
} from '../zatca/csid-provisioning.js';
import type { ZatcaFatooraSecretHandle } from '../zatca/csid-lifecycle.js';

/**
 * Durable compare-and-set repository for the CSID issuance state machine.
 *
 * Implementations MUST run under tenant RLS. `markRequestStarted` MUST commit
 * before any outbound request is allowed. Every mutating method is a state CAS:
 * if the stored state no longer matches the expected state, it must fail rather
 * than overwrite a concurrent or recovered result.
 */
export interface ZatcaCsidProvisioningRepository {
  findByOperationId(
    scope: TenantScope,
    operationId: string,
  ): Promise<ZatcaCsidProvisioningAttempt | null>;

  /**
   * Insert a new prepared attempt, or return the existing same-operation record.
   * A repository must never mutate an existing requestHash on replay.
   */
  reservePrepared(
    scope: TenantScope,
    attempt: ZatcaPreparedCsidProvisioning,
  ): Promise<ZatcaCsidProvisioningAttempt>;

  markRequestStarted(
    scope: TenantScope,
    attemptId: string,
    requestStartedAt: string,
  ): Promise<ZatcaInFlightCsidProvisioning>;

  markIssued(
    scope: TenantScope,
    attemptId: string,
    result: {
      readonly resolvedAt: string;
      readonly remoteRequestId: string;
      readonly credentialId: string;
      readonly certificateDer: Uint8Array;
      readonly fatooraSecret: ZatcaFatooraSecretHandle;
    },
  ): Promise<ZatcaIssuedCsidProvisioning>;

  markRejected(
    scope: TenantScope,
    attemptId: string,
    result: { readonly resolvedAt: string; readonly rejectionCode: string },
  ): Promise<ZatcaRejectedCsidProvisioning>;

  markUncertain(
    scope: TenantScope,
    attemptId: string,
    result: {
      readonly resolvedAt: string;
      readonly uncertaintyReason: ZatcaUncertainCsidProvisioning['uncertaintyReason'];
    },
  ): Promise<ZatcaUncertainCsidProvisioning>;
}

export interface IssueZatcaComplianceCsidInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly operationId: string;
  /** DER PKCS#10 CSR. */
  readonly csrDer: Uint8Array;
  /** One-time code exists only for this call and must never be logged or persisted. */
  readonly otp: string;
}

export type ZatcaComplianceCsidIssueResult =
  | {
      readonly kind: 'issued';
      readonly remoteRequestId: string;
      readonly credentialId: string;
      readonly certificateDer: Uint8Array;
      /** The issuer has already durably stored the secret before returning this handle. */
      readonly fatooraSecret: ZatcaFatooraSecretHandle;
    }
  | {
      readonly kind: 'rejected';
      /** Bounded, stable provider code only; never a raw response or diagnostic body. */
      readonly rejectionCode: string;
    }
  | {
      readonly kind: 'uncertain';
      readonly reason: ZatcaUncertainCsidProvisioning['uncertaintyReason'];
    };

/**
 * Server-only credential issuer boundary.
 *
 * A concrete adapter owns HTTPS, Basic/OTP headers and the raw ZATCA secret. It
 * MUST store that secret in an approved secret manager before returning. Neither
 * callers nor PostgreSQL ever receive the plaintext secret.
 */
export interface ZatcaComplianceCsidIssuerPort {
  issue(input: IssueZatcaComplianceCsidInput): Promise<ZatcaComplianceCsidIssueResult>;
}
