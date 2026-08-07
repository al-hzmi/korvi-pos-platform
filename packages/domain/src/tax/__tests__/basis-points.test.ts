import { describe, expect, it } from 'vitest';
import {
  MAX_BASIS_POINTS,
  VAT_STANDARD_BP,
  basisPoints,
  basisPointsFromColumn,
  basisPointsToColumn,
  formatBasisPoints,
} from '../basis-points.js';
import { InvalidRateError } from '../../errors.js';

describe('basisPoints', () => {
  it('accepts values across the permitted range', () => {
    expect(basisPoints(0n)).toBe(0n);
    expect(basisPoints(1_500n)).toBe(1_500n);
    expect(basisPoints(MAX_BASIS_POINTS)).toBe(MAX_BASIS_POINTS);
  });

  it('accepts an integer number and widens it', () => {
    expect(basisPoints(1_500)).toBe(1_500n);
  });

  it('rejects a negative rate', () => {
    expect(() => basisPoints(-1n)).toThrow(InvalidRateError);
  });

  it('rejects a rate above 100%', () => {
    expect(() => basisPoints(MAX_BASIS_POINTS + 1n)).toThrow(InvalidRateError);
    expect(() => basisPoints(1_000_000n)).toThrow(InvalidRateError);
  });

  it('rejects a fractional rate rather than rounding it', () => {
    expect(() => basisPoints(15.5)).toThrow(InvalidRateError);
    expect(() => basisPoints(0.15)).toThrow(InvalidRateError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => basisPoints(Number.NaN)).toThrow(InvalidRateError);
    expect(() => basisPoints(Number.POSITIVE_INFINITY)).toThrow(InvalidRateError);
  });
});

describe('column boundary', () => {
  it('round-trips through the integer column form', () => {
    for (const raw of [0, 500, 1_500, 10_000]) {
      expect(basisPointsToColumn(basisPointsFromColumn(raw))).toBe(raw);
    }
  });

  it('rejects a corrupt column value loudly', () => {
    expect(() => basisPointsFromColumn(-5)).toThrow(InvalidRateError);
    expect(() => basisPointsFromColumn(99_999)).toThrow(InvalidRateError);
  });

  it('keeps the standard rate consistent across the boundary', () => {
    expect(basisPointsToColumn(VAT_STANDARD_BP)).toBe(1_500);
  });
});

describe('formatBasisPoints', () => {
  it('renders whole and fractional percentages', () => {
    expect(formatBasisPoints(VAT_STANDARD_BP)).toBe('15%');
    expect(formatBasisPoints(basisPoints(1_525n))).toBe('15.25%');
    expect(formatBasisPoints(basisPoints(0n))).toBe('0%');
  });
});
