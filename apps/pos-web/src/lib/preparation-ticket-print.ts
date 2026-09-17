import { EPSON_TM_T20, escpos } from '../../../../packages/printing/src/index';
import { formatScaled } from './quantity';
import type { PreparationTicket } from './preparation-ticket';

export interface PreparationPrintJob {
  readonly payload: readonly number[];
}

/**
 * Explicitly NON-FISCAL. No price, VAT, invoice number, hash, QR, ICV or PIH
 * exists in this model or renderer.
 */
export function renderPreparationTicketEscPos(ticket: PreparationTicket): PreparationPrintJob {
  if (ticket.items.length === 0) throw new Error('preparation ticket has no items');

  const builder = escpos(EPSON_TM_T20)
    .initialise()
    .align('center')
    .bold(true)
    .doubleHeight(true)
    .line(`ORDER ${ticket.orderNumber}`)
    .doubleHeight(false)
    .line('NON-FISCAL / PREPARATION')
    .line('تذكرة تحضير - غير ضريبية')
    .bold(false)
    .rule()
    .align('start');

  for (const item of ticket.items) {
    builder
      .bold(true)
      .line(`${formatScaled(item.quantityScaled)} x ${item.nameAr}`)
      .bold(false);
    if (item.options !== '') builder.line(`خيارات: ${item.options}`);
    if (item.note !== '') builder.line(`ملاحظة: ${item.note}`);
    builder.line();
  }

  return { payload: Array.from(builder.rule().feed(2).cut().build()) };
}
