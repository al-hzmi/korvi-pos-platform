import { EPSON_TM_T20, escpos } from '../../../../packages/printing/src/index';
import { formatScaled } from './quantity';
import type { SaleSummary } from './api-types';
import type { CartLine } from './cart';
import type { CheckoutIntent } from './checkout-flight';

export interface PreparationTicketItem {
  readonly productId: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly options: string;
  readonly note: string;
}

export interface PreparationTicket {
  readonly kind: 'preparation';
  readonly sourceOperationId: string;
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly items: readonly PreparationTicketItem[];
}

export type PreparationTicketPrinter = (ticket: PreparationTicket) => Promise<void>;

export interface PreparationPrintJob {
  readonly payload: readonly number[];
}

function operationalMetadata(line: CartLine | undefined): { options: string; note: string } {
  return {
    options: line?.preparationOptions?.trim() ?? '',
    note: line?.preparationNote?.trim() ?? '',
  };
}

/**
 * Build operational kitchen/bar output from an already-finalized sale.
 * Quantity/name come from the server sale truth; only non-financial preparation
 * annotations come from the still-locked local basket.
 */
export function preparationTicketFromSale(
  sale: SaleSummary,
  cartLines: readonly CartLine[],
  orderNumber: string,
): PreparationTicket {
  const byProduct = new Map(cartLines.map((line) => [line.productId, line] as const));
  return {
    kind: 'preparation',
    sourceOperationId: sale.operationId,
    orderNumber,
    createdAt: sale.issuedAt,
    items: sale.lines.map((line) => {
      const local = line.productId === null ? undefined : byProduct.get(line.productId);
      return {
        productId: line.productId ?? '',
        nameAr: line.nameAr,
        quantityScaled: line.quantityScaled,
        ...operationalMetadata(local),
      };
    }),
  };
}

/**
 * Offline counter-service may prepare from the exact immutable checkout intent.
 * This produces no fiscal artefact and has no write path back into checkout.
 */
export function preparationTicketFromIntent(
  intent: CheckoutIntent,
  cartLines: readonly CartLine[],
  orderNumber: string,
  createdAt: string,
): PreparationTicket {
  const byProduct = new Map(cartLines.map((line) => [line.productId, line] as const));
  const items = intent.lines.map((line) => {
    const local = byProduct.get(line.productId);
    if (local === undefined) {
      throw new Error('preparation intent does not match the locked cart snapshot');
    }
    return {
      productId: line.productId,
      nameAr: local.nameAr,
      quantityScaled: line.quantityScaled,
      ...operationalMetadata(local),
    };
  });
  return {
    kind: 'preparation',
    sourceOperationId: intent.operationId,
    orderNumber,
    createdAt,
    items,
  };
}

/**
 * Explicitly NON-FISCAL. No price, VAT, invoice number, hash, QR, ICV or PIH
 * exists in this model or renderer.
 */
export function renderPreparationTicketEscPos(
  ticket: PreparationTicket,
): PreparationPrintJob {
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
    builder.bold(true).line(`${formatScaled(item.quantityScaled)} x ${item.nameAr}`).bold(false);
    if (item.options !== '') builder.line(`خيارات: ${item.options}`);
    if (item.note !== '') builder.line(`ملاحظة: ${item.note}`);
    builder.line();
  }

  return { payload: Array.from(builder.rule().feed(2).cut().build()) };
}
