import { describe, expect, it } from 'vitest';
import { mulDivRound } from '../rounding.js';
import { InvalidAmountError } from '../../errors.js';

describe('mulDivRound', () => {
  it('rounds half away from zero in half-up mode', () => {
    expect(mulDivRound(5n, 1n, 2n)).toBe(3n);
    expect(mulDivRound(-5n, 1n, 2n)).toBe(-3n);
    expect(mulDivRound(4n, 1n, 2n)).toBe(2n);
  });

  it('rounds half to even when asked', () => {
    expect(mulDivRound(5n, 1n, 2n, 'half-even')).toBe(2n);
    expect(mulDivRound(7n, 1n, 2n, 'half-even')).toBe(4n);
  });

  it('truncates toward zero when asked', () => {
    expect(mulDivRound(9n, 1n, 2n, 'trunc')).toBe(4n);
    expect(mulDivRound(-9n, 1n, 2n, 'trunc')).toBe(-4n);
  });

  it('is exact where floats are not', () => {
    // 0.07 * 100 in IEEE 754 is 7.000000000000001.
    expect(mulDivRound(7n, 100n, 100n)).toBe(7n);
    expect(mulDivRound(10_000_000_000_000_001n, 3n, 3n)).toBe(10_000_000_000_000_001n);
  });

  it('rejects a zero denominator', () => {
    expect(() => mulDivRound(1n, 1n, 0n)).toThrow(InvalidAmountError);
  });
});
