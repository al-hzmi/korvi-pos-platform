import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../base64.js';
import { encodeTlv, encodeTlvField, simplifiedInvoiceQr, ZATCA_TAG } from '../tlv.js';
import { money, moneyFromMajorString } from '../../money/money.js';
import { TlvEncodingError } from '../../errors.js';

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
    // The bug this guards: "متجر" is 4 characters but 8 bytes.
    const field = encodeTlvField({ tag: ZATCA_TAG.SELLER_NAME, value: 'متجر' });
    expect(field[0]).toBe(1);
    expect(field[1]).toBe(8);
    expect(field.length).toBe(10);
  });

  it('handles ASCII where bytes and characters agree', () => {
    const field = encodeTlvField({ tag: 2, value: 'ABC' });
    expect(field[1]).toBe(3);
  });

  it('counts emoji and mixed scripts by byte', () => {
    const value = 'متجر Korvi';
    const expected = new TextEncoder().encode(value).length;
    expect(encodeTlvField({ tag: 1, value })[1]).toBe(expected);
  });

  it('concatenates fields in order', () => {
    const bytes = encodeTlv([
      { tag: 1, value: 'A' },
      { tag: 2, value: 'BB' },
    ]);
    expect(Array.from(bytes)).toEqual([1, 1, 0x41, 2, 2, 0x42, 0x42]);
  });

  it('refuses a value longer than the single length byte can describe', () => {
    expect(() => encodeTlvField({ tag: 1, value: 'ا'.repeat(200) })).toThrow(TlvEncodingError);
  });

  it('refuses a tag outside one byte', () => {
    expect(() => encodeTlvField({ tag: 256, value: 'x' })).toThrow(TlvEncodingError);
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

  it('is deterministic', () => {
    expect(simplifiedInvoiceQr(input)).toBe(simplifiedInvoiceQr(input));
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

  it('rejects a malformed VAT number', () => {
    expect(() => simplifiedInvoiceQr({ ...input, vatRegistrationNumber: '123' })).toThrow(
      TlvEncodingError,
    );
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => simplifiedInvoiceQr({ ...input, timestamp: '07/08/2026' })).toThrow(
      TlvEncodingError,
    );
  });

  it('rejects an empty seller name', () => {
    expect(() => simplifiedInvoiceQr({ ...input, sellerName: '   ' })).toThrow(TlvEncodingError);
  });
});
