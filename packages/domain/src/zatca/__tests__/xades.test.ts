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
  hashZatcaSignedPropertiesProfile,
  renderZatcaSignedInfoXml,
  renderZatcaSignedPropertiesHashInputXml,
  renderZatcaSignedPropertiesXml,
  zatcaCertificateDigestValue,
} from '../xades.js';
import { ZatcaInvoiceError } from '../phase2.js';

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function digestHex(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(32);
}

describe('ZATCA Fatoora SignedInfo structure', () => {
  it('pins algorithms, references and the two distinct Fatoora digest representations', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigestHex: digestHex(2),
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
    expect(xml.match(/<ds:Reference\b/g)).toHaveLength(2);
    expect(xml.match(new RegExp(XMLDSIG_SHA256_ALGORITHM, 'g'))).toHaveLength(2);
    expect(xml).toContain(
      '<ds:DigestValue>AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=</ds:DigestValue>',
    );
    expect(xml).toContain(
      '<ds:DigestValue>MDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMg==</ds:DigestValue>',
    );
  });

  it('keeps the four invoice transforms in the required order', () => {
    const xml = renderZatcaSignedInfoXml({
      invoiceDigest: digest(1),
      signedPropertiesDigestHex: digestHex(2),
    });

    let cursor = xml.indexOf('<ds:Transforms>');
    expect(cursor).toBeGreaterThan(-1);
    for (const xpath of ZATCA_INVOICE_REFERENCE_TRANSFORMS) {
      const algorithm = xml.indexOf(`<ds:Transform Algorithm="${ZATCA_XPATH_ALGORITHM}">`, cursor);
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
  });

  it('refuses wrong invoice digest widths and malformed SignedProperties hashes', () => {
    for (const invalid of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
      expect(() =>
        renderZatcaSignedInfoXml({
          invoiceDigest: invalid,
          signedPropertiesDigestHex: digestHex(2),
        }),
      ).toThrow(ZatcaInvoiceError);
    }
    for (const invalid of ['', '0'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(() =>
        renderZatcaSignedInfoXml({
          invoiceDigest: digest(1),
          signedPropertiesDigestHex: invalid,
        }),
      ).toThrow(/lower-case 64-character hex/);
    }
  });
});

describe('ZATCA Fatoora SignedProperties', () => {
  const signingCertificateDer = Uint8Array.from([0x30, 0x01, 0x01]);
  const issuerName = 'CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local';
  const serialNumber = '123456789';
  const input = {
    signingTime: '2026-09-10T00:00:00Z',
    signingCertificateDer,
    issuerName,
    serialNumber,
  } as const;

  it('embeds SigningCertificate plus DER-derived identity and never V2', async () => {
    const xml = await renderZatcaSignedPropertiesXml(input);

    expect(xml).toContain(`<xades:SignedProperties Id="${ZATCA_SIGNED_PROPERTIES_ID}">`);
    expect(xml).not.toContain('xmlns:xades=');
    expect(xml).toContain('<xades:SigningTime>2026-09-10T00:00:00Z</xades:SigningTime>');
    expect(xml).toContain('<xades:SigningCertificate>');
    expect(xml).not.toContain('SigningCertificateV2');
    expect(xml).toContain(`<ds:X509IssuerName>${issuerName}</ds:X509IssuerName>`);
    expect(xml).toContain(`<ds:X509SerialNumber>${serialNumber}</ds:X509SerialNumber>`);
    expect(xml).not.toContain('xmlns:ds=');
    expect(xml.match(/<xades:Cert>/g)).toHaveLength(1);
  });

  it('uses the Fatoora certificate-hash representation: Base64 of lower-case SHA256 hex text', async () => {
    await expect(zatcaCertificateDigestValue(signingCertificateDer)).resolves.toBe(
      'NzNjMTE5MGJhZTQ5MjI5YTkyYTBkYzMwYTZmZWE0OWFlMDg0ZWM0NTg5ODQzMTVjZWJkZTdlZjQxMmYwYjhiOQ==',
    );
  });

  it('renders and hashes the byte-exact compatibility template rather than canonicalizing embedded XML', async () => {
    const hashInput = await renderZatcaSignedPropertiesHashInputXml(input);
    expect(hashInput).toContain(
      `<xades:SignedProperties xmlns:xades="${ZATCA_XADES_NAMESPACE}" Id="${ZATCA_SIGNED_PROPERTIES_ID}">`,
    );
    expect(hashInput).toContain(
      `<ds:DigestMethod xmlns:ds="${XMLDSIG_NAMESPACE}" Algorithm="${XMLDSIG_SHA256_ALGORITHM}"/>`,
    );
    expect(hashInput).toContain(
      `                                                    <ds:X509IssuerName xmlns:ds="${XMLDSIG_NAMESPACE}">${issuerName}</ds:X509IssuerName>`,
    );
    expect(hashInput.endsWith('                                </xades:SignedProperties>')).toBe(
      true,
    );
    await expect(hashZatcaSignedPropertiesProfile(hashInput)).resolves.toBe(
      '26588d49a6e236c6ef5b6effacc38548164124337fb2b14e65c5c47e095cba54',
    );

    const whitespaceMutated = hashInput.replace(
      '                                    <xades:SignedSignatureProperties>',
      '                                   <xades:SignedSignatureProperties>',
    );
    await expect(hashZatcaSignedPropertiesProfile(whitespaceMutated)).resolves.not.toBe(
      '26588d49a6e236c6ef5b6effacc38548164124337fb2b14e65c5c47e095cba54',
    );
  });

  it('refuses hashing the embedded representation to prevent accidental profile drift', async () => {
    const embedded = await renderZatcaSignedPropertiesXml(input);
    await expect(hashZatcaSignedPropertiesProfile(embedded)).rejects.toThrow(/hash input/);
  });

  it('fails closed on missing certificate identity material', async () => {
    await expect(
      renderZatcaSignedPropertiesXml({ ...input, signingCertificateDer: new Uint8Array(0) }),
    ).rejects.toThrow(/SigningCertificate requires/);
    await expect(renderZatcaSignedPropertiesXml({ ...input, issuerName: '   ' })).rejects.toThrow(
      /X509IssuerName/,
    );
    await expect(renderZatcaSignedPropertiesXml({ ...input, serialNumber: '0' })).rejects.toThrow(
      /positive decimal/,
    );
  });

  it('refuses non-UTC and impossible signing instants instead of normalizing them', async () => {
    for (const signingTime of ['2026-09-10T03:00:00+03:00', '2026-02-30T00:00:00Z']) {
      await expect(renderZatcaSignedPropertiesXml({ ...input, signingTime })).rejects.toThrow(
        ZatcaInvoiceError,
      );
    }
  });
});
