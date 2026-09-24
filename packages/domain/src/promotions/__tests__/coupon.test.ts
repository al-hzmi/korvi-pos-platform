import { describe, expect, it } from 'vitest';
import { InvalidCouponCodeError, normalizeCouponCode } from '../coupon.js';

describe('coupon identity', () => {
  it('normalizes case, outer whitespace and full-width ASCII deterministically', () => {
    expect(normalizeCouponCode('  save-10  ')).toBe('SAVE-10');
    expect(normalizeCouponCode('ＳＡＶＥ１０')).toBe('SAVE10');
  });

  it.each(['--A', 'A--', 'AB', 'A_B', 'خصم10', 'SAVE 10', 'A'.repeat(33)])(
    'refuses non-canonical or unbounded code %s',
    (value) => {
      expect(() => normalizeCouponCode(value)).toThrow(InvalidCouponCodeError);
    },
  );

  it('does not silently convert Arabic-Indic digits into a different business key', () => {
    expect(() => normalizeCouponCode('SAVE١٠')).toThrow(InvalidCouponCodeError);
  });
});
