import { DomainError } from '../errors.js';
import type { TenantScope } from '../ports/persistence.js';
import type { ZatcaSigningKeyHandle } from '../ports/zatca.js';
import type { ZatcaFatooraSecretHandle } from './csid-lifecycle.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type ZatcaCsidEnvironment = 'sandbox' | 'simulation' | 'production';
export type ZatcaCsidProvisioningState =
  | 'prepared'
  | 'in-flight'
  | 'issued'
  | 'rejected'
  | 'uncertain';

export class ZatcaCsidProvisioningError extends DomainError {
  public override readonly name = 'ZatcaCsidProvisioningError';
}

interface ZatcaCsidProvisioningBase {
  readonly attemptId: string;
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly operationId: string;
  /** SHA-256 over the canonical non-secret request identity. */
  readonly requestHash: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly key: ZatcaSigningKeyHandle;
  readonly csrSha256Hex: string;
  readonly preparedAt: string;
}

export interface ZatcaPreparedCsidProvisioning extends ZatcaCsidProvisioningBase {
  readonly state: 'prepared';
}

export interface ZatcaInFlightCsidProvisioning extends ZatcaCsidProvisioningBase {
  readonly state: 'in-flight';
  /** Persisted before the first outbound byte may be sent to ZATCA. */
  readonly requestStartedAt: string;
}

export interface ZatcaIssuedCsidProvisioning extends ZatcaCsidProvisioningBase {
  readonly state: 'issued';
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  readonly remoteRequestId: string;
  readonly credentialId: string;
  /** Public certificate only. Private signing material never leaves the key provider. */
  readonly certificateDer: Uint8Array;
  /** Opaque vault locator. The Fatoora secret itself is never a domain value. */
  readonly fatooraSecret: ZatcaFatooraSecretHandle;
}

export interface ZatcaRejectedCsidProvisioning extends ZatcaCsidProvisioningBase {
  readonly state: 'rejected';
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  /** Stable, non-secret provider code. Never the raw response body. */
  readonly rejectionCode: string;
}

export interface ZatcaUncertainCsidProvisioning extends ZatcaCsidProvisioningBase {
  readonly state: 'uncertain';
  readonly requestStartedAt: string;
  readonly resolvedAt: string;
  /** Sanitized local reason; raw HTTP response and secrets are forbidden. */
  readonly uncertaintyReason: 'transport' | 'response-invalid' | 'credential-store';
}

export type ZatcaCsidProvisioningAttempt =
  | ZatcaPreparedCsidProvisioning
  | ZatcaInFlightCsidProvisioning
  | ZatcaIssuedCsidProvisioning
  | ZatcaRejectedCsidProvisioning
  | ZatcaUncertainCsidProvisioning;

export interface PrepareZatcaCsidProvisioningInput {
  readonly attemptId: string;
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly key: ZatcaSigningKeyHandle;
  readonly csrSha256Hex: string;
  readonly preparedAt: string;
}

export function prepareZatcaCsidProvisioning(
  input: PrepareZatcaCsidProvisioningInput,
): ZatcaPreparedCsidProvisioning {
  assertNonEmpty('attempt id', input.attemptId);
  assertNonEmpty('tenant id', input.scope.tenantId);
  assertNonEmpty('terminal id', input.terminalId);
  assertNonEmpty('operation id', input.operationId);
  assertSha256('request hash', input.requestHash);
  assertSha256('CSR hash', input.csrSha256Hex);
  assertUtcSecond('prepared time', input.preparedAt);
  assertSigningKey(input.key);
  return {
    ...input,
    scope: { tenantId: input.scope.tenantId },
    key: { ...input.key },
    state: 'prepared',
  };
}

/**
 * Mark the uncertainty boundary before performing the network request.
 *
 * Once this state is durable, an automatic retry is forbidden: a process can die
 * after ZATCA accepted the request but before Korvi receives the response. Reusing
 * the same business operation must reconcile that attempt, never issue blindly.
 */
export function markZatcaCsidRequestStarted(
  attempt: ZatcaPreparedCsidProvisioning,
  requestStartedAt: string,
): ZatcaInFlightCsidProvisioning {
  assertUtcSecond('request start time', requestStartedAt);
  assertNotBefore(attempt.preparedAt, requestStartedAt, 'request start time');
  return { ...attempt, state: 'in-flight', requestStartedAt };
}

