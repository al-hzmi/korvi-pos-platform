import { TlvEncodingError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { moneyToMajorString } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * ZATCA e-invoicing QR payload — TLV, then Base64.
 *
 * Phase 1 values (tags 1-5) are UTF-8 text. Tags 1-5 alone are NOT ZATCA Phase 2 compliance.
 * Phase 2 adds cryptographic material whose representations are intentionally explicit. Treating every
 * cryptographic field as either arbitrary text or arbitrary bytes can produce
 * a QR that parses while referring to different cryptographic material.
 *
 * The May 2023 Security Features Implementation Standards are authoritative
 * for tag 6: the QR carries the raw 32-byte SHA-256 invoice hash. The official
 * technical guide maps tag 7 to the XML `ds:SignatureValue` (Base64 text),
 * illustrates tag 8 as DER SubjectPublicKeyInfo, and tag 9 as the technical
 * CA signature over that public key. Those representations are modelled separately below.
 *
 * Ordering matters as much as content: hashing, stamping and the tags 1-9 QR all
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

/** A byte-exact TLV field. */
export interface BinaryTlvField {
  readonly tag: number;
  readonly value: Uint8Array;
}

const encoder = new TextEncoder();
const MAX_TLV_VALUE_BYTES = 0xff;
const MAX_QR_BASE64_CHARACTERS = 700;
const SHA256_BYTES = 32;
const BASE64_VALUE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function assertTagByte(tag: number): void {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    throw new TlvEncodingError(`TLV tag must be a byte, got ${String(tag)}.`);
  }
}

/**
 * Encode one already-materialised byte field as tag, length, value.
 *
 * This primitive never interprets or re-encodes the value bytes.
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
 * No private-key material belongs here. Every field is already public or a
 * derived signature/hash produced by the validated sealing authority.
 */
export interface Phase2SimplifiedInvoiceQrInput extends SimplifiedInvoiceQrInput {
  /** Raw SHA-256 invoice-hash bytes; exactly 32 bytes by the May 2023 standard. */
  readonly invoiceHash: Uint8Array;
  /** Exact Base64 text stored in XML `ds:SignatureValue`. */
  readonly xmlSignatureValueBase64: string;
  /** DER SubjectPublicKeyInfo for the ECDSA signing public key. */
  readonly ecdsaPublicKeySpkiDer: Uint8Array;
  /** DER ECDSA signature on the stamp public key from ZATCA's technical CA. */
  readonly zatcaCaSignatureDer: Uint8Array;
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

function requireBase64SignatureValue(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_VALUE.test(value)) {
    throw new TlvEncodingError('ZATCA XML SignatureValue must be canonical non-empty Base64 text.');
  }
  return requireNonEmptyCryptoField(ZATCA_TAG.ECDSA_SIGNATURE, encoder.encode(value));
}

function requireDerSequence(tag: number, value: Uint8Array): Uint8Array {
  const copy = requireNonEmptyCryptoField(tag, value);
  if (copy.length < 2 || copy[0] !== 0x30) {
    throw new TlvEncodingError(
      `Cryptographic TLV value for tag ${String(tag)} must be one DER SEQUENCE.`,
    );
  }

  const firstLength = copy[1] as number;
  let contentLength: number;
  let headerLength: number;
  if (firstLength < 0x80) {
    contentLength = firstLength;
    headerLength = 2;
  } else if (firstLength === 0x81) {
    if (copy.length < 3 || (copy[2] as number) < 0x80) {
      throw new TlvEncodingError(`Tag ${String(tag)} uses a non-canonical DER length.`);
    }
    contentLength = copy[2] as number;
    headerLength = 3;
  } else {
    throw new TlvEncodingError(
      `Tag ${String(tag)} DER length is unsupported by the one-byte TLV value limit.`,
    );
  }

  if (headerLength + contentLength !== copy.length) {
    throw new TlvEncodingError(`Tag ${String(tag)} DER SEQUENCE length does not match its bytes.`);
  }
  return copy;
}

/**
 * Build all nine Phase 2 QR fields in the normative order.
 *
 * Tags 1-5 come from the exact Phase 1 builder. Tag 6 is raw SHA-256 bytes.
 * Tag 7 is the Base64 XML SignatureValue encoded as UTF-8. Tags 8 and 9 are the
 * DER values illustrated by ZATCA's technical guide. Caller-owned byte buffers
 * are copied so they cannot mutate the QR after validation.
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
      value: requireBase64SignatureValue(input.xmlSignatureValueBase64),
    },
    {
      tag: ZATCA_TAG.ECDSA_PUBLIC_KEY,
      value: requireDerSequence(ZATCA_TAG.ECDSA_PUBLIC_KEY, input.ecdsaPublicKeySpkiDer),
    },
    {
      tag: ZATCA_TAG.ZATCA_CA_SIGNATURE,
      value: requireDerSequence(ZATCA_TAG.ZATCA_CA_SIGNATURE, input.zatcaCaSignatureDer),
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

/** Phase 2 QR path. No signing or private-key access occurs in this pure function. */
export function phase2SimplifiedInvoiceQr(input: Phase2SimplifiedInvoiceQrInput): string {
  return encodeQrBase64(encodeBinaryTlv(phase2SimplifiedInvoiceQrFields(input)));
}
