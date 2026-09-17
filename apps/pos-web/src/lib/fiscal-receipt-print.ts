import { EPSON_TM_T20, escpos, qrCommand } from '../../../../packages/printing/src/index';
import type { FiscalReceipt, SaleSummary } from './api-types';

export interface ReceiptPrintJob {
  readonly payload: readonly number[];
}

/**
 * Render the server-authored fiscal truth for the verified 80mm ESC/POS path.
 *
 * This layer is deliberately downstream from checkout: it never computes VAT,
 * seals an invoice, advances ICV/PIH, or derives QR contents. The exact persisted
 * Phase-2 QR string returned by the server is stored in the printer's native QR
 * buffer and printed as a scannable symbol.
 */
export function renderFiscalReceiptEscPos(
  sale: SaleSummary,
  receipt: FiscalReceipt,
): ReceiptPrintJob {
  if (sale.invoiceNumber !== receipt.invoiceNumber || sale.issuedAt !== receipt.issuedAt) {
    throw new Error('fiscal receipt does not match the finalized sale');
  }
  if (receipt.invoiceHashBase64.trim() === '' || receipt.qrCodeBase64.trim() === '') {
    throw new Error('fiscal receipt is missing sealed evidence');
  }

  const builder = escpos(EPSON_TM_T20)
    .initialise()
    .align('center')
    .line('KORVI')
    .line(`Invoice ${receipt.invoiceNumber}`)
    .line(receipt.issuedAt)
    .line(`Total ${sale.totalMinor} ${sale.currency}`)
    .line(`VAT ${sale.vatMinor}`)
    .line(`Hash ${receipt.invoiceHashBase64}`)
    .feed(1)
    .raw(qrCommand(EPSON_TM_T20, receipt.qrCodeBase64))
    .feed(2)
    .cut();

  return { payload: Array.from(builder.build()) };
}
