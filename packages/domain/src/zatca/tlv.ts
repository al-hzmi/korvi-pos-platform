import { TlvEncodingError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { moneyToMajorString } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * ZATCA e-invoicing QR payload — TLV, then Base64.
 *
 * Phase 1 values (tags 1-5) are UTF-8 text. Phase 2 adds cryptographic byte
 * material (tags 6-9). Keeping those representations distinct is deliberate:
 * feeding a SHA-256 digest or ECDSA signature through TextEncoder changes the
 * bytes and produces a QR payload that can look plausible while being
 * cryptographically unrelated to the sealed invoice.
 *
 * Ordering matters as much as content: hashing, stamping and the tag 1-9 QR all
 * happen locally *before* the customer receives the document. Only reporting to
 * the Authority may be queued and retried. See docs/architecture/zatca.md.
 */
export const ZATCA_TAG = {
  SELLER_NAME: 1,
  VAT_REGISTRATION_NUMBER: 2,
  TIMESTAMP: 3,
  INVOICE_TOTAL_WITH_VAT: 4,
  VAT_TOTAL: 5,
  XML_INVOICE_HASH: 6,
  ECDSA_SIGNATURE: 7,
  ECDSA_PUBLIC_KEY: 8,
  ZATCA_CA_SIGNATURE: 9,
} as const;

export type ZatcaTag = (typeof ZATCA_TAG)[keyof typeof ZATCA_TAG];

/** A textual TLV field. Tags 1-5 use this representation. */
export interface TlvField {
  readonly tag: number;
  readonly value: string;
}

/** A byte-exact TLV field. Cryptographic QR values use this representation. */
export interface BinaryTlvField {
  readonly tag: number;
  readonly value: Uint8Array;
}

const encoder = new TextEncoder();
const MAX_TLV_VALUE_BYTES = 0xff;
const MAX_QR_BASE64_CHARACTERS = 700;
const SHA256_BYTES = 32;

function assertTagByte(tag: number): void {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    throw new TlvEncodingError(`TLV tag must be a byte, got ${String(tag)}.`);
  }
}

/**
 * Encode one already-materialised byte field as tag, length, value.
 *
 * This is the primitive used for cryptographic fields. It never interprets or
 * re-encodes the value bytes.
 */
export function encodeBinaryTlvField(field: BinaryTlvField): Uint8Array {
  assertTagByte(field.tag);
  if (field.value.length > MAX_TLV_VALUE_BYTES) {
    throw new TlvEncodingError(
      `TLV value for tag ${String(field.tag)} is ${String(field.value.length)} bytes; ` +
        'the single-byte length field allows at most 255.',
    );
  }

  const out = new Uint8Array(2 + field.value.length);
  out[0] = field.tag;
  out[1] = field.value.length;
  out.set(field.value, 2);
  return out;
}

/**
 * Encode one textual field as tag, length, UTF-8 value.
 *
 * The length is the UTF-8 **byte** count, not the character count. An Arabic
 * seller name is roughly two bytes per letter, so a character count produces a
 * declared length shorter than the payload and the Authority's parser walks off
 * the end of the field.
 */
export function encodeTlvField(field: TlvField): Uint8Array {
  return encodeBinaryTlvField({ tag: field.tag, value: encoder.encode(field.value) });
}

function concatEncodedFields(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeTlv(fields: readonly TlvField[]): Uint8Array {
  return concatEncodedFields(fields.map(encodeTlvField));
}

export function encodeBinaryTlv(fields: readonly BinaryTlvField[]): Uint8Array {
  return concatEncodedFields(fields.map(encodeBinaryTlvField));
}

export interface SimplifiedInvoiceQrInput {
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  /** ISO 8601, e.g. "2026-08-07T09:45:00Z". Supplied, never read from a clock. */
  readonly timestamp: string;
  readonly invoiceTotalWithVat: Money;
  readonly vatTotal: Money;
}

/**
 * Cryptographic values needed by a Phase 2 simplified-invoice QR.
 *
 * The TLV layer deliberately does not decide how a signing implementation
 * obtains or serialises those values. The sealing authority must hand this
 * module the exact QR bytes required by its validated signing/CSID adapter.
 */
export interface Phase2SimplifiedInvoiceQrInput extends SimplifiedInvoiceQrInput {
  /** Raw SHA-256 invoice-hash bytes; exactly 32 bytes by ZATCA specification. */
  readonly invoiceHash: Uint8Array;
  readonly ecdsaSignature: Uint8Array;
  readonly ecdsaPublicKey: Uint8Array;
  readonly zatcaCaSignature: Uint8Array;
}

/** Build the stable textual tags shared by Phase 1 and Phase 2. */
export function simplifiedInvoiceQrFields(input: SimplifiedInvoiceQrInput): TlvField[] {
  if (input.sellerName.trim() === '') {
    throw new TlvEncodingError('Seller name is required.');
  }
  if (!/^\d{15}$/.test(input.vatRegistrationNumber)) {
    throw new TlvEncodingError('VAT registration number must be 15 digits.');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.timestamp)
  ) {
    throw new TlvEncodingError(`Timestamp must be ISO 8601, got "${input.timestamp}".`);
  }

  return [
    { tag: ZATCA_TAG.SELLER_NAME, value: input.sellerName },
    { tag: ZATCA_TAG.VAT_REGISTRATION_NUMBER, value: input.vatRegistrationNumber },
    { tag: ZATCA_TAG.TIMESTAMP, value: input.timestamp },
    { tag: ZATCA_TAG.INVOICE_TOTAL_WITH_VAT, value: moneyToMajorString(input.invoiceTotalWithVat) },
    { tag: ZATCA_TAG.VAT_TOTAL, value: moneyToMajorString(input.vatTotal) },
  ];
}

