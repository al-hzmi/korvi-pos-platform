import { describe, expect, it } from 'vitest';
import { money } from '../../money/money.js';
import { quantity } from '../../quantity/quantity.js';
import { basisPoints } from '../../tax/basis-points.js';
import { priceCart } from '../line.js';
import type { CartLineInput, PriceMode } from '../line.js';

/**
 * The invariant a receipt lives or dies by.
 *
 * gross - line discounts - basket discount = net, net + VAT = total, and the
 * per-line shares of a basket discount sum to the basket discount exactly. The
 * awkward numbers below are the point: a discount that does not divide evenly
 * across lines is where a halala goes missing, and a receipt that is one
 * halala out is a receipt a merchant cannot sign.
 */
function line(id: string, unit: bigint, qty: bigint, rate = 1_500): CartLineInput {
  return {
    lineId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    nameAr: 'صنف',
    nameEn: null,
    unitPrice: money(unit),
    quantity: quantity(qty),
    vatRate: basisPoints(rate),
  };
}

function reconciles(mode: PriceMode, input: Parameters<typeof priceCart>[0]): void {
  const priced = priceCart({ ...input, priceMode: mode });

  const lineSum = priced.lines.reduce((total, entry) => total + entry.net.minor, 0n);
  const vatSum = priced.lines.reduce((total, entry) => total + entry.vat.minor, 0n);
  const basketShares = priced.lines.reduce(
    (total, entry) => total + entry.basketDiscount.minor,
    0n,
  );
  const lineShares = priced.lines.reduce((total, entry) => total + entry.lineDiscount.minor, 0n);

  // The parts are the whole. Not approximately.
  expect(basketShares).toBe(priced.basketDiscountTotal.minor);
  expect(lineShares).toBe(priced.lineDiscountTotal.minor);
  expect(lineSum).toBe(priced.net.minor);
  expect(vatSum).toBe(priced.vat.minor);
  expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);

  for (const entry of priced.lines) {
    expect(entry.net.minor).toBeGreaterThanOrEqual(0n);
    expect(entry.lineDiscount.minor + entry.basketDiscount.minor).toBeLessThanOrEqual(
      entry.gross.minor,
    );
  }
}

describe('discount allocation', () => {
  it.each(['tax-inclusive', 'tax-exclusive'] as const)(
    'splits an indivisible basket discount exactly (%s)',
    (mode) => {
      // 1 halala across three lines: somebody gets it, deterministically, and
      // the shares still sum to 1.
      reconciles(mode, {
        priceMode: mode,
        lines: [line('a', 333n, 1_000n), line('b', 333n, 1_000n), line('c', 333n, 1_000n)],
        basketDiscount: { kind: 'fixed', value: 1n },
      });
    },
  );

  it.each(['tax-inclusive', 'tax-exclusive'] as const)(
    'splits an awkward percentage of an awkward basket (%s)',
    (mode) => {
      reconciles(mode, {
        priceMode: mode,
        lines: [
          line('a', 1_999n, 3_000n),
          line('b', 777n, 1_250n),
          line('c', 1n, 7_000n),
          line('d', 45_037n, 1_000n, 500),
        ],
        basketDiscount: { kind: 'percentage', value: 1_337n },
      });
    },
  );

  it('reconciles line and basket discounts together', () => {
    reconciles('tax-inclusive', {
      priceMode: 'tax-inclusive',
      lines: [
        { ...line('a', 1_150n, 2_000n), discount: { kind: 'percentage', value: 1_000n } },
        { ...line('b', 2_400n, 1_500n), discount: { kind: 'fixed', value: 7n } },
        line('c', 99n, 3_333n),
      ],
      basketDiscount: { kind: 'fixed', value: 1_111n },
    });
  });

  it('never discounts a line below nothing', () => {
    // A basket discount larger than the basket cannot make a line owe money.
    reconciles('tax-inclusive', {
      priceMode: 'tax-inclusive',
      lines: [line('a', 100n, 1_000n), line('b', 200n, 1_000n)],
      basketDiscount: { kind: 'fixed', value: 999_999n },
    });
  });

  it('allocates the same way every time', () => {
    const input = {
      priceMode: 'tax-inclusive' as const,
      lines: [line('a', 333n, 1_000n), line('b', 333n, 1_000n), line('c', 334n, 1_000n)],
      basketDiscount: { kind: 'fixed' as const, value: 5n },
    };
    const first = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    const second = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    expect(first).toEqual(second);
    expect(first.reduce((total, share) => total + share, 0n)).toBe(5n);
  });
});
