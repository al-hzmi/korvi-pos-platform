import { describe, expect, it } from 'vitest';
import {
  addScaled,
  formatScaled,
  parseAdjustmentQuantityToScaled,
  parseCountedQuantityToScaled,
  parseInventoryQuantityToScaled,
  parseQuantityToScaled,
  stepScaled,
} from '../quantity';

describe('parseQuantityToScaled, unit products', () => {
  it.each([
    ['1', '1000'],
    ['2', '2000'],
    ['12', '12000'],
  ])('reads %s units as %s', (input, expected) => {
    const parsed = parseQuantityToScaled(input, 'unit');
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it('refuses a fraction of a unit', () => {
    // A tin cannot be sold in halves, and the server refuses one that is.
    const parsed = parseQuantityToScaled('1.5', 'unit');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe('precision');
  });
});

describe('parseQuantityToScaled, weighted products', () => {
  it.each([
    ['1', '1000'],
    ['1.2', '1200'],
    ['1.25', '1250'],
    ['1.250', '1250'],
    ['0.125', '125'],
    ['0.001', '1'],
  ])('reads %s as %s', (input, expected) => {
    const parsed = parseQuantityToScaled(input, 'weighted');
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['0', 'not-positive'],
    ['0.000', 'not-positive'],
    ['-1', 'format'],
    ['1e3', 'format'],
    ['NaN', 'format'],
    ['1,5', 'format'],
    ['1.2345', 'precision'],
  ])('refuses %s', (input, reason) => {
    const parsed = parseQuantityToScaled(input, 'weighted');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe(reason);
  });
});

describe('inventory command quantities', () => {
  it('allows an exact zero count without allowing a zero transfer', () => {
    expect(parseCountedQuantityToScaled('0', 'unit')).toEqual({ ok: true, value: '0' });
    expect(parseCountedQuantityToScaled('0.000', 'weighted')).toEqual({ ok: true, value: '0' });
    expect(parseQuantityToScaled('0', 'unit')).toEqual({ ok: false, reason: 'not-positive' });
  });

  it.each([
    ['-2', 'unit', '-2000'],
    ['+3', 'unit', '3000'],
    ['-1.25', 'weighted', '-1250'],
    ['0.001', 'weighted', '1'],
  ] as const)('parses adjustment %s exactly', (input, productType, expected) => {
    expect(parseAdjustmentQuantityToScaled(input, productType)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each([
    ['0', 'unit', 'zero'],
    ['-0.000', 'weighted', 'zero'],
    ['1.5', 'unit', 'precision'],
    ['1.2345', 'weighted', 'precision'],
    ['1e3', 'weighted', 'format'],
  ] as const)('refuses adjustment %s as %s', (input, productType, reason) => {
    expect(parseAdjustmentQuantityToScaled(input, productType)).toEqual({ ok: false, reason });
  });

  it('preserves inventory quantities beyond JavaScript safe integer range', () => {
    expect(parseCountedQuantityToScaled('900719925474099', 'unit')).toEqual({
      ok: true,
      value: '900719925474099000',
    });
    expect(parseInventoryQuantityToScaled('999999999999999.999', 'weighted')).toEqual({
      ok: true,
      value: '999999999999999999',
    });
  });
});

describe('scaled arithmetic', () => {
  it('formats without trailing noise', () => {
    expect(formatScaled('2000')).toBe('2');
    expect(formatScaled('1250')).toBe('1.25');
    expect(formatScaled('125')).toBe('0.125');
  });

  it('adds as integers', () => {
    expect(addScaled('1000', '1250')).toBe('2250');
    // Well past what a double holds exactly, and still exact.
    expect(addScaled('9007199254740993', '1')).toBe('9007199254740994');
  });

  it('steps by whole units and never below one', () => {
    expect(stepScaled('1000', 1)).toBe('2000');
    expect(stepScaled('2000', -1)).toBe('1000');
    expect(stepScaled('1000', -1)).toBe('1000');
    expect(stepScaled('1500', -1)).toBe('1000');
  });

  it('never makes a quantity larger by decrementing it', () => {
    // The bug this exists to prevent: a clamp to "at least one unit" turns
    // 0.500 minus one into 1.000, so pressing minus doubles a weighed line.
    for (const scaled of ['1', '125', '500', '999', '1000', '1500', '2000', '12345']) {
      expect(BigInt(stepScaled(scaled, -1))).toBeLessThanOrEqual(BigInt(scaled));
    }
    expect(stepScaled('500', -1)).toBe('500');
    expect(stepScaled('125', -1)).toBe('125');
  });
});