function textualFieldsAsBinary(fields: readonly TlvField[]): BinaryTlvField[] {
  return fields.map((field) => ({ tag: field.tag, value: encoder.encode(field.value) }));
}

function requireNonEmptyCryptoField(tag: number, value: Uint8Array): Uint8Array {
  if (value.length === 0) {
    throw new TlvEncodingError(`Cryptographic TLV value for tag ${String(tag)} must not be empty.`);
  }
  if (value.length > MAX_TLV_VALUE_BYTES) {
    throw new TlvEncodingError(
      `Cryptographic TLV value for tag ${String(tag)} is ${String(value.length)} bytes; ` +
        'the single-byte length field allows at most 255.',
    );
  }
  return Uint8Array.from(value);
}

/**
 * Build all nine Phase 2 QR fields in the normative order.
 *
 * Tags 1-5 are converted from the exact same textual field builder used by the
 * Phase 1 path. Tags 6-9 are copied as bytes so caller-owned buffers cannot be
 * mutated after the field set has been constructed.
 */
export function phase2SimplifiedInvoiceQrFields(
  input: Phase2SimplifiedInvoiceQrInput,
): BinaryTlvField[] {
  if (input.invoiceHash.length !== SHA256_BYTES) {
    throw new TlvEncodingError(
      `ZATCA XML invoice hash must be exactly ${String(SHA256_BYTES)} bytes, got ${String(input.invoiceHash.length)}.`,
    );
  }

  const fields = textualFieldsAsBinary(simplifiedInvoiceQrFields(input));
  fields.push(
    { tag: ZATCA_TAG.XML_INVOICE_HASH, value: Uint8Array.from(input.invoiceHash) },
    {
      tag: ZATCA_TAG.ECDSA_SIGNATURE,
      value: requireNonEmptyCryptoField(ZATCA_TAG.ECDSA_SIGNATURE, input.ecdsaSignature),
    },
    {
      tag: ZATCA_TAG.ECDSA_PUBLIC_KEY,
      value: requireNonEmptyCryptoField(ZATCA_TAG.ECDSA_PUBLIC_KEY, input.ecdsaPublicKey),
    },
    {
      tag: ZATCA_TAG.ZATCA_CA_SIGNATURE,
      value: requireNonEmptyCryptoField(ZATCA_TAG.ZATCA_CA_SIGNATURE, input.zatcaCaSignature),
    },
  );
  return fields;
}

function encodeQrBase64(bytes: Uint8Array): string {
  const encoded = bytesToBase64(bytes);
  if (encoded.length > MAX_QR_BASE64_CHARACTERS) {
    throw new TlvEncodingError(
      `ZATCA QR payload is ${String(encoded.length)} Base64 characters; ` +
        `the specification allows at most ${String(MAX_QR_BASE64_CHARACTERS)}.`,
    );
  }
  return encoded;
}

/** Phase 1 QR path; kept byte-for-byte compatible for all previously valid inputs. */
export function simplifiedInvoiceQr(input: SimplifiedInvoiceQrInput): string {
  return encodeQrBase64(encodeTlv(simplifiedInvoiceQrFields(input)));
}

/** Phase 2 QR path. No signing or key access occurs in this pure function. */
export function phase2SimplifiedInvoiceQr(input: Phase2SimplifiedInvoiceQrInput): string {
  return encodeQrBase64(encodeBinaryTlv(phase2SimplifiedInvoiceQrFields(input)));
}
