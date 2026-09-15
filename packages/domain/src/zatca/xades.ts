import { bytesToBase64 } from './base64.js';
import { ZatcaInvoiceError } from './phase2.js';

export const XMLDSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#' as const;
export const ZATCA_XADES_NAMESPACE = 'http://uri.etsi.org/01903/v1.3.2#' as const;
export const ZATCA_XADES_SIGNED_PROPERTIES_TYPE =
  'http://uri.etsi.org/01903#SignedProperties' as const;
export const ZATCA_C14N11_ALGORITHM = 'http://www.w3.org/2006/12/xml-c14n11' as const;
export const ZATCA_XPATH_ALGORITHM = 'http://www.w3.org/TR/1999/REC-xpath-19991116' as const;
export const XMLDSIG_SHA256_ALGORITHM = 'http://www.w3.org/2001/04/xmlenc#sha256' as const;
export const XMLDSIG_ECDSA_SHA256_ALGORITHM =
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' as const;

export const ZATCA_INVOICE_REFERENCE_ID = 'invoiceSignedData' as const;
export const ZATCA_SIGNED_PROPERTIES_ID = 'xadesSignedProperties' as const;

export const ZATCA_INVOICE_REFERENCE_TRANSFORMS = [
  'not(//ancestor-or-self::ext:UBLExtensions)',
  'not(//ancestor-or-self::cac:Signature)',
  "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])",
] as const;

const SHA256_BYTES = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const encoder = new TextEncoder();

export interface ZatcaSignedInfoInput {
  /** Raw SHA-256 digest of the transformed/canonical invoice from Gate 38. */
  readonly invoiceDigest: Uint8Array;
  /** Lower-case SHA-256 hex over the exact Fatoora SignedProperties hashing template. */
  readonly signedPropertiesDigestHex: string;
}

/**
 * Build the deterministic SignedInfo container used by Fatoora.
 *
 * Fatoora's cryptographic-stamp profile places the invoice digest and the
 * profile-specific SignedProperties digest here, while the ECDSA operation is
 * performed over the raw invoice-hash bytes themselves. Fatoora represents the
 * SignedProperties digest as Base64 of the lower-case hexadecimal SHA-256 text.
 */
export function renderZatcaSignedInfoXml(input: ZatcaSignedInfoInput): string {
  const invoiceDigest = sha256DigestBase64(input.invoiceDigest, 'invoice');
  const signedPropertiesDigest = sha256HexTextBase64(
    input.signedPropertiesDigestHex,
    'SignedProperties',
  );

  return [
    `<ds:SignedInfo xmlns:ds="${XMLDSIG_NAMESPACE}">`,
    `<ds:CanonicalizationMethod Algorithm="${ZATCA_C14N11_ALGORITHM}"></ds:CanonicalizationMethod>`,
    `<ds:SignatureMethod Algorithm="${XMLDSIG_ECDSA_SHA256_ALGORITHM}"></ds:SignatureMethod>`,
    `<ds:Reference Id="${ZATCA_INVOICE_REFERENCE_ID}" URI="">`,
    '<ds:Transforms>',
    ...ZATCA_INVOICE_REFERENCE_TRANSFORMS.flatMap((xpath) => [
      `<ds:Transform Algorithm="${ZATCA_XPATH_ALGORITHM}">`,
      `<ds:XPath>${xpath}</ds:XPath>`,
      '</ds:Transform>',
    ]),
    `<ds:Transform Algorithm="${ZATCA_C14N11_ALGORITHM}"></ds:Transform>`,
    '</ds:Transforms>',
    `<ds:DigestMethod Algorithm="${XMLDSIG_SHA256_ALGORITHM}"></ds:DigestMethod>`,
    `<ds:DigestValue>${invoiceDigest}</ds:DigestValue>`,
    '</ds:Reference>',
    `<ds:Reference Type="${ZATCA_XADES_SIGNED_PROPERTIES_TYPE}" URI="#${ZATCA_SIGNED_PROPERTIES_ID}">`,
    `<ds:DigestMethod Algorithm="${XMLDSIG_SHA256_ALGORITHM}"></ds:DigestMethod>`,
    `<ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue>`,
    '</ds:Reference>',
    '</ds:SignedInfo>',
  ].join('');
}

export interface ZatcaSignedPropertiesInput {
  /** Exact claimed signing instant. An ambient clock is never read here. */
  readonly signingTime: string;
  /** Exact DER signing certificate. Fatoora SignedProperties references the leaf certificate. */
  readonly signingCertificateDer: Uint8Array;
  /** Issuer name derived from the same DER certificate, in Fatoora display order. */
  readonly issuerName: string;
  /** Positive decimal serial number derived from the same DER certificate. */
  readonly serialNumber: string;
}

interface PreparedSignedProperties {
  readonly signingTime: string;
  readonly certificateDigest: string;
  readonly issuerName: string;
  readonly serialNumber: string;
}

/**
 * Render the SignedProperties block embedded in the final XML.
 *
 * The Fatoora validator inherits xades/ds namespaces from the surrounding
 * signature envelope. Keep this representation separate from the byte-exact
 * hashing template below: ZATCA's validator hashes a reconstructed template,
 * not a canonicalized copy of the embedded fragment.
 */
export async function renderZatcaSignedPropertiesXml(
  input: ZatcaSignedPropertiesInput,
): Promise<string> {
  return renderSignedPropertiesEmbedded(await prepareSignedProperties(input));
}

/**
 * Render the exact Fatoora SignedProperties template used as the SHA-256 input.
 *
 * These namespace declarations and indentation are compatibility bytes, not
 * cosmetic formatting. The official validator reconstructs this layout before
 * hashing. Any whitespace change intentionally changes the resulting digest.
 */
