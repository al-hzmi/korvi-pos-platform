import { describe, expect, it } from 'vitest';
import { renderFiscalReceiptEscPos } from '../fiscal-receipt-print';
import type { FiscalReceipt, SaleSummary } from '../api-types';

const sale: SaleSummary = {
  saleId: '018f1000-0000-7000-8000-0000000000c1',
  operationId: '018f1000-0000-7000-8000-0000000000c2',
  sequence: 42,
  invoiceNumber: 'INV-42',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  branchId: '018f1000-0000-7000-8000-0000000000c3',
  terminalId: '018f1000-0000-7000-8000-0000000000c4',
  shiftId: '018f1000-0000-7000-8000-0000000000c5',
  cashierName: 'Cashier',
  lines: [],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '2500',
  changeMinor: '200',
};

const receipt: FiscalReceipt = {
  invoiceId: '018f1000-0000-7000-8000-0000000000d1',
  invoiceNumber: 'INV-42',
  issuedAt: '2026-09-17T12:00:00Z',
  invoiceHashBase64: 'AQID',
  qrCodeBase64: 'PERSISTED_PHASE_2_QR_123+/=',
};

function containsBytes(haystack: readonly number[], needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

describe('fiscal receipt ESC/POS rendering', () => {
  it('stores the exact persisted Phase-2 QR payload in a native ESC/POS QR command', () => {
    const { payload } = renderFiscalReceiptEscPos(sale, receipt);
    const encoder = new TextEncoder();

    expect(containsBytes(payload, Uint8Array.from([0x1d, 0x28, 0x6b]))).toBe(true);
    expect(containsBytes(payload, encoder.encode(receipt.qrCodeBase64))).toBe(true);
    expect(containsBytes(payload, encoder.encode(`QR ${receipt.qrCodeBase64}`))).toBe(false);
    expect(containsBytes(payload, encoder.encode(`Hash ${receipt.invoiceHashBase64}`))).toBe(true);
  });

  it('refuses to combine fiscal evidence with a different finalized sale', () => {
    expect(() =>
      renderFiscalReceiptEscPos({ ...sale, invoiceNumber: 'INV-OTHER' }, receipt),
    ).toThrow(/does not match/);
  });

  it('refuses missing sealed QR or invoice-hash evidence instead of printing fake success', () => {
    expect(() => renderFiscalReceiptEscPos(sale, { ...receipt, qrCodeBase64: ' ' })).toThrow(
      /missing sealed evidence/,
    );
    expect(() => renderFiscalReceiptEscPos(sale, { ...receipt, invoiceHashBase64: '' })).toThrow(
      /missing sealed evidence/,
    );
  });
});
