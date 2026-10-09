import type { RestaurantOrderType } from '@korvi/domain';
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
  readonly orderType: RestaurantOrderType | null;
  readonly createdAt: string;
  readonly items: readonly PreparationTicketItem[];
}

export type PreparationTicketPrinter = (ticket: PreparationTicket) => Promise<void>;

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
    orderType: sale.orderType ?? null,
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
    orderType: intent.orderType ?? null,
    createdAt,
    items,
  };
}
