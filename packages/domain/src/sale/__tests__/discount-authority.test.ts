import { describe, expect, it } from 'vitest';
import { InvalidDiscountError } from '../../errors.js';
import { money } from '../../money/money.js';
import { quantity } from '../../quantity/quantity.js';
import { basisPoints } from '../../tax/basis-points.js';
import { DiscountNotPermittedError, finalizeSale } from '../finalize.js';
import type { CartLineInput, Discount } from '../../pricing/line.js';
import type { FinalizeSaleInput } from '../finalize.js';

/**
 * A ceiling has to mean the same thing wherever the discount lands.
 *
 * The scenario these tests are built around: a small line beside a large one.
 * Measured against the whole cart, a fixed amount can wipe out the small line
 * entirely and still read as a modest percentage. Measured against the line it
 * came off, it reads as what it is.
 */
function line(id: string, unit: bigint, discount?: Discount): CartLineInput {
  return {
    lineId: id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    nameAr: 'صنف',
    nameEn: null,
    unitPrice: money(unit),
    quantity: quantity(1_000n),
    vatRate: basisPoints(1500),
    ...(discount === undefined ? {} : { discount }),
  };
}

function sale(
  lines: readonly CartLineInput[],
  ceiling: bigint,
  basketDiscount?: Discount,
): FinalizeSaleInput {
  return {
    saleId: 's1',
    operationId: 'op1',
    tenantId: 't1',
    branchId: 'b1',
    terminalId: 'tm1',
    shiftId: 'sh1',
    cashierId: 'u1',
    customerId: null,
    cart: {
      priceMode: 'tax-inclusive',
      lines,
      ...(basketDiscount === undefined ? {} : { basketDiscount }),
    },
    tenders: [{ kind: 'cash', amount: money(1_000_000n) }],
    issuedAt: '2026-08-18T00:00:00.000Z',
    maxDiscountBasisPoints: ceiling,
  };
}

describe('a line discount is measured against its own line', () => {
  it('refuses a fixed amount that wipes out a small line beside a large one', () => {
    // 10.00 off a 10.00 line is 100 per cent of that line. Against the 100.00
    // cart it reads as 1000 bp, which a manager capped at 2000 would be given.
    expect(() =>
      finalizeSale(
        sale([line('a', 1_000n, { kind: 'fixed', value: 1_000n }), line('b', 9_000n)], 2_000n),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('allows a fixed line discount inside the ceiling for that line', () => {
    // 2.00 off a 10.00 line is exactly 2000 bp.
    const finalized = finalizeSale(
      sale([line('a', 1_000n, { kind: 'fixed', value: 200n }), line('b', 9_000n)], 2_000n),
    );
    expect(finalized.priced.lineDiscountTotal.minor).toBe(200n);
  });

  it('refuses the halala that rounds over the ceiling', () => {
    // 2.01 off 10.00 is 2010 bp once the rate is computed honestly.
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 201n })], 2_000n)),
    ).toThrow(DiscountNotPermittedError);
  });

  it('refuses more off a line than the line is worth, without clamping it', () => {
    // applyDiscount would cap this to the line value, which is right for
    // pricing and wrong here: capping answers a request nobody made.
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 1_500n })], 10_000n)),
    ).toThrow(InvalidDiscountError);
  });

  it('refuses a rate above the ceiling before anything is priced', () => {
    expect(() =>
      finalizeSale(sale([line('a', 1_000n, { kind: 'percentage', value: 2_001n })], 2_000n)),
    ).toThrow(DiscountNotPermittedError);
  });
});

describe('a basket discount is measured against what the lines left', () => {
  it('uses the after-line base, which is what priceCart applies it to', () => {
    // Lines total 100.00, less a 10.00 line discount, leaves 90.00. 18.00 off
    // that is exactly 2000 bp; against the undiscounted 100.00 it would look
    // like 1800.
    const finalized = finalizeSale(
      sale([line('a', 1_000n, { kind: 'fixed', value: 1_000n }), line('b', 9_000n)], 10_000n, {
        kind: 'fixed',
        value: 1_800n,
      }),
    );
    expect(finalized.priced.basketDiscountTotal.minor).toBe(1_800n);
  });

  it('refuses a basket discount larger than the base it is taken from', () => {
    expect(() =>
      finalizeSale(sale([line('a', 1_000n)], 10_000n, { kind: 'fixed', value: 1_001n })),
    ).toThrow(InvalidDiscountError);
  });

  it('refuses a basket rate above the ceiling', () => {
    expect(() =>
      finalizeSale(sale([line('a', 10_000n)], 2_000n, { kind: 'percentage', value: 2_001n })),
    ).toThrow(DiscountNotPermittedError);
  });
});

describe('and everything together', () => {
  it('refuses two individually-legal discounts that stack past the ceiling', () => {
    // 1500 bp off a line and 1500 bp off the basket are each inside a 2000 bp
    // ceiling. Together they are not, and the aggregate guard is what says so.
    expect(() =>
      finalizeSale(
        sale([line('a', 10_000n, { kind: 'percentage', value: 1_500n })], 2_000n, {
          kind: 'percentage',
          value: 1_500n,
        }),
      ),
    ).toThrow(DiscountNotPermittedError);
  });

  it('permits a combination that stays inside it', () => {
    const finalized = finalizeSale(
      sale([line('a', 10_000n, { kind: 'percentage', value: 1_000n })], 2_000n, {
        kind: 'percentage',
        value: 1_000n,
      }),
    );
    // 1000 off, then 900 off the 9000 that is left: 1900 of 10000 is 1900 bp.
    expect(
      finalized.priced.lineDiscountTotal.minor + finalized.priced.basketDiscountTotal.minor,
    ).toBe(1_900n);
  });

  it('lets a cashier with no discount authority sell, and grant nothing', () => {
    expect(() => finalizeSale(sale([line('a', 1_000n)], 0n))).not.toThrow();
    expect(() => finalizeSale(sale([line('a', 1_000n, { kind: 'fixed', value: 1n })], 0n))).toThrow(
      DiscountNotPermittedError,
    );
  });
});
