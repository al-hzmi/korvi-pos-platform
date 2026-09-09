import { bytesToBase64 } from './base64.js';
import { ZatcaInvoiceError } from './phase2.js';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  type ZatcaSigningKeyDescription,
  type ZatcaSigningKeyHandle,
} from '../ports/zatca.js';
import type { TenantScope } from '../ports/persistence.js';

const SHA256_BYTES = 32;
const MAX_CRL_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export type ZatcaCredentialLifecycleState = 'active' | 'superseded' | 'revoked';
export type ZatcaRevocationStatus = 'good' | 'revoked' | 'unknown';
export type ZatcaRevocationSource = 'crl' | 'ocsp';

/**
 * Public certificate facts retained for one certificate in the CSID path.
 * The first entry is always the signing certificate and the remaining entries
 * are its path, in order, through the trust anchor.
 */
export interface ZatcaCertificatePathEntry {
  readonly certificateDer: Uint8Array;
  readonly issuerName: string;
  /** Positive decimal X.509 certificate serial number. */
  readonly serialNumber: string;
}

/**
 * Reference to the FATOORA API secret without carrying the secret value.
 *
 * Gate 40 may resolve this handle inside a dedicated secret provider. Raw
 * activation/API secret bytes are intentionally absent from all Gate 39 domain
 * values so logs, database rows and browser state cannot accidentally gain them.
 */
export interface ZatcaFatooraSecretHandle {
  readonly provider: string;
  readonly secretId: string;
}

/** Fresh certificate-status evidence produced by a CRL/OCSP adapter. */
export interface ZatcaCertificateStatusEvidence {
  /** Base64 SHA-256 of the complete DER signing certificate. */
  readonly certificateSha256: string;
  readonly status: ZatcaRevocationStatus;
  readonly source: ZatcaRevocationSource;
  readonly checkedAt: string;
  /** Last instant for which the evidence may be trusted without refreshing. */
  readonly validUntil: string;
}

/**
 * Public/non-secret CSID binding for one Korvi terminal.
 *
 * A binding may be persisted, but it never contains raw private-key or FATOORA
 * secret material. The key is addressed only by the non-exportable provider
 * handle and is re-described immediately before stamping.
 */
export interface ZatcaCsidBinding {
  readonly credentialId: string;
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly state: ZatcaCredentialLifecycleState;
  readonly key: ZatcaSigningKeyHandle;
  readonly certificatePath: readonly ZatcaCertificatePathEntry[];
  /** SPKI extracted from the signing certificate by the certificate adapter. */
  readonly signingPublicKeySpkiDer: Uint8Array;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly revocation: ZatcaCertificateStatusEvidence;
  readonly fatooraSecret: ZatcaFatooraSecretHandle;
}

export interface ZatcaCsidStampingContext {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly at: string;
  /** Fresh provider description of the opaque key handle used for this stamp. */
  readonly keyDescription: ZatcaSigningKeyDescription;
  readonly binding: ZatcaCsidBinding;
}

export interface ValidatedZatcaCsid {
  readonly credentialId: string;
  readonly key: ZatcaSigningKeyHandle;
  readonly signingCertificate: ZatcaCertificatePathEntry;
  readonly certificatePath: readonly ZatcaCertificatePathEntry[];
  readonly signingPublicKeySpkiDer: Uint8Array;
  readonly fatooraSecret: ZatcaFatooraSecretHandle;
}

/**
 * Fail closed unless the exact CSID/key/certificate status is usable *now*.
 *
 * ZATCA's current security standard requires certificate validity/revocation
 * checking before stamping and allows CRLs to cover at most seven days of
 * offline operation. This authority therefore refuses missing, stale, unknown,
 * revoked, superseded, tenant-mismatched or key-mismatched credentials before
 * the signing port can be invoked.
 */
export async function validateZatcaCsidForStamping(
  input: ZatcaCsidStampingContext,
): Promise<ValidatedZatcaCsid> {
  const { binding } = input;
  const now = parseUtcInstant('stamping time', input.at);
  const notBefore = parseUtcInstant('certificate notBefore', binding.notBefore);
  const notAfter = parseUtcInstant('certificate notAfter', binding.notAfter);

  if (binding.credentialId.trim() === '') {
    throw new ZatcaInvoiceError('ZATCA CSID credential id is required.');
  }
  if (binding.scope.tenantId !== input.scope.tenantId) {
    throw new ZatcaInvoiceError('ZATCA CSID belongs to a different tenant.');
  }
  if (binding.terminalId !== input.terminalId) {
    throw new ZatcaInvoiceError('ZATCA CSID belongs to a different terminal.');
  }
  if (binding.state !== 'active') {
    throw new ZatcaInvoiceError(`ZATCA CSID is ${binding.state} and cannot stamp invoices.`);
  }
  if (now < notBefore || now > notAfter) {
    throw new ZatcaInvoiceError('ZATCA CSID certificate is outside its validity window.');
  }

  assertKeyHandle(binding.key, 'bound key');
  assertKeyHandle(input.keyDescription.handle, 'described key');
  if (!sameKeyHandle(binding.key, input.keyDescription.handle)) {
    throw new ZatcaInvoiceError(
      'ZATCA signing provider resolved a different key than the CSID binding.',
    );
  }

  if (binding.certificatePath.length === 0) {
    throw new ZatcaInvoiceError(
      'ZATCA CSID certificate path must include the signing certificate.',
    );
  }
  const signingCertificate = binding.certificatePath[0];
  if (signingCertificate === undefined) {
    throw new ZatcaInvoiceError('ZATCA CSID signing certificate is missing.');
  }
  for (const certificate of binding.certificatePath) {
    assertCertificatePathEntry(certificate);
  }
  if (binding.signingPublicKeySpkiDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA signing certificate public key is missing.');
  }
  if (!bytesEqual(binding.signingPublicKeySpkiDer, input.keyDescription.publicKeySpkiDer)) {
    throw new ZatcaInvoiceError('ZATCA CSID certificate is not bound to the resolved signing key.');
  }

  assertOpaqueSecretHandle(binding.fatooraSecret);
  await assertRevocationEvidence(binding.revocation, signingCertificate.certificateDer, now);

  return {
    credentialId: binding.credentialId,
    key: binding.key,
    signingCertificate: copyCertificate(signingCertificate),
    certificatePath: binding.certificatePath.map(copyCertificate),
    signingPublicKeySpkiDer: Uint8Array.from(binding.signingPublicKeySpkiDer),
    fatooraSecret: { ...binding.fatooraSecret },
  };
}

