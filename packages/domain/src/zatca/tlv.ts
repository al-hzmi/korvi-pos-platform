import { TlvEncodingError } from '../errors.js';
import { bytesToBase64 } from './base64.js';
import { moneyToMajorString } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * ZATCA e-invoicing QR payload — TLV, then Base64.
 *
 * SCOPE. This module implements the Phase 1 (simplified tax invoice) QR
 * payload: tags 1-5. It is correct-by-construction and fully offline: no
 * network, no clock beyond the timestamp handed in, no ambient state.
 *
 * It is NOT ZATCA Phase 2 compliance. A Phase 2 simplified tax invoice QR
 * carries tags 1-9: this module's five, plus the invoice hash (6), the ECDSA
 * cryptographic stamp (7), that stamp's public key (8), and the ZATCA technical
 * CA signature over that public key (9). Those depend on a CSID issued per
 * device and on canonicalisation of the full UBL invoice.
 *
 * Ordering matters as much as content: hashing, stamping and the tag 1-9 QR all
 * happen locally *before* the customer receives the document. Only reporting to
 * the Authority may be queued and retried. See docs/architecture/zatca.md.
 *
 * Do not describe a build carrying only this module as Phase 2 ready.
 */
export const ZATCA_TAG = {
  SELLER_NAME: 1,
  VAT_REGISTRATION_NUMBER: 2,
  TIMESTAMP: 3,
  INVOICE_TOTAL_WITH_VAT: 4,
  VAT_TOTAL: 5,
} as const;

export type ZatcaTag = (typeof ZATCA_TAG)[keyof typeof ZATCA_TAG];

export interface TlvField {
  readonly tag: number;
  readonly value: string;
}

const encoder = new TextEncoder();

/**
 * Encode one field as tag, length, value.
 *
 * The length is the UTF-8 **byte** count, not the character count. An Arabic
 * seller name is roughly two bytes per letter, so a character count produces a
 * declared length shorter than the payload and the Authority's parser walks off
 * the end of the field. This distinction is the single most common cause of
 * rejected QR codes in Arabic deployments.
 */
export function encodeTlvField(field: TlvField): Uint8Array {
  if (!Number.isInteger(field.tag) || field.tag < 0 || field.tag > 0xff) {
    throw new TlvEncodingError(`TLV tag must be a byte, got ${String(field.tag)}.`);
  }

  const valueBytes = encoder.encode(field.value);
  if (valueBytes.length > 0xff) {
    throw new TlvEncodingError(
      `TLV value for tag ${String(field.tag)} is ${String(valueBytes.length)} bytes; ` +
        'the single-byte length field allows at most 255.',
    );
  }

  const out = new Uint8Array(2 + valueBytes.length);
  out[0] = field.tag;
  out[1] = valueBytes.length;
  out.set(valueBytes, 2);
  return out;
}

export function encodeTlv(fields: readonly TlvField[]): Uint8Array {
  const parts = fields.map(encodeTlvField);
  const total = parts.reduce((sum, part) => sum + part.length, 0);

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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
 * Build the Phase 1 QR payload.
 *
 * Pure and deterministic: identical input yields a byte-identical result on the
 * terminal and on the server, which is what makes an offline-generated receipt
 * verifiable after it syncs.
 */
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

export function simplifiedInvoiceQr(input: SimplifiedInvoiceQrInput): string {
  return bytesToBase64(encodeTlv(simplifiedInvoiceQrFields(input)));
}
