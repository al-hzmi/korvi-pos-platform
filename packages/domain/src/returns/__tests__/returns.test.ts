import { describe, expect, it } from 'vitest';
import { basisPoints } from '../../tax/basis-points.js';
import { cumulativeTarget } from '../prorate.js';
import {
  DuplicateReturnLineError,
  InvalidRefundError,
  InvalidReturnQuantityError,
  NothingReturnableError,
  OverReturnError,
  UnknownSaleLineError,
  planReturn,
} from '../returns.js';
import type { ReturnableLine, RefundIntent } from '../returns.js';
import type { LineComponents } from '../prorate.js';

/**
 * The arithmetic a merchant would find out about eventually.
 *
 * Most of this file is one property stated several ways: however a line is
 * broken up across returns, the sum of what the customer gets back equals what
 * they paid for those goods — to the halala, on every component, not just on
 * the total. Get it wrong and nothing crashes; a merchant simply keeps a few
 * halalas of somebody else's money on every partial return, forever.
 */

const CASH: RefundIntent = { kind: 'cash' };

/**
 * A line whose components divide badly by three, which is the whole point.
 *
 * gross 1000 - lineDiscount 101 - basketDiscount 7 = net 892, and 892 + 133 =
 * total 1025. Every one of those has a remainder over three units.
 */
const AWKWARD: LineComponents = {
  grossMinor: 1000n,
  lineDiscountMinor: 101n,
  basketDiscountMinor: 7n,
  netMinor: 892n,
  vatMinor: 133n,
  totalMinor: 1025n,
};

const NOTHING_REFUNDED = {
  grossMinor: 0n,
  netMinor: 0n,
  lineDiscountMinor: 0n,
  basketDiscountMinor: 0n,
  vatMinor: 0n,
};

function line(overrides: Partial<ReturnableLine> = {}): ReturnableLine {
  return {
    saleLineId: 'line-1',
    lineNumber: 1,
    productId: 'product-1',
    sku: 'MILK-1L',
    nameAr: 'حليب طازج',
    nameEn: null,
    productType: 'unit',
    vatBasisPoints: basisPoints(1500),
    soldQuantityScaled: 3_000n,
    returnedQuantityScaled: 0n,
    original: AWKWARD,
    refunded: NOTHING_REFUNDED,
    ...overrides,
  };
}

describe('cumulative proration', () => {
  it('is the whole component at the whole quantity', () => {
    expect(cumulativeTarget(1025n, 3_000n, 3_000n)).toBe(1025n);
    expect(cumulativeTarget(0n, 3_000n, 3_000n)).toBe(0n);
  });

  it('floors, so the sequence never steps backwards', () => {
    expect(cumulativeTarget(1000n, 1_000n, 3_000n)).toBe(333n);
    expect(cumulativeTarget(1000n, 2_000n, 3_000n)).toBe(666n);
  });

  it('refuses a line that sold nothing, or more back than went out', () => {
    expect(() => cumulativeTarget(100n, 1n, 0n)).toThrow();
    expect(() => cumulativeTarget(100n, 4n, 3n)).toThrow();
  });
});

describe('a whole return', () => {
  it('gives back exactly what the line was worth', () => {
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });

    expect(draft.grossMinor).toBe(1000n);
    expect(draft.lineDiscountMinor).toBe(101n);
    expect(draft.basketDiscountMinor).toBe(7n);
    expect(draft.netMinor).toBe(892n);
    expect(draft.vatMinor).toBe(133n);
    expect(draft.totalMinor).toBe(1025n);
  });

  it('follows the line the sale wrote, not the price times the quantity', () => {
    // The unit price no longer explains this line: a discount was granted at
    // the till. A return that recomputed from a price would refund the
    // undiscounted amount and hand the customer money they never paid.
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBe(AWKWARD.totalMinor);
  });
});

