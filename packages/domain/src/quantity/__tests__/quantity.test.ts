import { describe, expect, it } from 'vitest';
import {
  ONE_UNIT,
  QUANTITY_SCALE,
  addQuantity,
  compareQuantity,
  isWholeUnits,
  quantity,
  quantityFromDecimalString,
  quantityFromJson,
  quantityToDecimalString,
  quantityToDisplayString,
  quantityToJson,
  subtractQuantity,
  units,
} from '../quantity.js';
import { InvalidAmountError } from '../../errors.js';
import { extendedPrice } from '../../pricing/line.js';
import { money } from '../../money/money.js';

describe('parsing', () => {
  it('parses whole and fractional weights exactly', () => {
    expect(quantityFromDecimalString('1')).toBe(1_000n);
    expect(quantityFromDecimalString('0.5')).toBe(500n);
    expect(quantityFromDecimalString('0.125')).toBe(125n);
    expect(quantityFromDecimalString('2.750')).toBe(2_750n);
    expect(quantityFromDecimalString('0')).toBe(0n);
  });

  it('survives the additions that break floats', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. A scale reporting three tenths of a kilo
    // three times must total nine tenths, not 0.8999999999999999.
    const tenth = quantityFromDecimalString('0.1');
    const fifth = quantityFromDecimalString('0.2');
    expect(addQuantity(tenth, fifth)).toBe(quantityFromDecimalString('0.3'));

    let running = quantity(0n);
    for (let index = 0; index < 10; index += 1) {
      running = addQuantity(running, quantityFromDecimalString('0.1'));
    }
    expect(running).toBe(ONE_UNIT);
    expect(quantityToDecimalString(running)).toBe('1.000');
  });

  it('rejects precision finer than the scale rather than rounding', () => {
    expect(() => quantityFromDecimalString('0.1255')).toThrow(InvalidAmountError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1,5', 'abc', '1.2.3', ' 1e3', 'NaN', '.5']) {
      expect(() => quantityFromDecimalString(bad), bad).toThrow(InvalidAmountError);
    }
  });

  it('rejects a negative scaled value', () => {
    expect(() => quantity(-1n)).toThrow(InvalidAmountError);
  });

  it('rejects a non-integer or negative unit count', () => {
    expect(() => units(1.5)).toThrow(InvalidAmountError);
    expect(() => units(-1)).toThrow(InvalidAmountError);
    expect(() => units(Number.NaN)).toThrow(InvalidAmountError);
  });

  it('accepts zero as a quantity', () => {
    expect(units(0)).toBe(0n);
  });
});

describe('formatting', () => {
  it('round-trips through the decimal form', () => {
    for (const text of ['0.000', '0.001', '0.125', '1.000', '99.999', '12345.678']) {
      expect(quantityToDecimalString(quantityFromDecimalString(text))).toBe(text);
    }
  });

  it('trims trailing zeros for display without losing value', () => {
    expect(quantityToDisplayString(units(2))).toBe('2');
    expect(quantityToDisplayString(quantityFromDecimalString('0.5'))).toBe('0.5');
    expect(quantityToDisplayString(quantityFromDecimalString('0.125'))).toBe('0.125');
    expect(quantityToDisplayString(quantity(0n))).toBe('0');
  });

  it('crosses a JSON boundary as a string, never a number', () => {
    const value = quantityFromDecimalString('0.125');
    expect(typeof quantityToJson(value)).toBe('string');
    expect(quantityFromJson(quantityToJson(value))).toBe(value);
  });

  it('rejects a malformed scaled value from JSON', () => {
    expect(() => quantityFromJson('0.5')).toThrow(InvalidAmountError);
    expect(() => quantityFromJson('-5')).toThrow(InvalidAmountError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(addQuantity(units(2), quantityFromDecimalString('0.5'))).toBe(2_500n);
    expect(subtractQuantity(units(2), quantityFromDecimalString('0.5'))).toBe(1_500n);
  });

  it('refuses to go negative', () => {
    expect(() => subtractQuantity(units(1), units(2))).toThrow(InvalidAmountError);
  });

  it('recognises whole units', () => {
    expect(isWholeUnits(units(3))).toBe(true);
    expect(isWholeUnits(quantityFromDecimalString('0.125'))).toBe(false);
  });

  it('compares', () => {
    expect(compareQuantity(units(1), units(2))).toBe(-1);
    expect(compareQuantity(units(2), units(2))).toBe(0);
    expect(compareQuantity(units(3), units(2))).toBe(1);
  });

  it('keeps the declared scale', () => {
    expect(QUANTITY_SCALE).toBe(1_000n);
    expect(ONE_UNIT).toBe(QUANTITY_SCALE);
  });
});

describe('weighted extension against a price', () => {
  it('prices common scale readings exactly', () => {
    // 12.00 SAR/kg
    const perKilo = money(1_200n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('1')).minor).toBe(1_200n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('0.5')).minor).toBe(600n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('0.125')).minor).toBe(150n);
    expect(extendedPrice(perKilo, quantityFromDecimalString('2.750')).minor).toBe(3_300n);
  });

  it('rounds a fractional halala once, half-up', () => {
    // 9.99 SAR/kg at 0.333 kg is 3.32667 SAR -> 333 halalas.
    expect(extendedPrice(money(999n), quantityFromDecimalString('0.333')).minor).toBe(333n);
    // 0.01 SAR/kg at 0.5 kg is half a halala -> 1, not 0.
    expect(extendedPrice(money(1n), quantityFromDecimalString('0.5')).minor).toBe(1n);
  });

  it('never drifts across a sweep of prices and weights', () => {
    // Ten weighings of the same item must equal one weighing of ten times the
    // weight, to the halala, for every price in the sweep.
    for (let price = 1n; price <= 200n; price += 7n) {
      const unitPrice = money(price);
      let sum = 0n;
      for (let index = 0; index < 10; index += 1) {
        sum += extendedPrice(unitPrice, quantityFromDecimalString('0.1')).minor;
      }
      const once = extendedPrice(unitPrice, units(1)).minor;
      // Per-weighing rounding may differ from a single weighing, but only ever
      // by the rounding of each part -- never by an accumulating float error.
      expect(sum - once).toBeGreaterThanOrEqual(-10n);
      expect(sum - once).toBeLessThanOrEqual(10n);
    }
  });
});
