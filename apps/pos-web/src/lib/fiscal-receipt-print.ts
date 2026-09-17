import {
  EPSON_TM_T20,
  escpos,
  qrCommand,
  rasterCommand,
} from '../../../../packages/printing/src/index';
import { formatMinor } from './money';
import { formatScaled } from './quantity';
import type {
  EscPosBuilder,
  RasterRenderer,
} from '../../../../packages/printing/src/index';
import type { FiscalReceipt, SaleSummary } from './api-types';

export interface ReceiptPrintJob {
  readonly payload: readonly number[];
}

function isAscii(value: string): boolean {
  return [...value].every((character) => (character.codePointAt(0) ?? 0) < 0x80);
}

async function appendReceiptLine(
  builder: EscPosBuilder,
  value: string,
  rasterRenderer: RasterRenderer,
): Promise<void> {
  if (isAscii(value)) {
    builder.line(value);
    return;
  }

  const widthInDots = builder.profile.capabilities.dotsPerLine;
  const bitmap = await rasterRenderer.renderLine(value, widthInDots);
  if (bitmap.width > widthInDots) {
    throw new Error('fiscal receipt raster line exceeds printer width');
  }
  builder.raw(rasterCommand(bitmap)).raw(Uint8Array.from([0x0a]));
}

/**
 * Render the server-authored fiscal truth for the verified 80mm ESC/POS path.
 *
 * This layer is deliberately downstream from checkout: it never computes VAT,
 * seals an invoice, advances ICV/PIH, or derives QR contents. The exact persisted
 * Phase-2 QR string returned by the server is stored in the printer's native QR
 * buffer and printed as a scannable symbol.
 *
 * Required Arabic merchant/item/customer-facing facts use the same offline
 * raster boundary as preparation printing. ASCII document facts remain native.
 */
export async function renderFiscalReceiptEscPos(
  sale: SaleSummary,
  receipt: FiscalReceipt,
  rasterRenderer: RasterRenderer,
): Promise<ReceiptPrintJob> {
  if (
    sale.invoiceNumber !== receipt.invoiceNumber ||
    sale.issuedAt !== receipt.issuedAt ||
    sale.currency !== receipt.currency ||
    sale.netMinor !== receipt.netMinor ||
    sale.vatMinor !== receipt.vatMinor ||
    sale.totalMinor !== receipt.totalMinor
  ) {
    throw new Error('fiscal receipt does not match the finalized sale');
  }
  if (receipt.invoiceHashBase64.trim() === '' || receipt.qrCodeBase64.trim() === '') {
    throw new Error('fiscal receipt is missing sealed evidence');
  }

  const builder = escpos(EPSON_TM_T20).initialise().align('center').bold(true);
  await appendReceiptLine(builder, receipt.sellerName, rasterRenderer);
  builder.bold(false);
  await appendReceiptLine(
    builder,
    `الرقم الضريبي: ${receipt.vatRegistrationNumber}`,
    rasterRenderer,
  );
  await appendReceiptLine(builder, 'فاتورة ضريبية مبسطة', rasterRenderer);

  builder.rule().align('start');
  builder.line(`Invoice ${receipt.invoiceNumber}`);
  builder.line(receipt.issuedAt);
  builder.rule();

  for (const line of receipt.lines) {
    await appendReceiptLine(builder, line.description, rasterRenderer);
    builder.line(
      `QTY ${formatScaled(line.quantityScaled)}  TOTAL ${formatMinor(line.totalMinor)} ${receipt.currency}`,
    );
  }

  builder.rule();
  await appendReceiptLine(
    builder,
    `الإجمالي قبل الضريبة: ${formatMinor(receipt.netMinor)} ${receipt.currency}`,
    rasterRenderer,
  );
  await appendReceiptLine(
    builder,
    `ضريبة القيمة المضافة: ${formatMinor(receipt.vatMinor)} ${receipt.currency}`,
    rasterRenderer,
  );
  builder.bold(true);
  await appendReceiptLine(
    builder,
    `الإجمالي: ${formatMinor(receipt.totalMinor)} ${receipt.currency}`,
    rasterRenderer,
  );
  builder.bold(false);
  builder.line(`Hash ${receipt.invoiceHashBase64}`).feed(1);

  builder.align('center').raw(qrCommand(EPSON_TM_T20, receipt.qrCodeBase64)).feed(1);
  await appendReceiptLine(builder, 'صُدرت عبر Korvi', rasterRenderer);
  builder.feed(2).cut();

  return { payload: Array.from(builder.build()) };
}
