import { describe, expect, it } from 'vitest';
import { changeMinor, formatMinor, parseSarToMinor, parseSarToPostgresMinor } from '../money';

/**
 * The conversion between what a cashier types and what crosses the wire.
 *
 * Every case below is one a float would get wrong or accept when it should
 * not. 19.99 is the canonical example: `19.99 * 100` is 1998.9999999999998 in
 * binary floating point, and a till that rounds that is a till that loses a
 * halala a sale.
 */
describe('parseSarToMinor', () => {
  it.each([
    ['0', '0'],
    ['1', '100'],
    ['1.5', '150'],
    ['1.50', '150'],
    ['10.25', '1025'],
    ['19.99', '1999'],
    ['0.05', '5'],
    ['1234567.89', '123456789'],
    // Trailing point: mid-keystroke, not an error.
    ['20.', '2000'],
    ['  7.10  ', '710'],
  ])('reads %s as %s halalas', (input, expected) => {
    const parsed = parseSarToMinor(input);
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-1', 'format'],
    ['-0.50', 'format'],
    ['1e3', 'format'],
    ['1,50', 'format'],
    ['abc', 'format'],
    ['NaN', 'format'],
    ['Infinity', 'format'],
    ['.5', 'format'],
    ['1.234', 'precision'],
    ['0.001', 'precision'],
    ['90071992547409.93', 'format'],
  ])('refuses %s', (input, reason) => {
    const parsed = parseSarToMinor(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe(reason);
  });

  it('never produces a floating point value', () => {
    // The result is a decimal string of an integer, always.
    for (const input of ['0.1', '0.2', '19.99', '0.07']) {
      const parsed = parseSarToMinor(input);
      expect(parsed.ok && /^[0-9]+$/.test(parsed.value)).toBe(true);
    }
    expect(parseSarToMinor('0.1').ok && parseSarToMinor('0.1')).toEqual({ ok: true, value: '10' });
  });
});

describe('parseSarToPostgresMinor', () => {
  it.each([
    ['90071992547409.93', '9007199254740993'],
    ['92233720368547758.07', '9223372036854775807'],
  ])('reads %s exactly as %s halalas', (input, expected) => {
    const parsed = parseSarToPostgresMinor(input);
    expect(parsed.ok && parsed.value).toBe(expected);
  });

  it.each([
    ['92233720368547758.08', 'format'],
    ['100000000000000000.00', 'format'],
  ])('refuses %s at the PostgreSQL boundary', (input, reason) => {
    const parsed = parseSarToPostgresMinor(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe(reason);
  });
});

describe('formatMinor', () => {
  it.each([
    ['0', '0.00'],
    ['5', '0.05'],
    ['150', '1.50'],
    ['2300', '23.00'],
    ['123456789', '1234567.89'],
  ])('renders %s as %s', (input, expected) => {
    expect(formatMinor(input)).toBe(expected);
  });
});

describe('changeMinor', () => {
  it('returns what is owed back', () => {
    expect(changeMinor('2300', '5000')).toBe('2700');
    expect(changeMinor('2300', '2300')).toBe('0');
  });

  it('returns null rather than a negative change', () => {
    // Short cash is a refusal, not a negative number to render.
    expect(changeMinor('2300', '100')).toBeNull();
  });
});
