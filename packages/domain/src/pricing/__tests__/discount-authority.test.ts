import { describe, expect, it } from 'vitest';
import { effectiveDiscountBasisPoints, isDiscountAuthorized } from '../discount-authority.js';

describe('effectiveDiscountBasisPoints', () => {
  it('reports the exact rate when it divides evenly', () => {
    expect(effectiveDiscountBasisPoints(1_000n, 10_000n)).toBe(1_000n);
    expect(effectiveDiscountBasisPoints(10_000n, 10_000n)).toBe(10_000n);
    expect(effectiveDiscountBasisPoints(0n, 10_000n)).toBe(0n);
  });

  it('rounds up, because a ceiling that rounds down is not a ceiling', () => {
    /*
     * The case this function exists for. 200 halalas off 1999 is 1000.5 basis
     * points. Truncating division reports 1000, so a cashier capped at 1000
     * gets it — every time, repeatably, as a policy the merchant never set.
     */
    expect((200n * 10_000n) / 1_999n).toBe(1_000n);
    expect(effectiveDiscountBasisPoints(200n, 1_999n)).toBe(1_001n);
  });

  it.each([
    [1n, 3n, 3_334n],
    [1n, 10_000n, 1n],
    [7n, 999n, 71n],
    [333n, 1_000n, 3_330n],
  ])('reports %s off %s as %s bp', (granted, base, expected) => {
    expect(effectiveDiscountBasisPoints(granted, base)).toBe(expected);
  });

  it('never reports a rate below the true one', () => {
    // The property that matters: the reported rate is always >= the real one,
    // so authorisation can only ever be stricter than the arithmetic, never
    // looser. Integer comparison — the true rate is granted*10000/base.
    for (let base = 1n; base <= 400n; base += 1n) {
      for (let granted = 1n; granted <= base; granted += 7n) {
        const reported = effectiveDiscountBasisPoints(granted, base);
        expect(reported * base).toBeGreaterThanOrEqual(granted * 10_000n);
      }
    }
  });

  it('refuses to describe a discount taken out of nothing', () => {
    // There is no rate that describes it, and reporting zero would authorise
    // it against every ceiling including a cashier's zero.
    expect(effectiveDiscountBasisPoints(100n, 0n)).toBeGreaterThan(10_000n);
  });
});

describe('isDiscountAuthorized', () => {
  it('permits a discount inside the ceiling', () => {
    expect(isDiscountAuthorized(1_000n, 10_000n, 1_000n)).toBe(true);
    expect(isDiscountAuthorized(999n, 10_000n, 1_000n)).toBe(true);
  });

  it('refuses the half-basis-point over the ceiling', () => {
    expect(isDiscountAuthorized(200n, 1_999n, 1_000n)).toBe(false);
  });

  it('gives a cashier with no discount authority no discount at all', () => {
    // ROLE_MAX_DISCOUNT_BP.cashier is 0. One halala off is still a discount.
    expect(isDiscountAuthorized(1n, 100_000n, 0n)).toBe(false);
    expect(isDiscountAuthorized(0n, 100_000n, 0n)).toBe(true);
  });
});
