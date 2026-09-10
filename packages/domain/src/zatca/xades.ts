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
  /** Lower-case SHA-256 hex over the linearized Fatoora SignedProperties block. */
  readonly signedPropertiesDigestHex: string;
}

/**
 * Build the deterministic SignedInfo container used by Fatoora.
 *
 * Fatoora's cryptographic-stamp profile places the invoice digest and the
 * profile-specific SignedProperties digest here, while the ECDSA operation is
 * performed over the raw invoice-hash bytes themselves. The final SignedInfo is
 * still canonicalized and regression-proved so its XML representation cannot
 * drift silently.
 */
export function renderZatcaSignedInfoXml(input: ZatcaSignedInfoInput): string {
  const invoiceDigest = sha256DigestBase64(input.invoiceDigest, 'invoice');
  const signedPropertiesDigest = sha256HexAsDigestBase64(
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

/**
 * Render the SignedProperties shape accepted by the current Fatoora validator.
 *
 * This deliberately uses XAdES `SigningCertificate` + `IssuerSerial`. ZATCA's
 * public validator rejects `SigningCertificateV2` in the invoice XSD, while the
 * detailed signing guide populates these exact v1.3.2 elements. The certificate
 * digest follows Fatoora's profile: SHA-256 of the certificate's unwrapped
 * Base64 text -> lower-case hexadecimal -> Base64 of that hexadecimal text.
 */
export async function renderZatcaSignedPropertiesXml(
  input: ZatcaSignedPropertiesInput,
): Promise<string> {
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

  const certificateDigest = await zatcaCertificateDigestValue(input.signingCertificateDer);
  const issuerName = escapeXmlText(input.issuerName);

  return [
    `<xades:SignedProperties Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    '                                    <xades:SignedSignatureProperties>',
    `                                        <xades:SigningTime>${input.signingTime}</xades:SigningTime>`,
    '                                        <xades:SigningCertificate>',
    '                                            <xades:Cert>',
    '                                                <xades:CertDigest>',
    `                                                    <ds:DigestMethod xmlns:ds="${XMLDSIG_NAMESPACE}" Algorithm="${XMLDSIG_SHA256_ALGORITHM}"></ds:DigestMethod>`,
    `                                                    <ds:DigestValue xmlns:ds="${XMLDSIG_NAMESPACE}">${certificateDigest}</ds:DigestValue>`,
    '                                                </xades:CertDigest>',
    '                                                <xades:IssuerSerial>',
    `                                                    <ds:X509IssuerName xmlns:ds="${XMLDSIG_NAMESPACE}">${issuerName}</ds:X509IssuerName>`,
    `                                                    <ds:X509SerialNumber xmlns:ds="${XMLDSIG_NAMESPACE}">${input.serialNumber}</ds:X509SerialNumber>`,
    '                                                </xades:IssuerSerial>',
    '                                            </xades:Cert>',
    '                                        </xades:SigningCertificate>',
    '                                    </xades:SignedSignatureProperties>',
    '</xades:SignedProperties>',
  ].join('\n');
}

/**
 * Fatoora Step 5 SignedProperties hash.
 *
 * The guide requires the populated block to be linearized and formatting spaces
 * removed before SHA-256. We remove only inter-element formatting whitespace;
 * text-node spaces such as those inside X509IssuerName remain cryptographic data.
 */
export async function hashZatcaSignedPropertiesProfile(xml: string): Promise<string> {
  if (!xml.startsWith(`<xades:SignedProperties Id="${ZATCA_SIGNED_PROPERTIES_ID}">`)) {
    throw new ZatcaInvoiceError(
      'ZATCA SignedProperties profile input is not the generated fragment.',
    );
  }
  const linearized = xml.replace(/>\s+</g, '><');
  return bytesToHex(await sha256(encoder.encode(linearized)));
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

function sha256DigestBase64(bytes: Uint8Array, label: string): string {
  if (bytes.length !== SHA256_BYTES) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be exactly ${String(SHA256_BYTES)} bytes.`,
    );
  }
  return bytesToBase64(Uint8Array.from(bytes));
}

function sha256HexAsDigestBase64(hex: string, label: string): string {
  if (!SHA256_HEX.test(hex)) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be lower-case 64-character hex.`,
    );
  }
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
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
