import { describe, expect, it } from 'vitest';
import {
  ZATCA_UBL_REFERENCED_SIGNATURE_ID,
  ZATCA_UBL_SIGNATURE_INFORMATION_ID,
  ZATCA_UBL_SIGNATURE_METHOD,
  ZATCA_XML_SIGNATURE_ID,
  assembleZatcaSimplifiedInvoice,
  buildZatcaSignatureSkeleton,
  renderZatcaCacSignature,
  renderZatcaQrDocumentReference,
  renderZatcaUblSignatureExtension,
} from '../xades-envelope.js';
import { renderZatcaSignedInfoXml, renderZatcaSignedPropertiesXml } from '../xades.js';
import { ZatcaInvoiceError } from '../phase2.js';

const INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const certificatePathDer = [
  Uint8Array.from([0x30, 0x01, 0x01]),
  Uint8Array.from([0x30, 0x01, 0x02]),
];
const signedPropertiesDigestHex = '02'.repeat(32);

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function unsignedInvoice(): string {
  return [
    `<Invoice xmlns="${INVOICE_NS}" xmlns:cac="${CAC_NS}" xmlns:cbc="${CBC_NS}" xmlns:ext="${EXT_NS}">`,
    '<cbc:ProfileID>reporting:1.0</cbc:ProfileID>',
    '<cbc:ID>INV-39</cbc:ID>',
    '<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>39</cbc:UUID></cac:AdditionalDocumentReference>',
    '<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment></cac:Attachment></cac:AdditionalDocumentReference>',
    '<cac:AccountingSupplierParty><cac:Party></cac:Party></cac:AccountingSupplierParty>',
    '</Invoice>',
  ].join('');
}

async function signatureFragments() {
  const signedInfoXml = renderZatcaSignedInfoXml({
    invoiceDigest: digest(1),
    signedPropertiesDigestHex,
  });
  const signedPropertiesXml = await renderZatcaSignedPropertiesXml({
    signingTime: '2026-09-10T00:00:00Z',
    signingCertificateDer: certificatePathDer[0] as Uint8Array,
    issuerName: 'CN=Korvi Test Issuer, O=Korvi Test, C=SA',
    serialNumber: '123456789',
  });
  return { signedInfoXml, signedPropertiesXml };
}

describe('ZATCA UBL XAdES envelope', () => {
  it('pins BR-KSA-28/29/30 identifiers and serializes only the signing leaf in X509Data', async () => {
    const fragments = await signatureFragments();
    const extension = renderZatcaUblSignatureExtension({
      ...fragments,
      certificatePathDer,
      signatureValueBase64: 'AQIDBA==',
    });

    expect(extension).toContain(`<cbc:ID>${ZATCA_UBL_SIGNATURE_INFORMATION_ID}</cbc:ID>`);
    expect(extension).toContain(
      `<sbc:ReferencedSignatureID>${ZATCA_UBL_REFERENCED_SIGNATURE_ID}</sbc:ReferencedSignatureID>`,
    );
    expect(extension).toContain(
      `<ext:ExtensionURI>${ZATCA_UBL_SIGNATURE_METHOD}</ext:ExtensionURI>`,
    );
    expect(extension).toContain(
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${ZATCA_XML_SIGNATURE_ID}">`,
    );
    expect(extension).toContain(
      `<xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${ZATCA_XML_SIGNATURE_ID}">`,
    );
    expect(extension.match(/<ds:X509Certificate>/g)).toHaveLength(1);
    expect(extension).toContain('<ds:X509Certificate>MAEB</ds:X509Certificate>');
    expect(extension).not.toContain('MAEC');
  });

  it('emits the required cac:Signature authority pointer', () => {
    expect(renderZatcaCacSignature()).toBe(
      `<cac:Signature><cbc:ID>${ZATCA_UBL_REFERENCED_SIGNATURE_ID}</cbc:ID><cbc:SignatureMethod>${ZATCA_UBL_SIGNATURE_METHOD}</cbc:SignatureMethod></cac:Signature>`,
    );
  });

  it('places UBLExtensions first and QR then cac:Signature immediately before supplier', async () => {
    const fragments = await signatureFragments();
    const extension = renderZatcaUblSignatureExtension({
      ...fragments,
      certificatePathDer,
      signatureValueBase64: 'AQIDBA==',
    });
    const qr = 'AQFL';
    const finalXml = assembleZatcaSimplifiedInvoice({
      unsignedInvoiceXml: unsignedInvoice(),
      signatureExtensionXml: extension,
      qrCodeBase64: qr,
    });

    const rootEnd = finalXml.indexOf('>');
    expect(finalXml.indexOf('<ext:UBLExtensions>')).toBe(rootEnd + 1);
    const pih = finalXml.indexOf('<cbc:ID>PIH</cbc:ID>');
    const qrIndex = finalXml.indexOf('<cbc:ID>QR</cbc:ID>');
    const signature = finalXml.indexOf('<cac:Signature>');
    const supplier = finalXml.indexOf('<cac:AccountingSupplierParty>');
    expect(pih).toBeLessThan(qrIndex);
    expect(qrIndex).toBeLessThan(signature);
    expect(signature).toBeLessThan(supplier);
  });

  it('creates a unique context-complete pre-signing skeleton with an empty SignatureValue', async () => {
    const skeleton = await buildZatcaSignatureSkeleton(unsignedInvoice(), {
      signedInfo: { invoiceDigest: digest(1), signedPropertiesDigestHex },
      signedProperties: {
        signingTime: '2026-09-10T00:00:00Z',
        signingCertificateDer: certificatePathDer[0] as Uint8Array,
        issuerName: 'CN=Korvi Test Issuer, O=Korvi Test, C=SA',
        serialNumber: '123456789',
      },
      certificatePathDer,
    });

    expect(skeleton.match(/<ds:SignedInfo\b/g)).toHaveLength(1);
    expect(skeleton.match(/<xades:SignedProperties\b/g)).toHaveLength(1);
    expect(skeleton).toContain('<ds:SignatureValue></ds:SignatureValue>');
    expect(skeleton).not.toContain('<cbc:ID>QR</cbc:ID>');
  });

  it('rejects pre-sealed input instead of creating duplicate signature authority', async () => {
    const fragments = await signatureFragments();
    const extension = renderZatcaUblSignatureExtension({
      ...fragments,
      certificatePathDer,
      signatureValueBase64: 'AQIDBA==',
    });
    for (const injected of [
      '<ext:UBLExtensions></ext:UBLExtensions>',
      '<cac:Signature></cac:Signature>',
      '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID></cac:AdditionalDocumentReference>',
    ]) {
      const input = unsignedInvoice().replace('<cbc:ProfileID>', `${injected}<cbc:ProfileID>`);
      expect(() =>
        assembleZatcaSimplifiedInvoice({
          unsignedInvoiceXml: input,
          signatureExtensionXml: extension,
        }),
      ).toThrow(ZatcaInvoiceError);
    }
  });

  it('refuses empty certificates and invalid/oversized QR Base64', async () => {
    const fragments = await signatureFragments();
    expect(() =>
      renderZatcaUblSignatureExtension({
        ...fragments,
        certificatePathDer: [new Uint8Array(0)],
        signatureValueBase64: 'AQIDBA==',
      }),
    ).toThrow(/non-empty signing certificate/);
    expect(() => renderZatcaQrDocumentReference('not base64')).toThrow(/Base64/);
    expect(() => renderZatcaQrDocumentReference('A'.repeat(704))).toThrow(/700/);
  });
});
