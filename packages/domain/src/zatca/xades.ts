import { bytesToBase64 } from './base64.js';
import { ZatcaInvoiceError } from './phase2.js';

export const XMLDSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#' as const;
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

function sha256DigestBase64(bytes: Uint8Array, label: string): string {
  if (bytes.length !== SHA256_BYTES) {
    throw new ZatcaInvoiceError(
      `ZATCA ${label} SHA-256 digest must be exactly ${String(SHA256_BYTES)} bytes.`,
    );
  }
  return bytesToBase64(Uint8Array.from(bytes));
}
