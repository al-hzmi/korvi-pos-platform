import { ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES } from '../ports/zatca.js';
import { bytesToBase64 } from './base64.js';
import { ZatcaInvoiceError } from './phase2.js';

const COMPONENT_BYTES = ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES / 2;
const SECP256K1_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

/**
 * Convert the ASN.1 DER encoding commonly returned by HSM/OpenSSL ECDSA APIs
 * into XMLDSIG's fixed-width `r || s` representation.
 *
 * XMLDSIG does not put the DER SEQUENCE into ds:SignatureValue. Each scalar is
 * an unsigned 32-byte I2OSP value for secp256k1. This parser is deliberately
 * strict DER: malformed lengths, negative INTEGERs, redundant sign padding,
 * trailing bytes, zero scalars and scalars outside the curve order are refused.
 */
export function ecdsaDerToXmlDsigSignature(der: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(der);
  let offset = 0;

  requireByte(bytes, offset, 0x30, 'ECDSA signature must be a DER SEQUENCE.');
  offset += 1;
  const sequenceLength = readShortDerLength(bytes, offset, 'ECDSA SEQUENCE');
  offset += 1;
  if (sequenceLength !== bytes.length - offset) {
    throw new ZatcaInvoiceError('ECDSA DER SEQUENCE length does not match its bytes.');
  }

  const r = readDerInteger(bytes, offset, 'r');
  offset = r.nextOffset;
  const s = readDerInteger(bytes, offset, 's');
  offset = s.nextOffset;
  if (offset !== bytes.length) {
    throw new ZatcaInvoiceError('ECDSA DER signature contains trailing data or extra INTEGERs.');
  }

  const out = new Uint8Array(ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES);
  writeScalar(out, 0, r.value, 'r');
  writeScalar(out, COMPONENT_BYTES, s.value, 's');
  return out;
}

/**
 * Validate an already-materialised XMLDSIG ECDSA SignatureValue byte sequence.
 * Returns a defensive copy so caller-owned buffers cannot mutate a sealed XML.
 */
export function validateXmlDsigEcdsaSignature(signature: Uint8Array): Uint8Array {
  if (signature.length !== ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES) {
    throw new ZatcaInvoiceError(
      `XMLDSIG ECDSA SignatureValue must be exactly ${String(ZATCA_XMLDSIG_ECDSA_SIGNATURE_BYTES)} bytes.`,
    );
  }
  const copy = Uint8Array.from(signature);
  assertScalar(copy.subarray(0, COMPONENT_BYTES), 'r');
  assertScalar(copy.subarray(COMPONENT_BYTES), 's');
  return copy;
}

/**
 * Convert validated XMLDSIG `r || s` bytes back to canonical ASN.1 DER.
 *
 * Node/OpenSSL verification APIs use DER ECDSA signatures. Keeping this reverse
 * conversion beside the strict DER->XMLDSIG parser gives the sealing authority a
 * deterministic self-verification boundary without ever touching private-key bytes.
 */
export function xmlDsigEcdsaSignatureToDer(signature: Uint8Array): Uint8Array {
  const validated = validateXmlDsigEcdsaSignature(signature);
  const r = encodeDerInteger(validated.subarray(0, COMPONENT_BYTES));
  const s = encodeDerInteger(validated.subarray(COMPONENT_BYTES));
  const length = r.length + s.length;
  return Uint8Array.from([0x30, length, ...r, ...s]);
}

/** Base64 text written inside `ds:SignatureValue`. */
export function xmlDsigEcdsaSignatureBase64(signature: Uint8Array): string {
  return bytesToBase64(validateXmlDsigEcdsaSignature(signature));
}

interface ParsedInteger {
  readonly value: Uint8Array;
  readonly nextOffset: number;
}

function readDerInteger(bytes: Uint8Array, offset: number, label: 'r' | 's'): ParsedInteger {
  requireByte(bytes, offset, 0x02, `ECDSA ${label} must be a DER INTEGER.`);
  offset += 1;
  const length = readShortDerLength(bytes, offset, `ECDSA ${label} INTEGER`);
  offset += 1;
  if (length === 0 || offset + length > bytes.length) {
    throw new ZatcaInvoiceError(`ECDSA ${label} INTEGER length is invalid.`);
  }

  const encoded = bytes.subarray(offset, offset + length);
  const first = encoded[0];
  if (first === undefined) {
    throw new ZatcaInvoiceError(`ECDSA ${label} INTEGER is empty.`);
  }
  if ((first & 0x80) !== 0) {
    throw new ZatcaInvoiceError(`ECDSA ${label} INTEGER must not be negative.`);
  }

  let value = encoded;
  if (first === 0) {
    if (encoded.length === 1) {
      throw new ZatcaInvoiceError(`ECDSA ${label} scalar must be non-zero.`);
    }
    const second = encoded[1];
    if (second === undefined || (second & 0x80) === 0) {
      throw new ZatcaInvoiceError(`ECDSA ${label} INTEGER has redundant DER sign padding.`);
    }
    value = encoded.subarray(1);
  }

  if (value.length > COMPONENT_BYTES) {
    throw new ZatcaInvoiceError(`ECDSA ${label} scalar exceeds secp256k1 width.`);
  }
  assertScalar(value, label);
  return { value: Uint8Array.from(value), nextOffset: offset + length };
}

function readShortDerLength(bytes: Uint8Array, offset: number, label: string): number {
  const value = bytes[offset];
  if (value === undefined) {
    throw new ZatcaInvoiceError(`${label} is missing its DER length.`);
  }
  // A secp256k1 ECDSA signature is at most 72 bytes. DER therefore requires
  // short-form lengths; long-form encoding would be non-minimal.
  if ((value & 0x80) !== 0) {
    throw new ZatcaInvoiceError(`${label} uses a non-canonical DER length.`);
  }
  return value;
}

function requireByte(bytes: Uint8Array, offset: number, expected: number, message: string): void {
  if (bytes[offset] !== expected) {
    throw new ZatcaInvoiceError(message);
  }
}

function writeScalar(out: Uint8Array, offset: number, scalar: Uint8Array, label: 'r' | 's'): void {
  assertScalar(scalar, label);
  out.set(scalar, offset + COMPONENT_BYTES - scalar.length);
}

function assertScalar(bytes: Uint8Array, label: 'r' | 's'): void {
  if (bytes.length === 0 || bytes.length > COMPONENT_BYTES) {
    throw new ZatcaInvoiceError(`ECDSA ${label} scalar has invalid width.`);
  }
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  if (value === 0n) {
    throw new ZatcaInvoiceError(`ECDSA ${label} scalar must be non-zero.`);
  }
  if (value >= SECP256K1_ORDER) {
    throw new ZatcaInvoiceError(`ECDSA ${label} scalar is outside the secp256k1 group order.`);
  }
}

function encodeDerInteger(component: Uint8Array): Uint8Array {
  let firstNonZero = 0;
  while (firstNonZero < component.length - 1 && component[firstNonZero] === 0) {
    firstNonZero += 1;
  }
  const scalar = component.subarray(firstNonZero);
  const needsSignPad = ((scalar[0] ?? 0) & 0x80) !== 0;
  const payload = needsSignPad ? Uint8Array.from([0, ...scalar]) : Uint8Array.from(scalar);
  return Uint8Array.from([0x02, payload.length, ...payload]);
}
