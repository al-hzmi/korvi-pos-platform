import { bytesToBase64 } from './base64.js';
import { ZatcaInvoiceError } from './phase2.js';
import {
  XMLDSIG_NAMESPACE,
  ZATCA_XADES_NAMESPACE,
  type ZatcaSignedInfoInput,
  type ZatcaSignedPropertiesInput,
  renderZatcaSignedInfoXml,
  renderZatcaSignedPropertiesXml,
} from './xades.js';

export const ZATCA_UBL_SIGNATURE_INFORMATION_ID =
  'urn:oasis:names:specification:ubl:signature:1' as const;
export const ZATCA_UBL_REFERENCED_SIGNATURE_ID =
  'urn:oasis:names:specification:ubl:signature:Invoice' as const;
export const ZATCA_UBL_SIGNATURE_METHOD =
  'urn:oasis:names:specification:ubl:dsig:enveloped:xades' as const;
export const ZATCA_XML_SIGNATURE_ID = 'signature' as const;

const UBL_SIGNATURE_COMPONENTS_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2';
const UBL_SIGNATURE_AGGREGATE_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2';
const UBL_SIGNATURE_BASIC_NAMESPACE =
  'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_QR_BASE64_CHARACTERS = 700;

export interface ZatcaUblSignatureEnvelopeInput {
  readonly signedInfoXml: string;
  readonly signedPropertiesXml: string;
  readonly certificatePathDer: readonly Uint8Array[];
  /** Empty only while building the pre-signing canonicalization skeleton. */
  readonly signatureValueBase64: string;
}

/**
 * Render the UBL extension that carries one XAdES-B-B signature.
 *
 * BR-KSA-28/29/30 identifiers are constants rather than caller-controlled data.
 * The caller supplies the already-verified certificate path with the signing leaf first.
 * Fatoora ds:X509Data serializes only that signing certificate; intermediates and the
 * pinned trust anchor remain trust-validation inputs and are never duplicated into XML.
 * No private key or FATOORA secret can enter this renderer.
 */
export function renderZatcaUblSignatureExtension(input: ZatcaUblSignatureEnvelopeInput): string {
  assertGeneratedFragment('SignedInfo', input.signedInfoXml, '<ds:SignedInfo', '</ds:SignedInfo>');
  assertGeneratedFragment(
    'SignedProperties',
    input.signedPropertiesXml,
    '<xades:SignedProperties',
    '</xades:SignedProperties>',
  );
  if (input.certificatePathDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA X509Data requires the signing certificate path.');
  }
  if (input.signatureValueBase64 !== '') {
    assertBase64('XML SignatureValue', input.signatureValueBase64);
  }

  const signingCertificateDer = input.certificatePathDer[0];
  if (signingCertificateDer === undefined || signingCertificateDer.length === 0) {
    throw new ZatcaInvoiceError('ZATCA X509Data requires a non-empty signing certificate.');
  }
  const signingCertificate = `<ds:X509Certificate>${bytesToBase64(
    Uint8Array.from(signingCertificateDer),
  )}</ds:X509Certificate>`;

  return [
    '<ext:UBLExtensions>',
    '<ext:UBLExtension>',
    `<ext:ExtensionURI>${ZATCA_UBL_SIGNATURE_METHOD}</ext:ExtensionURI>`,
    '<ext:ExtensionContent>',
    `<sig:UBLDocumentSignatures xmlns:sig="${UBL_SIGNATURE_COMPONENTS_NAMESPACE}" xmlns:sac="${UBL_SIGNATURE_AGGREGATE_NAMESPACE}" xmlns:sbc="${UBL_SIGNATURE_BASIC_NAMESPACE}">`,
    '<sac:SignatureInformation>',
    `<cbc:ID>${ZATCA_UBL_SIGNATURE_INFORMATION_ID}</cbc:ID>`,
    `<sbc:ReferencedSignatureID>${ZATCA_UBL_REFERENCED_SIGNATURE_ID}</sbc:ReferencedSignatureID>`,
    `<ds:Signature xmlns:ds="${XMLDSIG_NAMESPACE}" Id="${ZATCA_XML_SIGNATURE_ID}">`,
    input.signedInfoXml,
    `<ds:SignatureValue>${input.signatureValueBase64}</ds:SignatureValue>`,
    '<ds:KeyInfo><ds:X509Data>',
    signingCertificate,
    '</ds:X509Data></ds:KeyInfo>',
    '<ds:Object>',
    `<xades:QualifyingProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" Target="#${ZATCA_XML_SIGNATURE_ID}">`,
    input.signedPropertiesXml,
    '</xades:QualifyingProperties>',
    '</ds:Object>',
    '</ds:Signature>',
    '</sac:SignatureInformation>',
    '</sig:UBLDocumentSignatures>',
    '</ext:ExtensionContent>',
    '</ext:UBLExtension>',
    '</ext:UBLExtensions>',
  ].join('');
}

/** Build the fixed UBL cac:Signature pointer required alongside the extension. */
export function renderZatcaCacSignature(): string {
  return [
    '<cac:Signature>',
    `<cbc:ID>${ZATCA_UBL_REFERENCED_SIGNATURE_ID}</cbc:ID>`,
    `<cbc:SignatureMethod>${ZATCA_UBL_SIGNATURE_METHOD}</cbc:SignatureMethod>`,
    '</cac:Signature>',
  ].join('');
}

