import { InvalidAmountError } from '../errors.js';
import { mulDivRound } from '../money/rounding.js';
import { allocate } from '../money/allocate.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';
import { BASIS_POINT_SCALE } from '../tax/basis-points.js';
import type { Quantity } from '../quantity/quantity.js';
import type { BasisPoints } from '../tax/basis-points.js';
import type { Currency, Money } from '../money/money.js';

/**
 * Line and basket pricing.
 *
 * Everything here is integer arithmetic on halalas and scaled quantities. The
 * one place rounding happens per line is `extendedPrice`, and it is explicit.
 */

export type PriceMode = 'tax-exclusive' | 'tax-inclusive';

export type DiscountKind = 'none' | 'fixed' | 'percentage';

export interface Discount {
  readonly kind: DiscountKind;
  /** Halalas when `fixed`; basis points when `percentage`. Ignored for `none`. */
  readonly value: bigint;
  readonly reason?: string;
}

export const NO_DISCOUNT: Discount = { kind: 'none', value: 0n };

export interface CartLineInput {
  readonly lineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  /** Price of one whole unit, in the tenant's price mode. */
  readonly unitPrice: Money;
  readonly quantity: Quantity;
  readonly vatRate: BasisPoints;
  readonly discount?: Discount;
  readonly isWeighted?: boolean;
}

export interface PricedLine {
  readonly lineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly vatRate: BasisPoints;
  /** quantity x unitPrice, before any discount. */
  readonly gross: Money;
  readonly lineDiscount: Money;
  /** Share of a basket-level discount allocated to this line. */
  readonly basketDiscount: Money;
  /** gross - lineDiscount - basketDiscount, tax exclusive. */
  readonly net: Money;
  readonly vat: Money;
  /** net + vat. */
  readonly total: Money;
}

/**
 * quantity x unitPrice, rounded once, half-up.
 *
 * `quantity` is scaled by 1000, so the division by QUANTITY_SCALE is part of
 * the same integer expression rather than a separate lossy step.
 */
export function extendedPrice(unitPrice: Money, qty: Quantity): Money {
  return { currency: unitPrice.currency, minor: mulDivRound(unitPrice.minor, qty, QUANTITY_SCALE) };
}

export function applyDiscount(base: Money, discount: Discount): Money {
  switch (discount.kind) {
    case 'none':
      return { currency: base.currency, minor: 0n };
    case 'fixed': {
      if (discount.value < 0n) throw new InvalidAmountError('Discount must not be negative.');
      // Never more than the line is worth: a discount cannot create money.
      return {
        currency: base.currency,
        minor: discount.value > base.minor ? base.minor : discount.value,
      };
    }
    case 'percentage': {
      if (discount.value < 0n || discount.value > BASIS_POINT_SCALE) {
        throw new InvalidAmountError('Percentage discount must be between 0 and 10000 bp.');
      }
      return {
        currency: base.currency,
        minor: mulDivRound(base.minor, discount.value, BASIS_POINT_SCALE),
      };
    }
  }
}

export interface PriceCartInput {
  readonly currency?: Currency;
  readonly priceMode: PriceMode;
  readonly lines: readonly CartLineInput[];
  readonly basketDiscount?: Discount;
}

export interface PricedCart {
  readonly lines: readonly PricedLine[];
  readonly gross: Money;
  readonly lineDiscountTotal: Money;
  readonly basketDiscountTotal: Money;
  readonly net: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly vatBreakdown: readonly VatBucket[];
}

/** One row per distinct rate. ZATCA requires the split, not just the sum. */
export interface VatBucket {
  readonly rate: BasisPoints;
  readonly net: Money;
  readonly vat: Money;
}

const money = (minor: bigint, currency: Currency): Money => ({ currency, minor });

/**
 * Price a whole cart deterministically.
 *
 * Order matters and is fixed: extend each line, apply its own discount, then
 * allocate any basket discount across the discounted line values, then compute
 * VAT per line from the final taxable base.
 *
 * The basket discount is allocated with the same largest-remainder routine used
 * for money everywhere else, so the parts sum exactly to the discount. Applying
 * a percentage to each line independently would not — the halalas would not add
 * up, and the receipt would not reconcile.
 */
export function priceCart(input: PriceCartInput): PricedCart {
  const currency: Currency = input.currency ?? 'SAR';
  const zero = money(0n, currency);

  const staged = input.lines.map((line) => {
    const gross = extendedPrice(line.unitPrice, line.quantity);
    const lineDiscount = applyDiscount(gross, line.discount ?? NO_DISCOUNT);
    return { line, gross, lineDiscount, afterLine: gross.minor - lineDiscount.minor };
  });

  const afterLineTotal = staged.reduce((sum, entry) => sum + entry.afterLine, 0n);

  const basketDiscountTotal = applyDiscount(
    money(afterLineTotal, currency),
    input.basketDiscount ?? NO_DISCOUNT,
  );

  const basketShares =
    basketDiscountTotal.minor === 0n
      ? staged.map(() => 0n)
      : allocate(
          basketDiscountTotal.minor,
          staged.map((entry) => entry.afterLine),
        );

  const lines: PricedLine[] = staged.map((entry, index) => {
    const basketDiscount = money(basketShares[index] ?? 0n, currency);
    const discounted = entry.afterLine - basketDiscount.minor;

    // Tax-inclusive prices carry VAT inside the figure the customer sees, so
    // the net is extracted rather than added.
    const net =
      input.priceMode === 'tax-inclusive'
        ? discounted -
          mulDivRound(discounted, entry.line.vatRate, BASIS_POINT_SCALE + entry.line.vatRate)
        : discounted;
    const vat =
      input.priceMode === 'tax-inclusive'
        ? discounted - net
        : mulDivRound(discounted, entry.line.vatRate, BASIS_POINT_SCALE);

    return {
      lineId: entry.line.lineId,
      productId: entry.line.productId,
      sku: entry.line.sku,
      nameAr: entry.line.nameAr,
      nameEn: entry.line.nameEn,
      quantity: entry.line.quantity,
      unitPrice: entry.line.unitPrice,
      vatRate: entry.line.vatRate,
      gross: entry.gross,
      lineDiscount: entry.lineDiscount,
      basketDiscount,
      net: money(net, currency),
      vat: money(vat, currency),
      total: money(net + vat, currency),
    };
  });

  const sum = (pick: (line: PricedLine) => Money): Money =>
    money(
      lines.reduce((total, line) => total + pick(line).minor, 0n),
      currency,
    );

  const buckets = new Map<bigint, { net: bigint; vat: bigint }>();
  for (const line of lines) {
    const bucket = buckets.get(line.vatRate) ?? { net: 0n, vat: 0n };
    bucket.net += line.net.minor;
    bucket.vat += line.vat.minor;
    buckets.set(line.vatRate, bucket);
  }

  return {
    lines,
    gross: sum((line) => line.gross),
    lineDiscountTotal: sum((line) => line.lineDiscount),
    basketDiscountTotal: lines.length === 0 ? zero : sum((line) => line.basketDiscount),
    net: sum((line) => line.net),
    vat: sum((line) => line.vat),
    total: sum((line) => line.total),
    vatBreakdown: [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rate, bucket]) => ({
        rate: rate as BasisPoints,
        net: money(bucket.net, currency),
        vat: money(bucket.vat, currency),
      })),
  };
}