function assertKeyHandle(handle: ZatcaSigningKeyHandle, label: string): void {
  if (handle.provider.trim() === '' || handle.keyId.trim() === '') {
    throw new ZatcaInvoiceError(`ZATCA ${label} must identify a signing provider key.`);
  }
  if (handle.curve !== ZATCA_SIGNING_CURVE || handle.algorithm !== ZATCA_SIGNING_ALGORITHM) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} does not use the required secp256k1/SHA-256 profile.`,
    );
  }
  if (handle.exportable !== false) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be non-exportable.`);
  }
}

function sameKeyHandle(left: ZatcaSigningKeyHandle, right: ZatcaSigningKeyHandle): boolean {
  return (
    left.provider === right.provider &&
    left.keyId === right.keyId &&
    left.curve === right.curve &&
    left.algorithm === right.algorithm &&
    left.exportable === right.exportable
  );
}

function assertCertificatePathEntry(entry: ZatcaCertificatePathEntry): void {
  if (entry.certificateDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA certificate path contains an empty certificate.');
  }
  if (entry.issuerName.trim() === '') {
    throw new ZatcaInvoiceError('ZATCA certificate path contains a blank issuer name.');
  }
  if (!/^[1-9]\d*$/.test(entry.serialNumber)) {
    throw new ZatcaInvoiceError(
      'ZATCA certificate serial number must be a positive decimal integer.',
    );
  }
}

function assertOpaqueSecretHandle(handle: ZatcaFatooraSecretHandle): void {
  if (handle.provider.trim() === '' || handle.secretId.trim() === '') {
    throw new ZatcaInvoiceError('ZATCA FATOORA secret handle is incomplete.');
  }
}

async function assertRevocationEvidence(
  evidence: ZatcaCertificateStatusEvidence,
  certificateDer: Uint8Array,
  stampingTime: number,
): Promise<void> {
  const checkedAt = parseUtcInstant('certificate status checkedAt', evidence.checkedAt);
  const validUntil = parseUtcInstant('certificate status validUntil', evidence.validUntil);
  if (validUntil < checkedAt) {
    throw new ZatcaInvoiceError('ZATCA certificate status evidence expires before it was checked.');
  }
  if (checkedAt > stampingTime || stampingTime > validUntil) {
    throw new ZatcaInvoiceError(
      'ZATCA certificate status evidence is not fresh for the stamping time.',
    );
  }
  if (evidence.source === 'crl' && validUntil - checkedAt > MAX_CRL_VALIDITY_MS) {
    throw new ZatcaInvoiceError(
      'ZATCA CRL evidence cannot authorize more than seven days offline.',
    );
  }
  if (evidence.status !== 'good') {
    throw new ZatcaInvoiceError(`ZATCA certificate revocation status is ${evidence.status}.`);
  }
  if (evidence.certificateSha256 !== (await sha256Base64(certificateDer))) {
    throw new ZatcaInvoiceError(
      'ZATCA certificate status evidence refers to a different certificate.',
    );
  }
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0) {
    throw new ZatcaInvoiceError('Cannot fingerprint an empty ZATCA certificate.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new ZatcaInvoiceError('Web Crypto SHA-256 is unavailable in this runtime.');
  }
  // Own the backing ArrayBuffer before crossing the WebCrypto BufferSource boundary.
  // A generic Uint8Array may legally wrap SharedArrayBuffer; certificate bytes must not.
  const ownedBytes = new Uint8Array(bytes.length);
  ownedBytes.set(bytes);
  const digest = await subtle.digest('SHA-256', ownedBytes);
  const result = new Uint8Array(digest);
  if (result.length !== SHA256_BYTES) {
    throw new ZatcaInvoiceError('Unexpected SHA-256 digest length for ZATCA certificate.');
  }
  return bytesToBase64(result);
}

function parseUtcInstant(label: string, value: string): number {
  const match = UTC_INSTANT.exec(value);
  if (match === null) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be an exact UTC ISO-8601 second.`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is incomplete.`);
  }
  const instant = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(instant);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is not a real UTC calendar instant.`);
  }
  return instant;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function copyCertificate(entry: ZatcaCertificatePathEntry): ZatcaCertificatePathEntry {
  return {
    certificateDer: Uint8Array.from(entry.certificateDer),
    issuerName: entry.issuerName,
    serialNumber: entry.serialNumber,
  };
}
