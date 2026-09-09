import { describe, expect, it } from 'vitest';
import { ZatcaInvoiceError } from '@korvi/domain';
import { Libxml2ZatcaCanonicalizer } from '../zatca/libxml2-canonicalizer.js';

const INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';
const decoder = new TextDecoder();

function rootNamespaces(): string {
  return `xmlns="${INVOICE_NS}" xmlns:cac="${CAC_NS}" xmlns:cbc="${CBC_NS}" xmlns:ext="${EXT_NS}"`;
}

function businessOnly(id = 'INV-1'): string {
  return [
    `<Invoice ${rootNamespaces()}>`,
    `<cbc:ID>${id}</cbc:ID>`,
    '<cac:AdditionalDocumentReference><cbc:ID>KEEP</cbc:ID></cac:AdditionalDocumentReference>',
    '</Invoice>',
  ].join('');
}

function withExcludedSignatureMaterial(id = 'INV-1'): string {
  return [
    `<Invoice ${rootNamespaces()}>`,
    '<ext:UBLExtensions><ext:UBLExtension></ext:UBLExtension></ext:UBLExtensions>',
    `<cbc:ID>${id}</cbc:ID>`,
    '<cac:AdditionalDocumentReference><cbc:ID>KEEP</cbc:ID></cac:AdditionalDocumentReference>',
    '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment></cac:Attachment></cac:AdditionalDocumentReference>',
    '<cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID></cac:Signature>',
    '</Invoice>',
  ].join('');
}

function signatureDocument(options: { duplicateSignedInfo?: boolean; duplicateProperties?: boolean } = {}): string {
  const signedInfo = '<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="urn:test"></ds:CanonicalizationMethod></ds:SignedInfo>';
  const properties = [
    '<xades:SignedProperties Id="xadesSignedProperties">',
    '<xades:SignedSignatureProperties><xades:SigningTime>2026-09-10T00:00:00Z</xades:SigningTime></xades:SignedSignatureProperties>',
    '</xades:SignedProperties>',
  ].join('');

  return [
    `<Invoice ${rootNamespaces()} xmlns:ds="${DS_NS}" xmlns:xades="${XADES_NS}" xmlns:extra="urn:korvi:unused">`,
    '<cbc:ID>INV-1</cbc:ID>',
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>',
    '<ds:Signature Id="signature">',
    signedInfo,
    options.duplicateSignedInfo ? signedInfo : '',
    '<ds:Object><xades:QualifyingProperties Target="#signature">',
    properties,
    options.duplicateProperties ? properties : '',
    '</xades:QualifyingProperties></ds:Object>',
    '</ds:Signature>',
    '</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>',
    '</Invoice>',
  ].join('');
}

describe('libxml2 ZATCA Canonical XML 1.1 adapter', () => {
  const canonicalizer = new Libxml2ZatcaCanonicalizer();

  it('applies the exact invoice-reference exclusions before C14N 1.1', async () => {
    const xml = `${withExcludedSignatureMaterial().replace('</Invoice>', '<!--not-signed--></Invoice>')}`;
    const canonical = decoder.decode(await canonicalizer.canonicalizeInvoiceReference(xml));

    expect(canonical).toContain('<cbc:ID>INV-1</cbc:ID>');
    expect(canonical).toContain('<cbc:ID>KEEP</cbc:ID>');
    expect(canonical).not.toContain('UBLExtensions');
    expect(canonical).not.toContain('<cbc:ID>QR</cbc:ID>');
    expect(canonical).not.toContain('<cac:Signature>');
    expect(canonical).not.toContain('not-signed');
  });

  it('proves excluded signature/QR material cannot change the invoice-reference bytes', async () => {
    const unsigned = await canonicalizer.canonicalizeInvoiceReference(businessOnly());
    const sealedShape = await canonicalizer.canonicalizeInvoiceReference(withExcludedSignatureMaterial());
    expect(sealedShape).toEqual(unsigned);
  });

  it('proves a signed business-content mutation changes canonical bytes', async () => {
    const original = await canonicalizer.canonicalizeInvoiceReference(withExcludedSignatureMaterial('INV-1'));
    const mutated = await canonicalizer.canonicalizeInvoiceReference(withExcludedSignatureMaterial('INV-2'));
    expect(mutated).not.toEqual(original);
  });

  it('canonicalizes SignedInfo and SignedProperties only from their final signature context', async () => {
    const xml = signatureDocument();
    const signedInfo = decoder.decode(await canonicalizer.canonicalizeSignedInfo(xml));
    const signedProperties = decoder.decode(await canonicalizer.canonicalizeSignedProperties(xml));

    expect(signedInfo).toContain('<ds:SignedInfo');
    expect(signedInfo).toContain('xmlns:ds="http://www.w3.org/2000/09/xmldsig#"');
    expect(signedProperties).toContain('<xades:SignedProperties');
    expect(signedProperties).toContain('Id="xadesSignedProperties"');
    expect(signedProperties).toContain('xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"');
  });

  it('fails closed when signature targets are missing or duplicated', async () => {
    await expect(canonicalizer.canonicalizeSignedInfo(businessOnly())).rejects.toThrow(
      /one unambiguous ds:SignedInfo/,
    );
    await expect(canonicalizer.canonicalizeSignedProperties(businessOnly())).rejects.toThrow(
      /one unambiguous xades:SignedProperties/,
    );
    await expect(canonicalizer.canonicalizeSignedInfo(signatureDocument({ duplicateSignedInfo: true }))).rejects.toThrow(
      /one unambiguous ds:SignedInfo/,
    );
    await expect(
      canonicalizer.canonicalizeSignedProperties(signatureDocument({ duplicateProperties: true })),
    ).rejects.toThrow(/one unambiguous xades:SignedProperties/);
  });

  it('rejects malformed XML, non-Invoice roots and DTD/entity input', async () => {
    await expect(canonicalizer.canonicalizeInvoiceReference('<Invoice>')).rejects.toBeInstanceOf(
      ZatcaInvoiceError,
    );
    await expect(
      canonicalizer.canonicalizeInvoiceReference('<root><value>1</value></root>'),
    ).rejects.toThrow(/UBL Invoice root/);
    await expect(
      canonicalizer.canonicalizeInvoiceReference(
        `<!DOCTYPE Invoice [<!ENTITY secret "forbidden">]><Invoice ${rootNamespaces()}><cbc:ID>&secret;</cbc:ID></Invoice>`,
      ),
    ).rejects.toThrow(/DTD/);
  });
});