export function markZatcaCsidIssued(
  attempt: ZatcaInFlightCsidProvisioning | ZatcaUncertainCsidProvisioning,
  result: {
    readonly resolvedAt: string;
    readonly remoteRequestId: string;
    readonly credentialId: string;
    readonly certificateDer: Uint8Array;
    readonly fatooraSecret: ZatcaFatooraSecretHandle;
  },
): ZatcaIssuedCsidProvisioning {
  assertResolutionTime(attempt, result.resolvedAt);
  assertNonEmpty('remote request id', result.remoteRequestId);
  assertNonEmpty('credential id', result.credentialId);
  if (result.certificateDer.length === 0) {
    throw new ZatcaCsidProvisioningError('ZATCA issued certificate must not be empty.');
  }
  assertSecretHandle(result.fatooraSecret);
  return {
    ...baseFromAttempt(attempt),
    state: 'issued',
    requestStartedAt: attempt.requestStartedAt,
    resolvedAt: result.resolvedAt,
    remoteRequestId: result.remoteRequestId,
    credentialId: result.credentialId,
    certificateDer: Uint8Array.from(result.certificateDer),
    fatooraSecret: { ...result.fatooraSecret },
  };
}

export function markZatcaCsidRejected(
  attempt: ZatcaInFlightCsidProvisioning | ZatcaUncertainCsidProvisioning,
  result: { readonly resolvedAt: string; readonly rejectionCode: string },
): ZatcaRejectedCsidProvisioning {
  assertResolutionTime(attempt, result.resolvedAt);
  assertNonEmpty('rejection code', result.rejectionCode);
  return {
    ...baseFromAttempt(attempt),
    state: 'rejected',
    requestStartedAt: attempt.requestStartedAt,
    resolvedAt: result.resolvedAt,
    rejectionCode: result.rejectionCode,
  };
}

export function markZatcaCsidUncertain(
  attempt: ZatcaInFlightCsidProvisioning,
  result: {
    readonly resolvedAt: string;
    readonly uncertaintyReason: ZatcaUncertainCsidProvisioning['uncertaintyReason'];
  },
): ZatcaUncertainCsidProvisioning {
  assertResolutionTime(attempt, result.resolvedAt);
  return {
    ...baseFromAttempt(attempt),
    state: 'uncertain',
    requestStartedAt: attempt.requestStartedAt,
    resolvedAt: result.resolvedAt,
    uncertaintyReason: result.uncertaintyReason,
  };
}

/** Only a definitely-unsent request may cross the automatic issuance boundary. */
export function assertAutomaticZatcaCsidIssuanceAllowed(
  attempt: ZatcaCsidProvisioningAttempt,
): asserts attempt is ZatcaPreparedCsidProvisioning {
  if (attempt.state !== 'prepared') {
    throw new ZatcaCsidProvisioningError(
      `ZATCA CSID attempt in state ${attempt.state} cannot be issued automatically.`,
    );
  }
}

/**
 * Same operation id with different request identity is an idempotency conflict,
 * never a request to mutate the original provisioning attempt.
 */
export function assertZatcaProvisioningReplay(
  existing: ZatcaCsidProvisioningAttempt,
  operationId: string,
  requestHash: string,
): void {
  if (existing.operationId !== operationId || existing.requestHash !== requestHash) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSID provisioning operation was replayed with different request identity.',
    );
  }
}

function baseFromAttempt(attempt: ZatcaCsidProvisioningAttempt): ZatcaCsidProvisioningBase {
  return {
    attemptId: attempt.attemptId,
    scope: { tenantId: attempt.scope.tenantId },
    terminalId: attempt.terminalId,
    operationId: attempt.operationId,
    requestHash: attempt.requestHash,
    environment: attempt.environment,
    key: { ...attempt.key },
    csrSha256Hex: attempt.csrSha256Hex,
    preparedAt: attempt.preparedAt,
  };
}

function assertResolutionTime(
  attempt: ZatcaInFlightCsidProvisioning | ZatcaUncertainCsidProvisioning,
  resolvedAt: string,
): void {
  assertUtcSecond('resolution time', resolvedAt);
  assertNotBefore(attempt.requestStartedAt, resolvedAt, 'resolution time');
}

function assertNotBefore(earlier: string, later: string, label: string): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new ZatcaCsidProvisioningError(`ZATCA ${label} cannot precede its causal state.`);
  }
}

function assertSha256(label: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ZatcaCsidProvisioningError(`ZATCA ${label} must be lower-case SHA-256 hex.`);
  }
}

function assertUtcSecond(label: string, value: string): void {
  if (!UTC_SECOND.test(value)) {
    throw new ZatcaCsidProvisioningError(`ZATCA ${label} must be an exact UTC second.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace('.000Z', 'Z') !== value) {
    throw new ZatcaCsidProvisioningError(`ZATCA ${label} is not a real UTC instant.`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim() === '') {
    throw new ZatcaCsidProvisioningError(`ZATCA ${label} must not be empty.`);
  }
}

function assertSecretHandle(handle: ZatcaFatooraSecretHandle): void {
  assertNonEmpty('secret provider', handle.provider);
  assertNonEmpty('secret id', handle.secretId);
}

function assertSigningKey(key: ZatcaSigningKeyHandle): void {
  assertNonEmpty('key provider', key.provider);
  assertNonEmpty('key id', key.keyId);
  if (key.exportable !== false) {
    throw new ZatcaCsidProvisioningError('ZATCA provisioning requires a non-exportable key.');
  }
}
