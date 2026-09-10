import { TlvEncodingError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { moneyToMajorString } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * ZATCA e-invoicing QR payload — TLV, then Base64.
 *
 * Phase 1 values (tags 1-5) are UTF-8 text. Tags 1-5 alone are NOT ZATCA Phase 2 compliance.
 * Phase 2 carries tags 1-9 and adds the exact public cryptographic values produced by the Fatoora
 * stamping profile. The TLV value representation is explicit per tag so a valid-looking QR cannot
 * silently refer to different bytes than the XML cryptographic stamp.
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

function assertTagByte(tag: number): void {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    throw new TlvEncodingError(`TLV tag must be a byte, got ${String(tag)}.`);
  }
}

/** Encode one already-materialised byte field as tag, length, value. */
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
 * The length is the UTF-8 byte count, not the JavaScript character count.
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
 * Tag 6 carries the exact 32-byte SHA-256 invoice hash, without an inner Base64 layer.
 * Tag 7 carries the UTF-8 Base64 text of the ASN.1 DER ECDSA signature.
 * Tag 8 carries the EGS public-key DER and tag 9 carries the technical CA signature
 * over that public key for simplified invoices. No private-key material belongs here.
 */
export interface Phase2SimplifiedInvoiceQrInput extends SimplifiedInvoiceQrInput {
  readonly invoiceHash: Uint8Array;
  readonly ecdsaSignatureDer: Uint8Array;
  readonly ecdsaPublicKeySpkiDer: Uint8Array;
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

/** Build all nine Phase 2 QR fields in the normative order. */
export function phase2SimplifiedInvoiceQrFields(
  input: Phase2SimplifiedInvoiceQrInput,
): BinaryTlvField[] {
  if (input.invoiceHash.length !== SHA256_BYTES) {
    throw new TlvEncodingError(
      `ZATCA XML invoice hash must be exactly ${String(SHA256_BYTES)} bytes, got ${String(input.invoiceHash.length)}.`,
    );
  }

  const signatureDer = requireDerSequence(ZATCA_TAG.ECDSA_SIGNATURE, input.ecdsaSignatureDer);
  const invoiceHash = Uint8Array.from(input.invoiceHash);
  const signatureBase64 = bytesToBase64(signatureDer);
  const fields = textualFieldsAsBinary(simplifiedInvoiceQrFields(input));
  fields.push(
    { tag: ZATCA_TAG.XML_INVOICE_HASH, value: invoiceHash },
    { tag: ZATCA_TAG.ECDSA_SIGNATURE, value: encoder.encode(signatureBase64) },
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
