import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../base64.js';
import {
  encodeBinaryTlv,
  encodeBinaryTlvField,
  encodeTlv,
  encodeTlvField,
  phase2SimplifiedInvoiceQr,
  phase2SimplifiedInvoiceQrFields,
  simplifiedInvoiceQr,
  ZATCA_TAG,
} from '../tlv.js';
import { money, moneyFromMajorString } from '../../money/money.js';
import { TlvEncodingError } from '../../errors.js';

function derSequence(content: readonly number[]): Uint8Array {
  if (content.length < 0x80) {
    return Uint8Array.from([0x30, content.length, ...content]);
  }
  if (content.length <= 0xff) {
    return Uint8Array.from([0x30, 0x81, content.length, ...content]);
  }
  throw new Error('Test DER helper supports at most 255 content bytes.');
}

describe('base64', () => {
  it('matches known vectors including every padding case', () => {
    const encode = (text: string): string => bytesToBase64(new TextEncoder().encode(text));
    expect(encode('')).toBe('');
    expect(encode('f')).toBe('Zg==');
    expect(encode('fo')).toBe('Zm8=');
    expect(encode('foo')).toBe('Zm9v');
    expect(encode('foob')).toBe('Zm9vYg==');
    expect(encode('fooba')).toBe('Zm9vYmE=');
    expect(encode('foobar')).toBe('Zm9vYmFy');
  });

  it('agrees with Node on random bytes', () => {
    for (let run = 0; run < 200; run += 1) {
      const bytes = new Uint8Array(run);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + run) % 256;
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('TLV encoding', () => {
  it('declares length in UTF-8 bytes, not characters', () => {
    const field = encodeTlvField({ tag: ZATCA_TAG.SELLER_NAME, value: 'متجر' });
    expect(field[0]).toBe(1);
    expect(field[1]).toBe(8);
    expect(field.length).toBe(10);
  });

  it('handles ASCII where bytes and characters agree', () => {
    const field = encodeTlvField({ tag: 2, value: 'ABC' });
    expect(field[1]).toBe(3);
  });

  it('counts mixed scripts by byte', () => {
    const value = 'متجر Korvi';
    const expected = new TextEncoder().encode(value).length;
    expect(encodeTlvField({ tag: 1, value })[1]).toBe(expected);
  });

  it('concatenates text fields in order', () => {
    const bytes = encodeTlv([
      { tag: 1, value: 'A' },
      { tag: 2, value: 'BB' },
    ]);
    expect(Array.from(bytes)).toEqual([1, 1, 0x41, 2, 2, 0x42, 0x42]);
  });

  it('preserves arbitrary binary values without UTF-8 reinterpretation', () => {
    const value = Uint8Array.from([0x00, 0xff, 0x80, 0x41, 0x00]);
    const encoded = encodeBinaryTlvField({ tag: 6, value });
    expect(Array.from(encoded)).toEqual([6, 5, 0x00, 0xff, 0x80, 0x41, 0x00]);
  });

  it('concatenates binary fields in the supplied order', () => {
    const bytes = encodeBinaryTlv([
      { tag: 6, value: Uint8Array.from([0xaa]) },
      { tag: 7, value: Uint8Array.from([0xbb, 0xcc]) },
    ]);
    expect(Array.from(bytes)).toEqual([6, 1, 0xaa, 7, 2, 0xbb, 0xcc]);
  });

  it('refuses values outside the one-byte TLV envelope', () => {
    expect(() => encodeTlvField({ tag: 1, value: 'ا'.repeat(200) })).toThrow(TlvEncodingError);
    expect(() => encodeBinaryTlvField({ tag: 6, value: new Uint8Array(256) })).toThrow(
      TlvEncodingError,
    );
    expect(() => encodeTlvField({ tag: 256, value: 'x' })).toThrow(TlvEncodingError);
    expect(() => encodeBinaryTlvField({ tag: -1, value: Uint8Array.of(1) })).toThrow(
      TlvEncodingError,
    );
  });
});

describe('simplified invoice QR', () => {
  const input = {
    sellerName: 'متجر كورفي',
    vatRegistrationNumber: '310122393500003',
    timestamp: '2026-08-07T09:45:00Z',
    invoiceTotalWithVat: moneyFromMajorString('115.00'),
    vatTotal: moneyFromMajorString('15.00'),
  };

  it('is deterministic and preserves the Phase 1 golden bytes', () => {
    expect(simplifiedInvoiceQr(input)).toBe(
      'ARPZhdiq2KzYsSDZg9mI2LHZgdmKAg8zMTAxMjIzOTM1MDAwMDMDFDIwMjYtMDgtMDdUMDk6NDU6MDBaBAYxMTUuMDAFBTE1LjAw',
    );
  });

  it('decodes back to the five Phase 1 tags', () => {
    const raw = Buffer.from(simplifiedInvoiceQr(input), 'base64');
    const tags: { tag: number; value: string }[] = [];
    let offset = 0;
    while (offset < raw.length) {
      const tag = raw[offset] as number;
      const length = raw[offset + 1] as number;
      tags.push({ tag, value: raw.subarray(offset + 2, offset + 2 + length).toString('utf8') });
      offset += 2 + length;
    }
    expect(tags.map((entry) => entry.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(tags[0]?.value).toBe('متجر كورفي');
    expect(tags[3]?.value).toBe('115.00');
    expect(tags[4]?.value).toBe('15.00');
  });

  it('formats totals with exactly two decimals', () => {
    const raw = Buffer.from(
      simplifiedInvoiceQr({ ...input, invoiceTotalWithVat: money(500n), vatTotal: money(65n) }),
      'base64',
    ).toString('utf8');
    expect(raw).toContain('5.00');
    expect(raw).toContain('0.65');
  });

  it('rejects malformed base fields', () => {
    expect(() => simplifiedInvoiceQr({ ...input, vatRegistrationNumber: '123' })).toThrow(
      TlvEncodingError,
    );
    expect(() => simplifiedInvoiceQr({ ...input, timestamp: '07/08/2026' })).toThrow(
      TlvEncodingError,
    );
    expect(() => simplifiedInvoiceQr({ ...input, sellerName: '   ' })).toThrow(TlvEncodingError);
  });
});

describe('Phase 2 simplified invoice QR', () => {
  const phase1 = {
    sellerName: 'متجر كورفي',
    vatRegistrationNumber: '310122393500003',
    timestamp: '2026-08-07T09:45:00Z',
    invoiceTotalWithVat: moneyFromMajorString('115.00'),
    vatTotal: moneyFromMajorString('15.00'),
  };
  const ecdsaSignatureDer = derSequence([0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
  const input = {
    ...phase1,
    invoiceHash: Uint8Array.from({ length: 32 }, (_, index) => index),
    ecdsaSignatureDer,
    ecdsaPublicKeySpkiDer: derSequence([0x02, 0x01, 0x02]),
    zatcaCaSignatureDer: derSequence([0x02, 0x01, 0x03]),
  };

  it('orders exactly tags 1 through 9 and preserves the Phase 1 prefix byte-for-byte', () => {
    const rawPhase1 = Buffer.from(simplifiedInvoiceQr(phase1), 'base64');
    const rawPhase2 = Buffer.from(phase2SimplifiedInvoiceQr(input), 'base64');
    expect(rawPhase2.subarray(0, rawPhase1.length)).toEqual(rawPhase1);

    const tags: number[] = [];
    let offset = 0;
    while (offset < rawPhase2.length) {
      const tag = rawPhase2[offset] as number;
      const length = rawPhase2[offset + 1] as number;
      tags.push(tag);
      offset += 2 + length;
    }
    expect(tags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('encodes tag 6 as the exact 32-byte SHA-256 value with no inner Base64 layer', () => {
    const fields = phase2SimplifiedInvoiceQrFields(input);
    const hash = fields.find((field) => field.tag === ZATCA_TAG.XML_INVOICE_HASH);
    expect(hash?.value).toEqual(input.invoiceHash);
    expect(hash?.value.length).toBe(32);
    expect(Buffer.from(hash?.value ?? []).toString('utf8')).not.toBe(
      Buffer.from(input.invoiceHash).toString('base64'),
    );
  });

  it('encodes tag 7 as UTF-8 Base64 of the exact DER SignatureValue bytes', () => {
    const fields = phase2SimplifiedInvoiceQrFields(input);
    const signature = fields.find((field) => field.tag === ZATCA_TAG.ECDSA_SIGNATURE);
    expect(Buffer.from(signature?.value ?? []).toString('utf8')).toBe(
      Buffer.from(ecdsaSignatureDer).toString('base64'),
    );
  });

  it('preserves DER public-key and technical-CA signature bytes in tags 8 and 9', () => {
    const fields = phase2SimplifiedInvoiceQrFields(input);
    const publicKey = fields.find((field) => field.tag === ZATCA_TAG.ECDSA_PUBLIC_KEY);
    const caSignature = fields.find((field) => field.tag === ZATCA_TAG.ZATCA_CA_SIGNATURE);
    expect(publicKey?.value).toEqual(input.ecdsaPublicKeySpkiDer);
    expect(caSignature?.value).toEqual(input.zatcaCaSignatureDer);
  });

  it('copies caller-owned DER buffers when constructing fields', () => {
    const publicKey = derSequence([0x02, 0x01, 0x02]);
    const signature = derSequence([0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const fields = phase2SimplifiedInvoiceQrFields({
      ...input,
      ecdsaSignatureDer: signature,
      ecdsaPublicKeySpkiDer: publicKey,
    });
    publicKey[2] = 99;
    signature[2] = 99;
    expect(fields.find((field) => field.tag === ZATCA_TAG.ECDSA_PUBLIC_KEY)?.value[2]).toBe(0x02);
    expect(fields.find((field) => field.tag === ZATCA_TAG.ECDSA_SIGNATURE)?.value).not.toEqual(
      signature,
    );
  });

  it('requires a real SHA-256-width invoice hash', () => {
    expect(() => phase2SimplifiedInvoiceQr({ ...input, invoiceHash: new Uint8Array(31) })).toThrow(
      TlvEncodingError,
    );
    expect(() => phase2SimplifiedInvoiceQr({ ...input, invoiceHash: new Uint8Array(33) })).toThrow(
      TlvEncodingError,
    );
  });

  it('rejects malformed DER in tags 7 through 9', () => {
    expect(() =>
      phase2SimplifiedInvoiceQr({ ...input, ecdsaSignatureDer: new Uint8Array(64) }),
    ).toThrow(TlvEncodingError);
    expect(() =>
      phase2SimplifiedInvoiceQr({
        ...input,
        ecdsaPublicKeySpkiDer: Uint8Array.from([0x04, ...new Uint8Array(64)]),
      }),
    ).toThrow(TlvEncodingError);
    expect(() =>
      phase2SimplifiedInvoiceQr({ ...input, zatcaCaSignatureDer: new Uint8Array(64) }),
    ).toThrow(TlvEncodingError);
  });

  it('rejects malformed DER lengths instead of accepting truncated cryptographic values', () => {
    expect(() =>
      phase2SimplifiedInvoiceQr({
        ...input,
        ecdsaPublicKeySpkiDer: Uint8Array.from([0x30, 0x05, 0x02, 0x01, 0x01]),
      }),
    ).toThrow(TlvEncodingError);
    expect(() =>
      phase2SimplifiedInvoiceQr({
        ...input,
        zatcaCaSignatureDer: Uint8Array.from([0x30, 0x81, 0x03, 0x02, 0x01, 0x01]),
      }),
    ).toThrow(TlvEncodingError);
  });

  it('rejects a QR payload that exceeds the ZATCA 700-character Base64 limit', () => {
    const largeDer = derSequence(new Array(200).fill(1));
    expect(() =>
      phase2SimplifiedInvoiceQr({
        ...input,
        sellerName: 'س'.repeat(120),
        ecdsaSignatureDer: largeDer,
        ecdsaPublicKeySpkiDer: largeDer,
        zatcaCaSignatureDer: largeDer,
      }),
    ).toThrow(TlvEncodingError);
  });
});