export async function renderZatcaSignedPropertiesHashInputXml(
  input: ZatcaSignedPropertiesInput,
): Promise<string> {
  return renderSignedPropertiesHashInput(await prepareSignedProperties(input));
}

/** Hash the byte-exact Fatoora SignedProperties compatibility template. */
export async function hashZatcaSignedPropertiesProfile(xml: string): Promise<string> {
  if (
    !xml.startsWith(
      `<xades:SignedProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    )
  ) {
    throw new ZatcaInvoiceError(
      'ZATCA SignedProperties hash input is not the generated Fatoora compatibility template.',
    );
  }
  return bytesToHex(await sha256(encoder.encode(xml)));
}

/**
 * Fatoora certificate digest value used inside SigningCertificate.
 * Hash input is the certificate's canonical unwrapped Base64 text, not DER bytes.
 */
export async function zatcaCertificateDigestValue(certificateDer: Uint8Array): Promise<string> {
  if (certificateDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA signing certificate DER must not be empty.');
  }
  const certificateBase64 = bytesToBase64(Uint8Array.from(certificateDer));
  const digestHex = bytesToHex(await sha256(encoder.encode(certificateBase64)));
  return bytesToBase64(encoder.encode(digestHex));
}

async function prepareSignedProperties(
  input: ZatcaSignedPropertiesInput,
): Promise<PreparedSignedProperties> {
  assertUtcSecond('XAdES signing time', input.signingTime);
  if (input.signingCertificateDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA SigningCertificate requires the signing certificate.');
  }
  if (input.issuerName.trim() === '') {
    throw new ZatcaInvoiceError('ZATCA X509IssuerName is required.');
  }
  if (!POSITIVE_DECIMAL.test(input.serialNumber)) {
    throw new ZatcaInvoiceError('ZATCA X509SerialNumber must be a positive decimal integer.');
  }
  return {
    signingTime: input.signingTime,
    certificateDigest: await zatcaCertificateDigestValue(input.signingCertificateDer),
    issuerName: escapeXmlText(input.issuerName),
    serialNumber: input.serialNumber,
  };
}

function renderSignedPropertiesEmbedded(input: PreparedSignedProperties): string {
  return [
    `<xades:SignedProperties Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    '                                    <xades:SignedSignatureProperties>',
    `                                        <xades:SigningTime>${input.signingTime}</xades:SigningTime>`,
    '                                        <xades:SigningCertificate>',
    '                                            <xades:Cert>',
    '                                                <xades:CertDigest>',
    `                                                    <ds:DigestMethod Algorithm="${XMLDSIG_SHA256_ALGORITHM}"/>`,
    `                                                    <ds:DigestValue>${input.certificateDigest}</ds:DigestValue>`,
    '                                                </xades:CertDigest>',
    '                                                <xades:IssuerSerial>',
    `                                                    <ds:X509IssuerName>${input.issuerName}</ds:X509IssuerName>`,
    `                                                    <ds:X509SerialNumber>${input.serialNumber}</ds:X509SerialNumber>`,
    '                                                </xades:IssuerSerial>',
    '                                            </xades:Cert>',
    '                                        </xades:SigningCertificate>',
    '                                    </xades:SignedSignatureProperties>',
    '                                </xades:SignedProperties>',
  ].join('\n');
}

function renderSignedPropertiesHashInput(input: PreparedSignedProperties): string {
  return [
    `<xades:SignedProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    '                                    <xades:SignedSignatureProperties>',
    `                                        <xades:SigningTime>${input.signingTime}</xades:SigningTime>`,
    '                                        <xades:SigningCertificate>',
    '                                            <xades:Cert>',
    '                                                <xades:CertDigest>',
    `                                                    <ds:DigestMethod xmlns:ds="${XMLDSIG_NAMESPACE}" Algorithm="${XMLDSIG_SHA256_ALGORITHM}"/>`,
    `                                                    <ds:DigestValue xmlns:ds="${XMLDSIG_NAMESPACE}">${input.certificateDigest}</ds:DigestValue>`,
    '                                                </xades:CertDigest>',
    '                                                <xades:IssuerSerial>',
    `                                                    <ds:X509IssuerName xmlns:ds="${XMLDSIG_NAMESPACE}">${input.issuerName}</ds:X509IssuerName>`,
    `                                                    <ds:X509SerialNumber xmlns:ds="${XMLDSIG_NAMESPACE}">${input.serialNumber}</ds:X509SerialNumber>`,
    '                                                </xades:IssuerSerial>',
    '                                            </xades:Cert>',
    '                                        </xades:SigningCertificate>',
    '                                    </xades:SignedSignatureProperties>',
    '                                </xades:SignedProperties>',
  ].join('\n');
}

function sha256DigestBase64(bytes: Uint8Array, label: string): string {
  if (bytes.length !== SHA256_BYTES) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be exactly ${String(SHA256_BYTES)} bytes.`,
    );
  }
  return bytesToBase64(Uint8Array.from(bytes));
}

function sha256HexTextBase64(hex: string, label: string): string {
  if (!SHA256_HEX.test(hex)) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be lower-case 64-character hex.`,
    );
  }
  return bytesToBase64(encoder.encode(hex));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new ZatcaInvoiceError('Web Crypto SHA-256 is unavailable for ZATCA XAdES.');
  }
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return new Uint8Array(await subtle.digest('SHA-256', owned));
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function assertUtcSecond(label: string, value: string): void {
  const match = UTC_SECOND.exec(value);
  if (match === null) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be an exact UTC ISO-8601 second.`);
  }
  const values = match.slice(1).map(Number);
  const year = values[0];
  const month = values[1];
  const day = values[2];
  const hour = values[3];
  const minute = values[4];
  const second = values[5];
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
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
