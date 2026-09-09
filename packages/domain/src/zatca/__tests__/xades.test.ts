import { describe, expect, it } from 'vitest';
import {
  XMLDSIG_ECDSA_SHA256_ALGORITHM,
  XMLDSIG_NAMESPACE,
  XMLDSIG_SHA256_ALGORITHM,
  ZATCA_C14N11_ALGORITHM,
  ZATCA_INVOICE_REFERENCE_ID,
  ZATCA_INVOICE_REFERENCE_TRANSFORMS,
  ZATCA_SIGNED_PROPERTIES_ID,
  ZATCA_XADES_SIGNED_PROPERTIES_TYPE,
  ZATCA_XPATH_ALGORITHM,
  renderZatcaSignedInfoXml,
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
    expect(xml).toContain('<ds:DigestValue>AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=</ds:DigestValue>');
    expect(xml).toContain('<ds:DigestValue>AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=</ds:DigestValue>');
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
