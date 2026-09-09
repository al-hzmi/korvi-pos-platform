import { describe, expect, it } from 'vitest';
import {
  XMLDSIG_ECDSA_SHA256_ALGORITHM,
  XMLDSIG_NAMESPACE,
  XMLDSIG_SHA256_ALGORITHM,
  ZATCA_C14N11_ALGORITHM,
  ZATCA_INVOICE_REFERENCE_ID,
  ZATCA_INVOICE_REFERENCE_TRANSFORMS,
  ZATCA_SIGNED_PROPERTIES_ID,
  ZATCA_XADES_NAMESPACE,
  ZATCA_XADES_SIGNED_PROPERTIES_TYPE,
  ZATCA_XPATH_ALGORITHM,
  renderZatcaSignedInfoXml,
  renderZatcaSignedPropertiesXml,
} from '../xades.js';
import { ZatcaInvoiceError } from '../phase2.js';

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe('ZATCA XAdES SignedInfo structure', () => {
  it('pins the XMLDSIG algorithms and exact ZATCA reference identifiers', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigest: digest(2),
    });

    expect(xml).toContain(`<ds:SignedInfo xmlns:ds="${XMLDSIG_NAMESPACE}">`);
    expect(xml).toContain(
      `<ds:CanonicalizationMethod Algorithm="${ZATCA_C14N11_ALGORITHM}"></ds:CanonicalizationMethod>`,
    );
    expect(xml).toContain(
      `<ds:SignatureMethod Algorithm="${XMLDSIG_ECDSA_SHA256_ALGORITHM}"></ds:SignatureMethod>`,
    );
    expect(xml).toContain(`<ds:Reference Id="${ZATCA_INVOICE_REFERENCE_ID}" URI="">`);
    expect(xml).toContain(
      `<ds:Reference Type="${ZATCA_XADES_SIGNED_PROPERTIES_TYPE}" URI="#${ZATCA_SIGNED_PROPERTIES_ID}">`,
    );
  });

  it('emits exactly two references', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigest: digest(2),
    });
    expect(xml.match(/<ds:Reference\b/g)).toHaveLength(2);
    expect(xml.match(/<ds:DigestMethod\b/g)).toHaveLength(2);
    expect(xml.match(/<ds:DigestValue>/g)).toHaveLength(2);
  });

  it('keeps the four invoice transforms in the required order', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigest: digest(2),
    });

    let cursor = xml.indexOf('<ds:Transforms>');
    expect(cursor).toBeGreaterThan(-1);
    for (const xpath of ZATCA_INVOICE_REFERENCE_TRANSFORMS) {
      const algorithm = xml.indexOf(
        `<ds:Transform Algorithm="${ZATCA_XPATH_ALGORITHM}">`,
        cursor,
      );
      const expression = xml.indexOf(`<ds:XPath>${xpath}</ds:XPath>`, algorithm);
      expect(algorithm).toBeGreaterThan(cursor);
      expect(expression).toBeGreaterThan(algorithm);
      cursor = expression;
    }
    const c14n = xml.indexOf(
      `<ds:Transform Algorithm="${ZATCA_C14N11_ALGORITHM}"></ds:Transform>`,
      cursor,
    );
    expect(c14n).toBeGreaterThan(cursor);
    expect(xml.indexOf('</ds:Transforms>', c14n)).toBeGreaterThan(c14n);
  });

  it('uses SHA-256 for both digest references and Base64-encodes raw 32-byte digests', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigest: digest(2),
    });
    expect(xml.match(new RegExp(XMLDSIG_SHA256_ALGORITHM, 'g'))).toHaveLength(2);
    expect(xml).toContain(
      '<ds:DigestValue>AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=</ds:DigestValue>',
    );
    expect(xml).toContain(
      '<ds:DigestValue>AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=</ds:DigestValue>',
    );
  });

  it('refuses non-SHA256 digest widths instead of padding or truncating them', () => {
    for (const invalid of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
      expect(() =>
        renderZatcaSignedInfoXml({
          invoiceDigest: invalid,
          signedPropertiesDigest: digest(2),
        }),
      ).toThrow(ZatcaInvoiceError);
      expect(() =>
        renderZatcaSignedInfoXml({
          invoiceDigest: digest(1),
          signedPropertiesDigest: invalid,
        }),
      ).toThrow(ZatcaInvoiceError);
    }
  });

  it('does not pretend SignedInfo rendering has already produced a signature or certificate', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigest: digest(2),
    });
    expect(xml).not.toContain('SignatureValue');
    expect(xml).not.toContain('KeyInfo');
    expect(xml).not.toContain('X509Certificate');
  });
});

