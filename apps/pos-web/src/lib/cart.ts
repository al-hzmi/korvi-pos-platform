import { QUANTITY_SCALE, basisPoints, money, priceCart, quantity } from '@korvi/domain';
import { addScaled, stepScaled } from './quantity';
import type { ProductSummary } from './api-types';
import type { CartLineInput, PriceMode, PricedCart, ProductType } from '@korvi/domain';

/**
 * The basket, as local intent.
 *
 * Nothing here is persisted and nothing here is authoritative. It is a record
 * of what the cashier has said they want to sell, kept only long enough to be
 * sent as product ids and quantities.
 *
 * One line per product, always. The server refuses a duplicate product line —
 * two lines each pass a stock check their sum fails — so a second scan of the
 * same item adds to the line that already exists rather than making a new one.
 * `productId` is the identity of a line for exactly that reason.
 */

export interface CartLine {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string | null;
  /** Snapshot of the price the catalogue showed. For display only. */
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: number;
  readonly quantityScaled: string;
}

export type CartAction =
  | { readonly type: 'add'; readonly product: ProductSummary }
  | { readonly type: 'set-quantity'; readonly productId: string; readonly quantityScaled: string }
  | { readonly type: 'step'; readonly productId: string; readonly direction: 1 | -1 }
  | { readonly type: 'remove'; readonly productId: string }
  | { readonly type: 'clear' };

function lineFor(product: ProductSummary, quantityScaled: string): CartLine {
  return {
    productId: product.id,
    sku: product.sku,
    nameAr: product.nameAr,
    nameEn: product.nameEn,
    productType: product.productType,
    unitLabel: product.unitLabel,
    unitPriceMinor: product.priceMinor,
    vatBasisPoints: product.vatBasisPoints,
    quantityScaled,
  };
}

export function cartReducer(lines: readonly CartLine[], action: CartAction): readonly CartLine[] {
  switch (action.type) {
    case 'add': {
      const existing = lines.find((line) => line.productId === action.product.id);
      if (existing === undefined) {
        return [...lines, lineFor(action.product, QUANTITY_SCALE.toString())];
      }
      // Merged, not appended. A cashier scanning the same tin twice means two
      // tins, and the receipt should say so on one line.
      return lines.map((line) =>
        line.productId === action.product.id
          ? { ...line, quantityScaled: addScaled(line.quantityScaled, QUANTITY_SCALE.toString()) }
          : line,
      );
    }
    case 'set-quantity':
      return lines.map((line) =>
        line.productId === action.productId
          ? { ...line, quantityScaled: action.quantityScaled }
          : line,
      );
    case 'step':
      return lines.map((line) => {
        if (line.productId !== action.productId) return line;
        // Whole-unit steps belong to whole-unit products. A weighed line is
        // 0.750 kg, not "one of something", and stepping it by a unit is
        // meaningless in one direction and dangerous in the other. The screen
        // does not offer the controls; this makes the action itself inert, so
        // a future caller cannot reintroduce the bug.
        if (line.productType !== 'unit') return line;
        return { ...line, quantityScaled: stepScaled(line.quantityScaled, action.direction) };
      });
    case 'remove':
      return lines.filter((line) => line.productId !== action.productId);
    case 'clear':
      return [];
  }
}

/**
 * What the till expects the sale to come to, using the domain's own arithmetic.
 *
 * Not authoritative and never sent: the server re-prices everything from its
 * own catalogue, and the figures on the completed sale replace these entirely.
 * It exists so the total does not lag a scan behind the cashier's hands.
 *
 * `priceCart` rather than a local multiplication, so the preview and the sale
 * round identically — a preview that disagrees with the receipt by one halala
 * is worse than no preview.
 *
 * The price mode is a parameter and has no default. It comes from
 * `tenant_settings` by way of GET /v1/terminals, because a merchant selling
 * tax-exclusive would otherwise be shown a total short by the VAT, and a
 * hardcoded assumption is exactly the kind of thing nobody notices until an
 * auditor does.
 */
export function previewCart(lines: readonly CartLine[], priceMode: PriceMode): PricedCart {
  return priceCart({
    priceMode,
    currency: 'SAR',
    lines: lines.map((line, index): CartLineInput => ({
      lineId: String(index + 1),
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      unitPrice: money(BigInt(line.unitPriceMinor), 'SAR'),
      quantity: quantity(BigInt(line.quantityScaled)),
      vatRate: basisPoints(line.vatBasisPoints),
      isWeighted: line.productType === 'weighted',
    })),
  });
}

/** Ids and quantities. The whole of what a basket is allowed to assert. */
export function cartToRequestLines(
  lines: readonly CartLine[],
): readonly { readonly productId: string; readonly quantityScaled: string }[] {
  return lines.map((line) => ({
    productId: line.productId,
    quantityScaled: line.quantityScaled,
  }));
}