describe('sequential partial returns', () => {
  it('sums to the original on every component, one unit at a time', () => {
    let returned = 0n;
    let refunded = { ...NOTHING_REFUNDED };
    const totals = { gross: 0n, ld: 0n, bd: 0n, net: 0n, vat: 0n, total: 0n };

    for (let i = 0; i < 3; i += 1) {
      const draft = planReturn({
        available: [line({ returnedQuantityScaled: returned, refunded })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      });

      // Each document is internally consistent on its own, not only in sum.
      expect(draft.netMinor + draft.vatMinor).toBe(draft.totalMinor);

      totals.gross += draft.grossMinor;
      totals.ld += draft.lineDiscountMinor;
      totals.bd += draft.basketDiscountMinor;
      totals.net += draft.netMinor;
      totals.vat += draft.vatMinor;
      totals.total += draft.totalMinor;

      returned += 1_000n;
      refunded = {
        grossMinor: refunded.grossMinor + draft.grossMinor,
        netMinor: refunded.netMinor + draft.netMinor,
        lineDiscountMinor: refunded.lineDiscountMinor + draft.lineDiscountMinor,
        basketDiscountMinor: refunded.basketDiscountMinor + draft.basketDiscountMinor,
        vatMinor: refunded.vatMinor + draft.vatMinor,
      };
    }

    expect(totals.gross).toBe(AWKWARD.grossMinor);
    expect(totals.ld).toBe(AWKWARD.lineDiscountMinor);
    expect(totals.bd).toBe(AWKWARD.basketDiscountMinor);
    expect(totals.net).toBe(AWKWARD.netMinor);
    expect(totals.vat).toBe(AWKWARD.vatMinor);
    expect(totals.total).toBe(AWKWARD.totalMinor);
  });

  it('never rounds the same halala twice: two then one closes exactly', () => {
    const first = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 2_000n }],
      refund: CASH,
    });
    const second = planReturn({
      available: [
        line({
          returnedQuantityScaled: 2_000n,
          refunded: {
            grossMinor: first.grossMinor,
            netMinor: first.netMinor,
            lineDiscountMinor: first.lineDiscountMinor,
            basketDiscountMinor: first.basketDiscountMinor,
            vatMinor: first.vatMinor,
          },
        }),
      ],
      requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
      refund: CASH,
    });

    expect(first.totalMinor + second.totalMinor).toBe(AWKWARD.totalMinor);
    expect(first.vatMinor + second.vatMinor).toBe(AWKWARD.vatMinor);
    expect(first.lineDiscountMinor + second.lineDiscountMinor).toBe(AWKWARD.lineDiscountMinor);
  });

  it('closes exactly for a weighted line returned in three uneven pieces', () => {
    // 1.234 kg sold; 0.4, 0.5 and 0.334 back. Nothing divides.
    const weighted = line({
      productType: 'weighted',
      soldQuantityScaled: 1_234n,
      original: {
        grossMinor: 4_321n,
        lineDiscountMinor: 0n,
        basketDiscountMinor: 199n,
        netMinor: 4_122n,
        vatMinor: 618n,
        totalMinor: 4_740n,
      },
    });

    let returned = 0n;
    let refunded = { ...NOTHING_REFUNDED };
    let total = 0n;
    for (const piece of [400n, 500n, 334n]) {
      const draft = planReturn({
        available: [
          weighted.returnedQuantityScaled === returned && returned === 0n
            ? weighted
            : { ...weighted, returnedQuantityScaled: returned, refunded },
        ],
        requested: [{ saleLineId: 'line-1', quantityScaled: piece }],
        refund: CASH,
      });
      total += draft.totalMinor;
      returned += piece;
      refunded = {
        grossMinor: refunded.grossMinor + draft.grossMinor,
        netMinor: refunded.netMinor + draft.netMinor,
        lineDiscountMinor: refunded.lineDiscountMinor + draft.lineDiscountMinor,
        basketDiscountMinor: refunded.basketDiscountMinor + draft.basketDiscountMinor,
        vatMinor: refunded.vatMinor + draft.vatMinor,
      };
    }

    expect(returned).toBe(1_234n);
    expect(total).toBe(4_740n);
    expect(refunded.netMinor).toBe(4_122n);
    expect(refunded.basketDiscountMinor).toBe(199n);
    expect(refunded.vatMinor).toBe(618n);
  });
});

