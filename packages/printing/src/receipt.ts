import { moneyToMajorString } from '@korvi/domain';
import type { Money } from '@korvi/domain';
import { escpos, twoColumn } from './escpos.js';
import { qrCommand } from './qr.js';
import { rasterCommand } from './raster.js';
import { MissingCapabilityError } from './errors.js';
import type { RasterBitmap } from './raster.js';
import type { PrinterProfile } from './profiles/types.js';

export interface ReceiptLine {
  readonly description: string;
  readonly quantity: number;
  readonly lineTotal: Money;
}

export interface ReceiptData {
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  readonly invoiceNumber: string;
  readonly timestamp: string;
  readonly lines: readonly ReceiptLine[];
  readonly net: Money;
  readonly vat: Money;
  readonly total: Money;
  /** Base64 TLV from `@korvi/domain`. Rendered here as an actual symbol. */
  readonly qrPayload: string;
}

export interface RenderOptions {
  /**
   * Pre-rendered QR bitmap, required when the profile declares `qr: 'raster'`.
   *
   * Supplied by the caller rather than produced here: rendering needs a QR
   * encoder and a bitmap surface, which are Phase 1 dependencies.
   */
  readonly qrBitmap?: RasterBitmap;
}

/**
 * Render a simplified tax invoice for a specific device.
 *
 * The QR is emitted as a real symbol — natively where the firmware supports it,
 * otherwise from a supplied bitmap. If neither is possible the function throws.
 * That refusal is deliberate: a simplified tax invoice without a scannable QR
 * is not a valid simplified tax invoice, and printing one anyway would hand the
 * merchant a document that fails inspection without anyone noticing at the till.
 *
 * The Korvi mark is deliberately absent from the header: that header identifies
 * the merchant who made the sale, and putting the software vendor there tells
 * an auditor Korvi sold the goods. Footer only. See KORVI-DESIGN-SYSTEM.md §8.
 */
export function renderReceipt(
  profile: PrinterProfile,
  data: ReceiptData,
  options: RenderOptions = {},
): Uint8Array {
  if (data.qrPayload.trim() === '') {
    throw new MissingCapabilityError(
      'A simplified tax invoice needs its ZATCA QR payload; refusing to print one without it.',
    );
  }

  const builder = escpos(profile).initialise();
  const width = profile.capabilities.columns;

  builder.align('center').bold(true).doubleHeight(true).line(data.sellerName);
  builder.doubleHeight(false).bold(false);
  builder.line(`الرقم الضريبي: ${data.vatRegistrationNumber}`);
  builder.line('فاتورة ضريبية مبسطة');
  builder.rule();

  builder.align('start');
  builder.line(twoColumn('رقم الفاتورة', data.invoiceNumber, width));
  builder.line(twoColumn('التاريخ', data.timestamp, width));
  builder.rule();

  for (const line of data.lines) {
    builder.line(line.description);
    // ASCII "x", not U+00D7. The multiplication sign is absent from CP864 and
    // from several vendor code pages, so using it would make the quantity line
    // unprintable on exactly the hardware this layer exists to support.
    builder.line(
      twoColumn(`  x ${String(line.quantity)}`, moneyToMajorString(line.lineTotal), width),
    );
  }

  builder.rule();
  builder.line(twoColumn('الإجمالي قبل الضريبة', moneyToMajorString(data.net), width));
  builder.line(twoColumn('ضريبة القيمة المضافة', moneyToMajorString(data.vat), width));
  builder.bold(true);
  builder.line(twoColumn('الإجمالي', moneyToMajorString(data.total), width));
  builder.bold(false);
  builder.rule();

  // --- the QR itself ------------------------------------------------------
  builder.align('center');
  switch (profile.capabilities.qr) {
    case 'native':
      builder.raw(qrCommand(profile, data.qrPayload));
      break;
    case 'raster': {
      if (options.qrBitmap === undefined) {
        throw new MissingCapabilityError(
          `Profile "${profile.id}" has no QR firmware, so a rendered bitmap must be supplied. ` +
            'Refusing to print a simplified tax invoice without a scannable symbol.',
        );
      }
      builder.raw(rasterCommand(options.qrBitmap));
      break;
    }
    case 'none':
      throw new MissingCapabilityError(
        `Profile "${profile.id}" cannot print a QR code, so it cannot produce a compliant ` +
          'simplified tax invoice.',
      );
  }

  builder.line();
  builder.line('صُدرت عبر Korvi');
  builder.feed(2).cut();

  return builder.build();
}
