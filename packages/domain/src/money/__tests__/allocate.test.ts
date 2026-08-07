import { describe, expect, it } from 'vitest';
import { allocate, allocateEvenly, allocateMoney } from '../allocate.js';
import { money } from '../money.js';
import { InvalidAmountError } from '../../errors.js';

const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

describe('allocate', () => {
  it('never creates or destroys a halala', () => {
    // The classic: 100 split three ways cannot be done evenly.
    const shares = allocate(100n, [1n, 1n, 1n]);
    expect(shares).toEqual([34n, 33n, 33n]);
    expect(sum(shares)).toBe(100n);
  });

  it('preserves the total across a wide sweep of inputs', () => {
    const weightSets: bigint[][] = [
      [1n, 1n],
      [1n, 1n, 1n],
      [1n, 2n, 3n],
      [7n, 11n, 13n, 17n],
      [1n, 0n, 1n],
      [999n, 1n],
      [1n, 1n, 1n, 1n, 1n, 1n, 1n],
    ];

    for (let total = -250n; total <= 250n; total += 1n) {
      for (const weights of weightSets) {
        const shares = allocate(total, weights);
        expect(sum(shares)).toBe(total);
        expect(shares).toHaveLength(weights.length);
      }
    }
  });

  it('mirrors exactly under negation', () => {
    for (const weights of [
      [1n, 1n, 1n],
      [2n, 3n, 5n],
    ]) {
      const positive = allocate(1_000_037n, weights);
      const negative = allocate(-1_000_037n, weights);
      expect(negative).toEqual(positive.map((share) => -share));
    }
  });

  it('is deterministic — ties break by index, not by chance', () => {
    for (let run = 0; run < 50; run += 1) {
      expect(allocate(10n, [1n, 1n, 1n, 1n])).toEqual([3n, 3n, 2n, 2n]);
    }
  });

  it('gives the leftover to the largest remainder', () => {
    // Weights 1:2 over 3 halalas -> exact shares 1.0 and 2.0, no leftover.
    expect(allocate(3n, [1n, 2n])).toEqual([1n, 2n]);
    // Weights 1:1:1 over 5 -> 1.67 each; the two largest remainders get +1.
    expect(sum(allocate(5n, [1n, 1n, 1n]))).toBe(5n);
  });

  it('handles a zero weight without dropping money', () => {
    const shares = allocate(10n, [1n, 0n, 1n]);
    expect(shares[1]).toBe(0n);
    expect(sum(shares)).toBe(10n);
  });

  it('rejects impossible inputs', () => {
    expect(() => allocate(10n, [])).toThrow(InvalidAmountError);
    expect(() => allocate(10n, [0n, 0n])).toThrow(InvalidAmountError);
    expect(() => allocate(10n, [1n, -1n])).toThrow(InvalidAmountError);
  });
});

describe('allocateMoney', () => {
  it('keeps the currency and the total', () => {
    const parts = allocateMoney(money(100n), [1n, 1n, 1n]);
    expect(parts.every((part) => part.currency === 'SAR')).toBe(true);
    expect(sum(parts.map((part) => part.minor))).toBe(100n);
  });

  it('splits a bill evenly with the remainder going to the earliest parts', () => {
    const parts = allocateEvenly(money(1000n), 3);
    expect(parts.map((part) => part.minor)).toEqual([334n, 333n, 333n]);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocateEvenly(money(100n), 0)).toThrow(InvalidAmountError);
    expect(() => allocateEvenly(money(100n), 1.5)).toThrow(InvalidAmountError);
  });
});
