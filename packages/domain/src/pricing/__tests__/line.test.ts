import { describe, expect, it } from 'vitest';
import { applyDiscount, extendedPrice, priceCart } from '../line.js';
import type { CartLineInput, PriceCartInput, PriceMode } from '../line.js';
import { money } from '../../money/money.js';
import { quantityFromDecimalString, units } from '../../quantity/quantity.js';
import { VAT_STANDARD_BP, VAT_ZERO_BP, basisPoints } from '../../tax/basis-points.js';
import { InvalidAmountError } from '../../errors.js';

const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  lineId: over.lineId ?? 'l1',
  productId: over.productId ?? 'p1',
  sku: over.sku ?? 'SKU-1',
  nameAr: over.nameAr ?? 'صنف',
  nameEn: over.nameEn ?? null,
  unitPrice: over.unitPrice ?? money(1_000n),
  quantity: over.quantity ?? units(1),
  vatRate: over.vatRate ?? VAT_STANDARD_BP,
  ...(over.discount === undefined ? {} : { discount: over.discount }),
  ...(over.isWeighted === undefined ? {} : { isWeighted: over.isWeighted }),
});

const cart = (over: Partial<PriceCartInput> = {}): PriceCartInput => ({
  priceMode: over.priceMode ?? 'tax-exclusive',
  lines: over.lines ?? [line()],
  ...(over.basketDiscount === undefined ? {} : { basketDiscount: over.basketDiscount }),
});

describe('extendedPrice', () => {
  it('multiplies whole units exactly', () => {
    expect(extendedPrice(money(1_000n), units(3)).minor).toBe(3_000n);
  });

  it('multiplies weighed quantities exactly', () => {
    expect(extendedPrice(money(1_200n), quantityFromDecimalString('0.25')).minor).toBe(300n);
  });
});

describe('applyDiscount', () => {
  it('caps a fixed discount at the line value — a discount cannot create money', () => {
    expect(applyDiscount(money(500n), { kind: 'fixed', value: 900n }).minor).toBe(500n);
  });

  it('computes a percentage in basis points', () => {
    expect(applyDiscount(money(1_000n), { kind: 'percentage', value: 1_000n }).minor).toBe(100n);
  });

  it('rejects a negative or out-of-range discount', () => {
    expect(() => applyDiscount(money(100n), { kind: 'fixed', value: -1n })).toThrow(
      InvalidAmountError,
    );
    expect(() => applyDiscount(money(100n), { kind: 'percentage', value: 10_001n })).toThrow(
      InvalidAmountError,
    );
  });

  it('treats none as zero', () => {
    expect(applyDiscount(money(100n), { kind: 'none', value: 0n }).minor).toBe(0n);
  });
});

describe('tax-exclusive pricing', () => {
  it('adds VAT on top of the net', () => {
    const priced = priceCart(cart({ lines: [line({ unitPrice: money(10_000n) })] }));
    expect(priced.net.minor).toBe(10_000n);
    expect(priced.vat.minor).toBe(1_500n);
    expect(priced.total.minor).toBe(11_500n);
  });

  it('prices a multi-line cart', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n), quantity: units(2) }),
          line({ lineId: 'b', unitPrice: money(2_500n), quantity: units(1) }),
        ],
      }),
    );
    expect(priced.gross.minor).toBe(4_500n);
    expect(priced.vat.minor).toBe(675n);
    expect(priced.total.minor).toBe(5_175n);
  });
});

describe('tax-inclusive pricing', () => {
  it('extracts VAT from the shelf price', () => {
    // 115.00 on the shelf at 15% is 100.00 net plus 15.00 VAT.
    const priced = priceCart(
      cart({ priceMode: 'tax-inclusive', lines: [line({ unitPrice: money(11_500n) })] }),
    );
    expect(priced.net.minor).toBe(10_000n);
    expect(priced.vat.minor).toBe(1_500n);
    expect(priced.total.minor).toBe(11_500n);
  });

  it('keeps the customer-facing total identical to the shelf price', () => {
    for (const shelf of [1n, 7n, 99n, 333n, 1_999n, 12_345n]) {
      const priced = priceCart(
        cart({ priceMode: 'tax-inclusive', lines: [line({ unitPrice: money(shelf) })] }),
      );
      // The point of inclusive pricing: what is on the label is what is paid.
      expect(priced.total.minor).toBe(shelf);
      expect(priced.net.minor + priced.vat.minor).toBe(shelf);
    }
  });
});