describe('what a return may not be', () => {
  it('refuses nothing, and refuses a negative', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 0n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);

    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: -1_000n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('refuses a third of a unit product', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('allows a fraction of a weighted product', () => {
    const draft = planReturn({
      available: [line({ productType: 'weighted' })],
      requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBeGreaterThan(0n);
  });

  it('refuses a partial return when the historical product type was never recorded', () => {
    // A pre-snapshot sale line has no immutable proof that it was unit or
    // weighted. Today's catalogue and quantity divisibility are both unsafe
    // guesses, so a partial return is refused.
    expect(() =>
      planReturn({
        available: [line({ productType: null })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 333n }],
        refund: CASH,
      }),
    ).toThrow(InvalidReturnQuantityError);
  });

  it('allows the entire remaining quantity when the historical product type is unknown', () => {
    // Returning the complete remainder requires no unit-vs-weight inference.
    const draft = planReturn({
      available: [line({ productType: null })],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: CASH,
    });
    expect(draft.totalMinor).toBeGreaterThan(0n);
  });

  it('refuses the same line twice in one document', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [
          { saleLineId: 'line-1', quantityScaled: 1_000n },
          { saleLineId: 'line-1', quantityScaled: 1_000n },
        ],
        refund: CASH,
      }),
    ).toThrow(DuplicateReturnLineError);
  });

  it('refuses more than the line has left', () => {
    expect(() =>
      planReturn({
        available: [line({ returnedQuantityScaled: 2_000n, refunded: NOTHING_REFUNDED })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 2_000n }],
        refund: CASH,
      }),
    ).toThrow(OverReturnError);
  });

  it('refuses a line that has already come back in full', () => {
    expect(() =>
      planReturn({
        available: [line({ returnedQuantityScaled: 3_000n, refunded: NOTHING_REFUNDED })],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(NothingReturnableError);
  });

  it('refuses a line that belongs to another sale', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'somebody-elses-line', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(UnknownSaleLineError);
  });

  it('refuses a document worth nothing', () => {
    const free = line({
      original: {
        grossMinor: 0n,
        lineDiscountMinor: 0n,
        basketDiscountMinor: 0n,
        netMinor: 0n,
        vatMinor: 0n,
        totalMinor: 0n,
      },
    });
    expect(() =>
      planReturn({
        available: [free],
        requested: [{ saleLineId: 'line-1', quantityScaled: 1_000n }],
        refund: CASH,
      }),
    ).toThrow(NothingReturnableError);
  });
});

describe('how the money goes back', () => {
  it('records an electronic refund against somebody else’s approval', () => {
    const draft = planReturn({
      available: [line()],
      requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
      refund: { kind: 'electronic', scheme: 'mada', reference: 'AUTH-99812' },
    });
    expect(draft.totalMinor).toBe(1025n);
  });

  it('refuses an electronic refund with nothing to point at', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'mada', reference: '   ' },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('refuses a reference longer than a reference', () => {
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'visa', reference: 'X'.repeat(65) },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('refuses a card number wearing a reference’s clothes', () => {
    // 4111 1111 1111 1111 satisfies Luhn. A refund reference is free text,
    // which is exactly where a broken integration puts one.
    expect(() =>
      planReturn({
        available: [line()],
        requested: [{ saleLineId: 'line-1', quantityScaled: 3_000n }],
        refund: { kind: 'electronic', scheme: 'visa', reference: '4111 1111 1111 1111' },
      }),
    ).toThrow(InvalidRefundError);
  });

  it('derives the refund from the lines, so nothing else can name it', () => {
    const draft = planReturn({
      available: [line(), line({ saleLineId: 'line-2', lineNumber: 2 })],
      requested: [
        { saleLineId: 'line-1', quantityScaled: 1_000n },
        { saleLineId: 'line-2', quantityScaled: 3_000n },
      ],
      refund: CASH,
    });
    const fromLines = draft.lines.reduce((total, row) => total + row.components.totalMinor, 0n);
    expect(draft.totalMinor).toBe(fromLines);
  });
});
