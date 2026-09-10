import { X509Certificate, createHash } from 'node:crypto';
import { ZatcaInvoiceError, type ZatcaCertificatePathEntry } from '@korvi/domain';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export interface ZatcaCertificatePathTrustInput {
  /** Signing certificate first, server-trusted ZATCA trust anchor last. */
  readonly certificatePath: readonly ZatcaCertificatePathEntry[];
  /** Exact lower-case SHA-256 DER fingerprints provisioned by trusted server configuration. */
  readonly trustedAnchorSha256Hex: readonly string[];
  /** Exact XAdES signing instant. */
  readonly at: string;
}

export interface VerifiedZatcaCertificatePath {
  readonly trustAnchorSha256Hex: string;
  readonly certificateSha256Hex: readonly string[];
  /** Fatoora display-order issuer name derived from the signing certificate DER. */
  readonly signingCertificateIssuerName: string;
  /** Positive decimal serial number derived from the signing certificate DER. */
  readonly signingCertificateSerialNumber: string;
}

/**
 * Verify the X.509 path independently of caller-controlled invoice data.
 *
 * The last certificate is accepted as a trust anchor only when its DER SHA-256
 * fingerprint is pinned by server configuration. Every certificate is validity
 * checked at the exact stamping instant and every child signature is verified by
 * the next CA key. Persisted issuer/serial metadata must describe the same DER
 * identity, but Fatoora display ordering is derived only from the certificate.
 */
export function verifyZatcaCertificatePath(
  input: ZatcaCertificatePathTrustInput,
): VerifiedZatcaCertificatePath {
  const at = parseUtcSecond(input.at);
  if (input.certificatePath.length < 2) {
    throw new ZatcaInvoiceError(
      'ZATCA certificate path must include a signing certificate and trust anchor.',
    );
  }
  if (input.trustedAnchorSha256Hex.length === 0) {
    throw new ZatcaInvoiceError('ZATCA trust-anchor configuration is empty.');
  }

  const trusted = new Set<string>();
  for (const fingerprint of input.trustedAnchorSha256Hex) {
    if (!SHA256_HEX.test(fingerprint)) {
      throw new ZatcaInvoiceError(
        'ZATCA trust-anchor SHA-256 fingerprints must be lower-case 64-character hex.',
      );
    }
    trusted.add(fingerprint);
  }

  const certificates = input.certificatePath.map((entry, index) => parseCertificate(entry, index));
  const fingerprints = certificates.map((certificate) =>
    createHash('sha256').update(certificate.raw).digest('hex'),
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new ZatcaInvoiceError('ZATCA certificate path contains a duplicate certificate or loop.');
  }

  for (let index = 0; index < certificates.length; index += 1) {
    const certificate = certificates[index];
    if (certificate === undefined) {
      throw new ZatcaInvoiceError('ZATCA certificate path is incomplete.');
    }
    assertCertificateValidity(certificate, at, index);

    if (index === certificates.length - 1) {
      const anchorFingerprint = fingerprints[index];
      if (anchorFingerprint === undefined || !trusted.has(anchorFingerprint)) {
        throw new ZatcaInvoiceError(
          'ZATCA certificate path does not terminate at a server-pinned trust anchor.',
        );
      }
      continue;
    }

    const issuer = certificates[index + 1];
    if (issuer === undefined) {
      throw new ZatcaInvoiceError('ZATCA certificate path issuer is missing.');
    }
    if (!issuer.ca) {
      throw new ZatcaInvoiceError(
        `ZATCA certificate path issuer at position ${String(index + 1)} is not a CA certificate.`,
      );
    }
    if (!certificate.checkIssued(issuer)) {
      throw new ZatcaInvoiceError(
        `ZATCA certificate at position ${String(index)} is not issued by the next path certificate.`,
      );
    }
    if (!certificate.verify(issuer.publicKey)) {
      throw new ZatcaInvoiceError(
        `ZATCA certificate signature verification failed at path position ${String(index)}.`,
      );
    }
  }

  const trustAnchorSha256Hex = fingerprints.at(-1);
  const signingCertificate = certificates[0];
  if (trustAnchorSha256Hex === undefined || signingCertificate === undefined) {
    throw new ZatcaInvoiceError('ZATCA verified certificate-path identity is unavailable.');
  }
  return {
    trustAnchorSha256Hex,
    certificateSha256Hex: [...fingerprints],
    signingCertificateIssuerName: fatooraIssuerName(signingCertificate.issuer),
    signingCertificateSerialNumber: BigInt(`0x${signingCertificate.serialNumber}`).toString(10),
  };
}

