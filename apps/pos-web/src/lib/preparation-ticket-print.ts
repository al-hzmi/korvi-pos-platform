import { EPSON_TM_T20, escpos, rasterCommand } from '../../../../packages/printing/src/index';
import { formatScaled } from './quantity';
import { restaurantOrderTypeLabelAr } from './quick-service';
import type { EscPosBuilder, RasterRenderer } from '../../../../packages/printing/src/index';
import type { PreparationTicket } from './preparation-ticket';

export interface PreparationPrintJob {
  readonly payload: readonly number[];
}

function isAscii(value: string): boolean {
  return [...value].every((character) => (character.codePointAt(0) ?? 0) < 0x80);
}

async function appendOperationalLine(
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
    throw new Error('preparation raster line exceeds printer width');
  }
  builder.raw(rasterCommand(bitmap)).raw(Uint8Array.from([0x0a]));
}

/**
 * Explicitly NON-FISCAL. No price, VAT, invoice number, hash, QR, ICV or PIH
 * exists in this model or renderer.
 *
 * ASCII remains on the verified native path. Every line containing Arabic or
 * other non-ASCII operational text is rendered by the host's offline raster
 * text renderer and emitted as GS v 0 bitmap data.
 */
export async function renderPreparationTicketEscPos(
  ticket: PreparationTicket,
  rasterRenderer: RasterRenderer,
): Promise<PreparationPrintJob> {
  if (ticket.items.length === 0) throw new Error('preparation ticket has no items');

  const builder = escpos(EPSON_TM_T20)
    .initialise()
    .align('center')
    .bold(true)
    .doubleHeight(true)
    .line(`ORDER ${ticket.orderNumber}`)
    .doubleHeight(false)
    .line('NON-FISCAL / PREPARATION')
    .bold(false);

  await appendOperationalLine(builder, 'تذكرة تحضير - غير ضريبية', rasterRenderer);
  if (ticket.orderType !== null) {
    await appendOperationalLine(
      builder,
      `نوع الطلب: ${restaurantOrderTypeLabelAr(ticket.orderType)}`,
      rasterRenderer,
    );
  }
  builder.rule().align('start');

  for (const item of ticket.items) {
    builder.bold(true);
    await appendOperationalLine(
      builder,
      `${formatScaled(item.quantityScaled)} x ${item.nameAr}`,
      rasterRenderer,
    );
    builder.bold(false);
    if (item.options !== '') {
      await appendOperationalLine(builder, `خيارات: ${item.options}`, rasterRenderer);
    }
    if (item.note !== '') {
      await appendOperationalLine(builder, `ملاحظة: ${item.note}`, rasterRenderer);
    }
    builder.line();
  }

  return { payload: Array.from(builder.rule().feed(2).cut().build()) };
}
