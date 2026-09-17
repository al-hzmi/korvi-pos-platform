import type { FiscalReceipt, SaleSummary } from './api-types';

export interface ReceiptPrintJob {
  readonly payload: readonly number[];
}

const encoder = new TextEncoder();

function line(value = ''): number[] {
  return [...encoder.encode(value), 0x0a];
}

function command(...bytes: number[]): number[] {
  return bytes;
}

/**
 * Render a conservative ESC/POS receipt from server-authored sale + fiscal receipt.
 *
 * Fiscal values are copied verbatim. This renderer never computes tax, hashes,
 * invoice identifiers, or QR content. Reprinting the same response therefore
 * emits the same fiscal truth without issuing or sealing another invoice.
 */
export function renderFiscalReceiptEscPos(
  sale: SaleSummary,
  receipt: FiscalReceipt,
): ReceiptPrintJob {
  if (sale.invoiceNumber !== receipt.invoiceNumber || sale.issuedAt !== receipt.issuedAt) {
    throw new Error('fiscal receipt does not match the finalized sale');
  }

  const payload = [
    ...command(0x1b, 0x40),
    ...command(0x1b, 0x61, 0x01),
    ...line('KORVI'),
    ...line(`Invoice ${receipt.invoiceNumber}`),
    ...line(receipt.issuedAt),
    ...line(`Total ${sale.totalMinor} ${sale.currency}`),
    ...line(`VAT ${sale.vatMinor}`),
    ...line(`Hash ${receipt.invoiceHashBase64}`),
    ...line(`QR ${receipt.qrCodeBase64}`),
    ...line(),
    ...command(0x1d, 0x56, 0x00),
  ];

  return { payload };
}
