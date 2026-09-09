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
  "not(//ancestor-or-self::ext:UBLExtensions)",
  'not(//ancestor-or-self::cac:Signature)',
  "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])",
] as const;

const SHA256_BYTES = 32;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const ABSOLUTE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export interface ZatcaSignedInfoInput {
  /** Raw SHA-256 digest of the transformed/canonical invoice from Gate 38. */
  readonly invoiceDigest: Uint8Array;
  /** Raw SHA-256 digest of the final, context-canonicalized SignedProperties node. */
  readonly signedPropertiesDigest: Uint8Array;
}

/**
 * Build the deterministic XMLDSIG SignedInfo structure required by Gate 39.
 *
 * This function does NOT claim that the returned string is the byte sequence to
 * sign. SignedInfo must be inserted into its final namespace context and then
 * canonicalized before the signing port receives it. Keeping rendering and
 * canonicalization separate prevents a standalone fragment from silently
 * omitting inherited namespace nodes that inclusive C14N 1.1 would preserve.
 */
export function renderZatcaSignedInfoXml(input: ZatcaSignedInfoInput): string {
  const invoiceDigest = sha256DigestBase64(input.invoiceDigest, 'invoice');
  const signedPropertiesDigest = sha256DigestBase64(
    input.signedPropertiesDigest,
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
  /** Signing certificate first, followed by every chain certificate through the trust anchor. */
  readonly certificatePathDer: readonly Uint8Array[];
  /** Explicit, authoritative identifier of the signature policy. Never invented by this builder. */
  readonly signaturePolicyIdentifier: string;
  /** Raw SHA-256 digest of the exact signature-policy document identified above. */
  readonly signaturePolicyDigest: Uint8Array;
}

/**
 * Build XAdES SignedProperties for the final signature context.
 *
 * ZATCA v1.2 requires SigningCertificateV2 to cover the signing certificate and
 * every certificate in its path including the trust anchor. XAdES defines each
 * CertDigest as SHA-256 over the complete DER certificate, Base64 encoded. The
 * explicit policy identifier and its digest are supplied by an authoritative
 * onboarding/configuration source: this function will not fabricate either.
 *
 * As with SignedInfo, this is XML rendering, not canonicalization. The exact
 * SignedProperties node must be canonicalized in its final namespace context
 * before its digest is placed into SignedInfo.
 */
export async function renderZatcaSignedPropertiesXml(
  input: ZatcaSignedPropertiesInput,
): Promise<string> {
  assertUtcSecond('XAdES signing time', input.signingTime);
  if (input.certificatePathDer.length === 0) {
    throw new ZatcaInvoiceError(
      'ZATCA SigningCertificateV2 requires the signing certificate and its certificate path.',
    );
  }
  if (!ABSOLUTE_IDENTIFIER.test(input.signaturePolicyIdentifier)) {
    throw new ZatcaInvoiceError('ZATCA XAdES signature policy identifier must be an absolute identifier.');
  }

  const policyDigest = sha256DigestBase64(input.signaturePolicyDigest, 'signature policy');
  const certificates: string[] = [];
  for (const certificateDer of input.certificatePathDer) {
    if (certificateDer.length === 0) {
      throw new ZatcaInvoiceError('ZATCA SigningCertificateV2 cannot reference an empty certificate.');
    }
    const certificateDigest = bytesToBase64(await sha256(certificateDer));
    certificates.push(
      [
        '<xades:Cert>',
        '<xades:CertDigest>',
        `<ds:DigestMethod Algorithm="${XMLDSIG_SHA256_ALGORITHM}"></ds:DigestMethod>`,
        `<ds:DigestValue>${certificateDigest}</ds:DigestValue>`,
        '</xades:CertDigest>',
        '</xades:Cert>',
      ].join(''),
    );
  }

  return [
    `<xades:SignedProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" xmlns:ds="${XMLDSIG_NAMESPACE}" Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    '<xades:SignedSignatureProperties>',
    `<xades:SigningTime>${input.signingTime}</xades:SigningTime>`,
    '<xades:SigningCertificateV2>',
    ...certificates,
    '</xades:SigningCertificateV2>',
    '<xades:SignaturePolicyIdentifier>',
    '<xades:SignaturePolicyId>',
    '<xades:SigPolicyId>',
    `<xades:Identifier>${escapeXmlText(input.signaturePolicyIdentifier)}</xades:Identifier>`,
    '</xades:SigPolicyId>',
    '<xades:SigPolicyHash>',
    `<ds:DigestMethod Algorithm="${XMLDSIG_SHA256_ALGORITHM}"></ds:DigestMethod>`,
    `<ds:DigestValue>${policyDigest}</ds:DigestValue>`,
    '</xades:SigPolicyHash>',
    '</xades:SignaturePolicyId>',
    '</xades:SignaturePolicyIdentifier>',
    '</xades:SignedSignatureProperties>',
    '<xades:SignedDataObjectProperties>',
    `<xades:DataObjectFormat ObjectReference="#${ZATCA_INVOICE_REFERENCE_ID}">`,
    '<xades:MimeType>text/xml</xades:MimeType>',
    '</xades:DataObjectFormat>',
    '</xades:SignedDataObjectProperties>',
    '</xades:SignedProperties>',
  ].join('');
}

function sha256DigestBase64(bytes: Uint8Array, label: string): string {
  if (bytes.length !== SHA256_BYTES) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be exactly ${String(SHA256_BYTES)} bytes.`,
    );
  }
  return bytesToBase64(Uint8Array.from(bytes));
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