describe('ZATCA XAdES SignedPropertiesV2', () => {
  const certificatePathDer = [
    Uint8Array.from([0x30, 0x01, 0x01]),
    Uint8Array.from([0x30, 0x01, 0x02]),
  ];

  it('includes signing time, every certificate digest and the signing certificate first', async () => {
    const xml = await renderZatcaSignedPropertiesXml({
      signingTime: '2026-09-10T00:00:00Z',
      certificatePathDer,
      signaturePolicyIdentifier: 'urn:zatca:signature-policy:test-v1',
      signaturePolicyDigest: digest(3),
    });

    expect(xml).toContain(
      `<xades:SignedProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" xmlns:ds="${XMLDSIG_NAMESPACE}" Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    );
    expect(xml).toContain('<xades:SigningTime>2026-09-10T00:00:00Z</xades:SigningTime>');
    expect(xml.match(/<xades:Cert>/g)).toHaveLength(2);
    const signingCertificateDigest =
      '<ds:DigestValue>nbCEfg++xGJt8cyFmiwGJhno5duPqxg8W/nZd5Va+00=</ds:DigestValue>';
    const issuerDigest =
      '<ds:DigestValue>PL5kcM/4Xfrd6pmPhX+jh3Lb9G90sDn+8KdfabxKjH0=</ds:DigestValue>';
    expect(xml.indexOf(signingCertificateDigest)).toBeGreaterThan(-1);
    expect(xml.indexOf(issuerDigest)).toBeGreaterThan(xml.indexOf(signingCertificateDigest));
    expect(xml.match(new RegExp(XMLDSIG_SHA256_ALGORITHM, 'g'))).toHaveLength(3);
    expect(xml).not.toContain('IssuerSerialV2');
  });

  it('binds an explicit policy identifier/hash and the data-object format into SignedProperties', async () => {
    const xml = await renderZatcaSignedPropertiesXml({
      signingTime: '2026-09-10T00:00:00Z',
      certificatePathDer,
      signaturePolicyIdentifier: 'https://example.invalid/policy?a=1&b=2',
      signaturePolicyDigest: digest(3),
    });

    expect(xml).toContain(
      '<xades:Identifier>https://example.invalid/policy?a=1&amp;b=2</xades:Identifier>',
    );
    expect(xml).toContain(
      '<ds:DigestValue>AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=</ds:DigestValue>',
    );
    expect(xml).toContain(
      `<xades:DataObjectFormat ObjectReference="#${ZATCA_INVOICE_REFERENCE_ID}">`,
    );
    expect(xml).toContain('<xades:MimeType>text/xml</xades:MimeType>');
  });

  it('refuses an absent or empty certificate path', async () => {
    await expect(
      renderZatcaSignedPropertiesXml({
        signingTime: '2026-09-10T00:00:00Z',
        certificatePathDer: [],
        signaturePolicyIdentifier: 'urn:zatca:policy:test',
        signaturePolicyDigest: digest(3),
      }),
    ).rejects.toThrow(/certificate path/);
    await expect(
      renderZatcaSignedPropertiesXml({
        signingTime: '2026-09-10T00:00:00Z',
        certificatePathDer: [new Uint8Array(0)],
        signaturePolicyIdentifier: 'urn:zatca:policy:test',
        signaturePolicyDigest: digest(3),
      }),
    ).rejects.toThrow(/empty certificate/);
  });

  it('refuses invented-looking relative/blank policy identifiers and wrong digest widths', async () => {
    for (const identifier of ['', 'policy-v1', 'urn:zatca policy']) {
      await expect(
        renderZatcaSignedPropertiesXml({
          signingTime: '2026-09-10T00:00:00Z',
          certificatePathDer,
          signaturePolicyIdentifier: identifier,
          signaturePolicyDigest: digest(3),
        }),
      ).rejects.toThrow(/absolute identifier/);
    }
    await expect(
      renderZatcaSignedPropertiesXml({
        signingTime: '2026-09-10T00:00:00Z',
        certificatePathDer,
        signaturePolicyIdentifier: 'urn:zatca:policy:test',
        signaturePolicyDigest: new Uint8Array(31),
      }),
    ).rejects.toThrow(/exactly 32 bytes/);
  });

  it('refuses non-UTC and impossible signing instants instead of normalizing them', async () => {
    for (const signingTime of ['2026-09-10T03:00:00+03:00', '2026-02-30T00:00:00Z']) {
      await expect(
        renderZatcaSignedPropertiesXml({
          signingTime,
          certificatePathDer,
          signaturePolicyIdentifier: 'urn:zatca:policy:test',
          signaturePolicyDigest: digest(3),
        }),
      ).rejects.toThrow(ZatcaInvoiceError);
    }
  });
});
