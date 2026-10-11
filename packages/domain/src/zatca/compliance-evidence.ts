import { DomainError } from '../errors.js';
import type { TenantScope } from '../ports/persistence.js';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  type ZatcaSigningKeyHandle,
} from '../ports/zatca.js';
import type { ZatcaFatooraSecretHandle } from './csid-lifecycle.js';
import type { ZatcaCsidEnvironment } from './csid-provisioning.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CREDENTIAL_ID = /^sha256:[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,500}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export class ZatcaComplianceEvidenceError extends DomainError {
  public override readonly name = 'ZatcaComplianceEvidenceError';
}

/**
 * Durable proof that ZATCA accepted the required compliance-check set for one
 * already-issued Compliance CSID.
 *
 * Request id, credential identity, secret handle, environment and key are
 * derived from the referenced issued CCSID by persistence. A caller recording
 * successful checks is never authority to choose them.
 */
export interface ZatcaAcceptedComplianceEvidence {
  readonly evidenceId: string;
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly complianceAttemptId: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly complianceRequestId: string;
  readonly currentComplianceCredentialId: string;
  readonly currentComplianceSecret: ZatcaFatooraSecretHandle;
  readonly key: ZatcaSigningKeyHandle;
  /** SHA-256 over the canonical identities of the successful compliance checks. */
  readonly checkSetHash: string;
  readonly acceptedAt: string;
}

export interface RecordZatcaAcceptedComplianceEvidenceInput {
  readonly evidenceId: string;
  readonly terminalId: string;
  readonly complianceAttemptId: string;
  readonly checkSetHash: string;
  readonly acceptedAt: string;
}

export function assertZatcaComplianceEvidenceRecordInput(
  input: RecordZatcaAcceptedComplianceEvidenceInput,
): void {
  assertNonEmpty('evidence id', input.evidenceId);
  assertNonEmpty('terminal id', input.terminalId);
  assertNonEmpty('Compliance CSID attempt id', input.complianceAttemptId);
  assertSha256('check-set hash', input.checkSetHash);
  assertUtcSecond('acceptance time', input.acceptedAt);
}

export function assertZatcaAcceptedComplianceEvidence(
  evidence: ZatcaAcceptedComplianceEvidence,
): void {
  assertZatcaComplianceEvidenceRecordInput(evidence);
  assertNonEmpty('tenant id', evidence.scope.tenantId);
  if (!REQUEST_ID.test(evidence.complianceRequestId)) {
    throw new ZatcaComplianceEvidenceError('ZATCA compliance request id is invalid.');
  }
  if (!CREDENTIAL_ID.test(evidence.currentComplianceCredentialId)) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA Compliance CSID credential identity must be a certificate SHA-256 identity.',
    );
  }
  assertNonEmpty('secret provider', evidence.currentComplianceSecret.provider);
  assertNonEmpty('secret id', evidence.currentComplianceSecret.secretId);
  assertNonEmpty('key provider', evidence.key.provider);
  assertNonEmpty('key id', evidence.key.keyId);
  if (
    evidence.key.curve !== ZATCA_SIGNING_CURVE ||
    evidence.key.algorithm !== ZATCA_SIGNING_ALGORITHM ||
    evidence.key.exportable !== false
  ) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA compliance evidence must remain bound to the approved non-exportable signing key.',
    );
  }
}

export function assertZatcaComplianceEvidenceAuthority(
  evidence: ZatcaAcceptedComplianceEvidence,
  scope: TenantScope,
  terminalId: string,
): void {
  assertZatcaAcceptedComplianceEvidence(evidence);
  if (evidence.scope.tenantId !== scope.tenantId || evidence.terminalId !== terminalId) {
    throw new ZatcaComplianceEvidenceError(
      'ZATCA compliance evidence authority does not match tenant and terminal.',
    );
  }
}

function assertSha256(label: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ZatcaComplianceEvidenceError(`ZATCA ${label} must be lower-case SHA-256 hex.`);
  }
}

function assertUtcSecond(label: string, value: string): void {
  if (!UTC_SECOND.test(value)) {
    throw new ZatcaComplianceEvidenceError(`ZATCA ${label} must be an exact UTC second.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    throw new ZatcaComplianceEvidenceError(`ZATCA ${label} is not a real UTC instant.`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim() === '') {
    throw new ZatcaComplianceEvidenceError(`ZATCA ${label} must not be empty.`);
  }
}