function parseCertificate(entry: ZatcaCertificatePathEntry, index: number): X509Certificate {
  try {
    const certificate = new X509Certificate(Buffer.from(entry.certificateDer));
    const serialDecimal = BigInt(`0x${certificate.serialNumber}`).toString(10);
    if (serialDecimal !== entry.serialNumber) {
      throw new ZatcaInvoiceError(
        `ZATCA certificate serial metadata diverges from DER at path position ${String(index)}.`,
      );
    }
    if (!sameIssuerIdentity(entry.issuerName, certificate.issuer)) {
      throw new ZatcaInvoiceError(
        `ZATCA certificate issuer metadata diverges from DER at path position ${String(index)}.`,
      );
    }
    return certificate;
  } catch (error) {
    if (error instanceof ZatcaInvoiceError) throw error;
    throw new ZatcaInvoiceError(
      `ZATCA certificate DER is invalid at path position ${String(index)}.`,
    );
  }
}

/**
 * Node exposes issuer RDNs in certificate order; Fatoora serializes them in the
 * reverse, most-specific display order. The DER-backed Node value is the only
 * source used for the emitted X509IssuerName.
 */
function fatooraIssuerName(nodeIssuer: string): string {
  const components = issuerComponents(nodeIssuer);
  if (components.length === 0) {
    throw new ZatcaInvoiceError('ZATCA signing certificate issuer name is empty.');
  }
  return [...components].reverse().join(', ');
}

function sameIssuerIdentity(persisted: string, certificateIssuer: string): boolean {
  const left = issuerComponents(persisted).sort();
  const right = issuerComponents(certificateIssuer).sort();
  return left.length === right.length && left.every((component, index) => component === right[index]);
}

/** Split DN text on newlines or unescaped commas without corrupting escaped values. */
function issuerComponents(value: string): string[] {
  if (/\r?\n/.test(value)) {
    return value
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (character === ',' && !escaped) {
      const part = current.trim();
      if (part.length > 0) parts.push(part);
      current = '';
      continue;
    }
    current += character;
    if (character === '\\') {
      escaped = !escaped;
    } else {
      escaped = false;
    }
  }
  const finalPart = current.trim();
  if (finalPart.length > 0) parts.push(finalPart);
  return parts;
}

function assertCertificateValidity(certificate: X509Certificate, at: number, index: number): void {
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    throw new ZatcaInvoiceError(
      `ZATCA certificate validity cannot be parsed at path position ${String(index)}.`,
    );
  }
  if (at < notBefore || at > notAfter) {
    throw new ZatcaInvoiceError(
      `ZATCA certificate at path position ${String(index)} is outside its validity window.`,
    );
  }
}

function parseUtcSecond(value: string): number {
  const match = UTC_SECOND.exec(value);
  if (match === null) {
    throw new ZatcaInvoiceError(
      'ZATCA certificate-path validation time must be an exact UTC second.',
    );
  }
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new ZatcaInvoiceError('ZATCA certificate-path validation time is incomplete.');
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
    throw new ZatcaInvoiceError(
      'ZATCA certificate-path validation time is not a real UTC instant.',
    );
  }
  return instant;
}
