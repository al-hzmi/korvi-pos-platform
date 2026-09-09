import { describe, expect, it } from 'vitest';
import {
  ecdsaDerToXmlDsigSignature,
  validateXmlDsigEcdsaSignature,
  xmlDsigEcdsaSignatureBase64,
} from '../ecdsa.js';
import { ZatcaInvoiceError } from '../phase2.js';

const SECP256K1_ORDER_HEX = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141';

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('test hex must have an even length');
  return Uint8Array.from(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function derInteger(value: Uint8Array): Uint8Array {
  const needsSignPad = (value[0] ?? 0) >= 0x80;
  const payload = needsSignPad ? Uint8Array.from([0, ...value]) : value;
  return Uint8Array.from([0x02, payload.length, ...payload]);
}

function derSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const rInteger = derInteger(r);
  const sInteger = derInteger(s);
  return Uint8Array.from([0x30, rInteger.length + sInteger.length, ...rInteger, ...sInteger]);
}

describe('ECDSA DER -> XMLDSIG SignatureValue', () => {
  it('converts canonical DER integers to fixed-width 32-byte r || s', () => {
    const converted = ecdsaDerToXmlDsigSignature(
      derSignature(Uint8Array.of(1), Uint8Array.of(2)),
    );
    expect(converted).toHaveLength(64);
    expect(converted.slice(0, 31)).toEqual(new Uint8Array(31));
    expect(converted[31]).toBe(1);
    expect(converted.slice(32, 63)).toEqual(new Uint8Array(31));
    expect(converted[63]).toBe(2);
  });

  it('accepts the one required DER sign pad for a positive high-bit scalar', () => {
    const r = new Uint8Array(32);
    r[0] = 0x80;
    const converted = ecdsaDerToXmlDsigSignature(derSignature(r, Uint8Array.of(1)));
    expect(converted.slice(0, 32)).toEqual(r);
  });

  it('rejects non-SEQUENCE, bad length, trailing data and extra INTEGERs', () => {
    for (const bad of [
      Uint8Array.from([0x31, 0x00]),
      Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]),
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00]),
      Uint8Array.from([
        0x30,
        0x09,
        0x02,
        0x01,
        0x01,
        0x02,
        0x01,
        0x02,
        0x02,
        0x01,
        0x03,
      ]),
    ]) {
      expect(() => ecdsaDerToXmlDsigSignature(bad)).toThrow(ZatcaInvoiceError);
    }
  });

  it('rejects long-form DER lengths because this signature must fit short form', () => {
    expect(() =>
      ecdsaDerToXmlDsigSignature(Uint8Array.from([0x30, 0x81, 0x06, 0x02, 0x01, 1, 0x02, 0x01, 2])),
    ).toThrow(/non-canonical DER length/);
  });

  it('rejects negative, zero and redundantly padded INTEGERs', () => {
    for (const bad of [
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]),
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01]),
      Uint8Array.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]),
    ]) {
      expect(() => ecdsaDerToXmlDsigSignature(bad)).toThrow(ZatcaInvoiceError);
    }
  });

  it('rejects scalars wider than 32 bytes after legal sign padding', () => {
    const tooWide = new Uint8Array(33);
    tooWide[0] = 1;
    expect(() => ecdsaDerToXmlDsigSignature(derSignature(tooWide, Uint8Array.of(1)))).toThrow(
      /exceeds secp256k1 width/,
    );
  });

  it('rejects r or s equal to the secp256k1 order', () => {
    const order = hexBytes(SECP256K1_ORDER_HEX);
    expect(() => ecdsaDerToXmlDsigSignature(derSignature(order, Uint8Array.of(1)))).toThrow(
      /outside the secp256k1 group order/,
    );
    expect(() => ecdsaDerToXmlDsigSignature(derSignature(Uint8Array.of(1), order))).toThrow(
      /outside the secp256k1 group order/,
    );
  });

  it('accepts the largest valid scalar n-1', () => {
    const nMinusOne = hexBytes(
      'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140',
    );
    const converted = ecdsaDerToXmlDsigSignature(
      derSignature(nMinusOne, nMinusOne),
    );
    expect(converted.slice(0, 32)).toEqual(nMinusOne);
    expect(converted.slice(32)).toEqual(nMinusOne);
  });
});

describe('XMLDSIG ECDSA SignatureValue bytes', () => {
  it('requires exactly 64 bytes and non-zero in-range r and s', () => {
    const valid = new Uint8Array(64);
    valid[31] = 1;
    valid[63] = 2;
    expect(validateXmlDsigEcdsaSignature(valid)).toEqual(valid);

    for (const bad of [new Uint8Array(63), new Uint8Array(65), new Uint8Array(64)]) {
      expect(() => validateXmlDsigEcdsaSignature(bad)).toThrow(ZatcaInvoiceError);
    }
  });

  it('returns a defensive copy', () => {
    const signature = new Uint8Array(64);
    signature[31] = 1;
    signature[63] = 2;
    const validated = validateXmlDsigEcdsaSignature(signature);
    validated[31] = 9;
    expect(signature[31]).toBe(1);
  });

  it('Base64-encodes only a validated XMLDSIG signature', () => {
    const signature = new Uint8Array(64);
    signature[31] = 1;
    signature[63] = 2;
    const encoded = xmlDsigEcdsaSignatureBase64(signature);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded.length).toBe(88);
    expect(() => xmlDsigEcdsaSignatureBase64(new Uint8Array(64))).toThrow(/non-zero/);
  });
});