/** Build the QR AdditionalDocumentReference using an already validated TLV/Base64 payload. */
export function renderZatcaQrDocumentReference(qrCodeBase64: string): string {
  assertBase64('QR code', qrCodeBase64);
  if (qrCodeBase64.length > MAX_QR_BASE64_CHARACTERS) {
    throw new ZatcaInvoiceError(
      `ZATCA QR code exceeds ${String(MAX_QR_BASE64_CHARACTERS)} Base64 characters.`,
    );
  }
  return [
    '<cac:AdditionalDocumentReference>',
    '<cbc:ID>QR</cbc:ID>',
    '<cac:Attachment>',
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrCodeBase64}</cbc:EmbeddedDocumentBinaryObject>`,
    '</cac:Attachment>',
    '</cac:AdditionalDocumentReference>',
  ].join('');
}

export interface AssembleZatcaSimplifiedInvoiceInput {
  /** Unsigned canonical business XML produced by Gate 38. */
  readonly unsignedInvoiceXml: string;
  readonly signatureExtensionXml: string;
  /** Omit while canonicalizing pre-QR signing structures; insert only after QR is final. */
  readonly qrCodeBase64?: string;
}

/**
 * Assemble the final UBL document without re-rendering any business facts.
 *
 * UBLExtensions is inserted as the first child. QR and cac:Signature are inserted
 * immediately before AccountingSupplierParty, after the existing ICV/PIH document
 * references, which is the UBL 2.1 order used by ZATCA. The invoice-reference
 * canonicalizer independently proves these three nodes are excluded from the hash.
 */
export function assembleZatcaSimplifiedInvoice(input: AssembleZatcaSimplifiedInvoiceInput): string {
  const xml = input.unsignedInvoiceXml;
  if (!xml.startsWith('<Invoice ') || !xml.endsWith('</Invoice>')) {
    throw new ZatcaInvoiceError('ZATCA sealing requires the Gate 38 UBL Invoice document.');
  }
  for (const forbidden of ['<ext:UBLExtensions>', '<cac:Signature>', '<cbc:ID>QR</cbc:ID>']) {
    if (xml.includes(forbidden)) {
      throw new ZatcaInvoiceError(
        'ZATCA sealing refuses unsigned input that already contains signature or QR material.',
      );
    }
  }
  assertGeneratedFragment(
    'signature extension',
    input.signatureExtensionXml,
    '<ext:UBLExtensions>',
    '</ext:UBLExtensions>',
  );

  const rootEnd = xml.indexOf('>');
  if (rootEnd < 0) {
    throw new ZatcaInvoiceError('ZATCA Invoice root start tag is malformed.');
  }
  const supplierAnchor = '<cac:AccountingSupplierParty>';
  const supplierIndex = xml.indexOf(supplierAnchor, rootEnd + 1);
  if (supplierIndex < 0 || xml.indexOf(supplierAnchor, supplierIndex + 1) >= 0) {
    throw new ZatcaInvoiceError(
      'ZATCA sealing requires one unambiguous AccountingSupplierParty insertion anchor.',
    );
  }

  const beforeSupplier = xml.slice(rootEnd + 1, supplierIndex);
  const afterSupplier = xml.slice(supplierIndex);
  const qr =
    input.qrCodeBase64 === undefined ? '' : renderZatcaQrDocumentReference(input.qrCodeBase64);
  return [
    xml.slice(0, rootEnd + 1),
    input.signatureExtensionXml,
    beforeSupplier,
    qr,
    renderZatcaCacSignature(),
    afterSupplier,
  ].join('');
}

export interface ZatcaSignatureSkeletonInput {
  readonly signedInfo: ZatcaSignedInfoInput;
  readonly signedProperties: ZatcaSignedPropertiesInput;
  readonly certificatePathDer: readonly Uint8Array[];
}

/** Convenience builder for the context-complete pre-signing XML skeleton. */
export async function buildZatcaSignatureSkeleton(
  unsignedInvoiceXml: string,
  input: ZatcaSignatureSkeletonInput,
): Promise<string> {
  const signedPropertiesXml = await renderZatcaSignedPropertiesXml(input.signedProperties);
  const signedInfoXml = renderZatcaSignedInfoXml(input.signedInfo);
  const signatureExtensionXml = renderZatcaUblSignatureExtension({
    signedInfoXml,
    signedPropertiesXml,
    certificatePathDer: input.certificatePathDer,
    signatureValueBase64: '',
  });
  return assembleZatcaSimplifiedInvoice({ unsignedInvoiceXml, signatureExtensionXml });
}

function assertGeneratedFragment(
  label: string,
  xml: string,
  openingPrefix: string,
  closingTag: string,
): void {
  if (
    !xml.startsWith(openingPrefix) ||
    !xml.endsWith(closingTag) ||
    xml.includes('<?xml') ||
    xml.includes('<!DOCTYPE')
  ) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is not the expected generated XML fragment.`);
  }
}

function assertBase64(label: string, value: string): void {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be canonical non-empty Base64.`);
  }
}