describe('discounts', () => {
  it('applies a line fixed discount before VAT', () => {
    const priced = priceCart(
      cart({
        lines: [line({ unitPrice: money(10_000n), discount: { kind: 'fixed', value: 2_000n } })],
      }),
    );
    expect(priced.lineDiscountTotal.minor).toBe(2_000n);
    expect(priced.net.minor).toBe(8_000n);
    expect(priced.vat.minor).toBe(1_200n);
    expect(priced.total.minor).toBe(9_200n);
  });

  it('applies a line percentage discount', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ unitPrice: money(10_000n), discount: { kind: 'percentage', value: 1_000n } }),
        ],
      }),
    );
    expect(priced.lineDiscountTotal.minor).toBe(1_000n);
    expect(priced.total.minor).toBe(10_350n);
  });

  it('allocates a basket fixed discount so the parts sum exactly', () => {
    // 100 halalas across three unequal lines cannot divide evenly.
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n) }),
          line({ lineId: 'b', unitPrice: money(2_000n) }),
          line({ lineId: 'c', unitPrice: money(3_000n) }),
        ],
        basketDiscount: { kind: 'fixed', value: 100n },
      }),
    );
    const shares = priced.lines.map((entry) => entry.basketDiscount.minor);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(100n);
    expect(priced.basketDiscountTotal.minor).toBe(100n);
  });

  it('allocates a basket percentage discount exactly', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(333n) }),
          line({ lineId: 'b', unitPrice: money(667n) }),
          line({ lineId: 'c', unitPrice: money(1_000n) }),
        ],
        basketDiscount: { kind: 'percentage', value: 1_500n },
      }),
    );
    const shares = priced.lines.map((entry) => entry.basketDiscount.minor);
    expect(shares.reduce((sum, share) => sum + share, 0n)).toBe(priced.basketDiscountTotal.minor);
  });

  it('is deterministic — the same cart allocates the same way every time', () => {
    const input = cart({
      lines: [
        line({ lineId: 'a', unitPrice: money(1_111n) }),
        line({ lineId: 'b', unitPrice: money(2_222n) }),
        line({ lineId: 'c', unitPrice: money(3_333n) }),
      ],
      basketDiscount: { kind: 'fixed', value: 777n },
    });
    const first = priceCart(input).lines.map((entry) => entry.basketDiscount.minor);
    for (let run = 0; run < 20; run += 1) {
      expect(priceCart(input).lines.map((entry) => entry.basketDiscount.minor)).toEqual(first);
    }
  });

  it('stacks a line discount and a basket discount without losing a halala', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(1_000n), discount: { kind: 'fixed', value: 133n } }),
          line({
            lineId: 'b',
            unitPrice: money(2_000n),
            discount: { kind: 'percentage', value: 700n },
          }),
        ],
        basketDiscount: { kind: 'percentage', value: 999n },
      }),
    );
    const lineSum = priced.lines.reduce((sum, entry) => sum + entry.total.minor, 0n);
    expect(lineSum).toBe(priced.total.minor);
    expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);
  });
});

describe('VAT breakdown', () => {
  it('splits by rate and reconciles to the totals', () => {
    const priced = priceCart(
      cart({
        lines: [
          line({ lineId: 'a', unitPrice: money(10_000n), vatRate: VAT_STANDARD_BP }),
          line({ lineId: 'b', unitPrice: money(5_000n), vatRate: VAT_ZERO_BP }),
          line({ lineId: 'c', unitPrice: money(2_000n), vatRate: VAT_STANDARD_BP }),
        ],
      }),
    );

    expect(priced.vatBreakdown).toHaveLength(2);
    const zeroBucket = priced.vatBreakdown.find((bucket) => bucket.rate === 0n);
    const standard = priced.vatBreakdown.find((bucket) => bucket.rate === 1_500n);

    expect(zeroBucket?.net.minor).toBe(5_000n);
    expect(zeroBucket?.vat.minor).toBe(0n);
    expect(standard?.net.minor).toBe(12_000n);
    expect(standard?.vat.minor).toBe(1_800n);

    const netSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.net.minor, 0n);
    const vatSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n);
    expect(netSum).toBe(priced.net.minor);
    expect(vatSum).toBe(priced.vat.minor);
  });

  it('handles a non-standard rate', () => {
    const priced = priceCart(
      cart({ lines: [line({ unitPrice: money(10_000n), vatRate: basisPoints(500n) })] }),
    );
    expect(priced.vat.minor).toBe(500n);
  });
});

describe('reconciliation sweep', () => {
  const MODES: readonly PriceMode[] = ['tax-exclusive', 'tax-inclusive'];

  it('always satisfies net + vat = total and the line sum = total', () => {
    // Awkward halala values across both price modes, with mixed discounts and
    // weighed quantities. Any allocation or rounding slip shows up here.
    for (const priceMode of MODES) {
      for (let price = 1n; price <= 999n; price += 37n) {
        for (const weight of ['1', '0.5', '0.125', '2.750', '0.333']) {
          const priced = priceCart({
            priceMode,
            lines: [
              line({
                lineId: 'a',
                unitPrice: money(price),
                quantity: quantityFromDecimalString(weight),
                discount: { kind: 'percentage', value: 700n },
              }),
              line({
                lineId: 'b',
                unitPrice: money(price * 3n + 1n),
                quantity: units(2),
                discount: { kind: 'fixed', value: 13n },
              }),
              line({ lineId: 'c', unitPrice: money(price + 7n), vatRate: VAT_ZERO_BP }),
            ],
            basketDiscount: { kind: 'fixed', value: 11n },
          });

          expect(priced.net.minor + priced.vat.minor).toBe(priced.total.minor);
          expect(priced.lines.reduce((sum, entry) => sum + entry.total.minor, 0n)).toBe(
            priced.total.minor,
          );
          expect(priced.lines.reduce((sum, entry) => sum + entry.basketDiscount.minor, 0n)).toBe(
            priced.basketDiscountTotal.minor,
          );
          expect(priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n)).toBe(
            priced.vat.minor,
          );
          for (const entry of priced.lines) {
            expect(entry.net.minor).toBeGreaterThanOrEqual(0n);
            expect(entry.vat.minor).toBeGreaterThanOrEqual(0n);
          }
        }
      }
    }
  });
});
