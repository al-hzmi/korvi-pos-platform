import type { RestaurantOrderDetail, RestaurantOrderReplaceLine } from './api-types';
import type { CartLine } from './cart';

export interface ActiveRestaurantOrder {
  readonly id: string;
  readonly revision: string;
}

export function cartLinesFromRestaurantOrder(order: RestaurantOrderDetail): readonly CartLine[] {
  return order.lines.map((line) => ({
    productId: line.productId,
    sku: line.sku,
    nameAr: line.nameAr,
    nameEn: line.nameEn,
    productType: line.productType,
    unitLabel: null,
    unitPriceMinor: line.unitPriceMinor,
    vatBasisPoints: line.vatBasisPoints,
    quantityScaled: line.quantityScaled,
    restaurantOrderLineId: line.id,
    preparationNote: line.preparationNote ?? '',
    preparationOptions: line.preparationOptions ?? '',
  }));
}

export function restaurantOrderLinesFromCart(
  lines: readonly CartLine[],
): readonly RestaurantOrderReplaceLine[] {
  return lines.map((line) => ({
    ...(line.restaurantOrderLineId === undefined
      ? { productId: line.productId }
      : { lineId: line.restaurantOrderLineId }),
    quantityScaled: line.quantityScaled,
    preparationNote: line.preparationNote?.trim() || null,
    preparationOptions: line.preparationOptions?.trim() || null,
  }));
}
