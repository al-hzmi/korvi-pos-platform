import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  moneyFromJson,
  moneyFromMajorString,
  moneyToJson,
  moneyToMajorString,
  money,
  subtractMoney,
  sumMoney,
} from '../money.js';
import { CurrencyMismatchError, InvalidAmountError } from '../../errors.js';

describe('money parsing', () => {
  it('parses whole and fractional amounts without a float', () => {
    expect(moneyFromMajorString('12.34').minor).toBe(1234n);
    expect(moneyFromMajorString('12.3').minor).toBe(1230n);
    expect(moneyFromMajorString('12').minor).toBe(1200n);
    expect(moneyFromMajorString('0.05').minor).toBe(5n);
    expect(moneyFromMajorString('-7.50').minor).toBe(-750n);
  });

  it('survives the amounts that break float arithmetic', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. It must here.
    const total = addMoney(moneyFromMajorString('0.10'), moneyFromMajorString('0.20'));
    expect(moneyToMajorString(total)).toBe('0.30');
  });

  it('refuses precision finer than a halala rather than rounding silently', () => {
    expect(() => moneyFromMajorString('1.005')).toThrow(InvalidAmountError);
  });

  it('rejects non-numeric input', () => {
    expect(() => moneyFromMajorString('12,34')).toThrow(InvalidAmountError);
    expect(() => moneyFromMajorString('')).toThrow(InvalidAmountError);
  });

  it('round-trips through the string form', () => {
    for (const value of ['0.00', '0.01', '9.99', '1234567.89', '-0.01']) {
      expect(moneyToMajorString(moneyFromMajorString(value))).toBe(value);
    }
  });
});

describe('money arithmetic', () => {
  it('adds, subtracts and sums', () => {
    expect(addMoney(money(100n), money(250n)).minor).toBe(350n);
    expect(subtractMoney(money(100n), money(250n)).minor).toBe(-150n);
    expect(sumMoney([money(1n), money(2n), money(3n)]).minor).toBe(6n);
    expect(sumMoney([]).minor).toBe(0n);
  });

  it('compares', () => {
    expect(compareMoney(money(1n), money(2n))).toBe(-1);
    expect(compareMoney(money(2n), money(2n))).toBe(0);
    expect(compareMoney(money(3n), money(2n))).toBe(1);
  });

  it('refuses to mix currencies', () => {
    const sar = money(100n, 'SAR');
    const other = { currency: 'USD', minor: 100n } as unknown as typeof sar;
    expect(() => addMoney(sar, other)).toThrow(CurrencyMismatchError);
  });

  it('holds amounts far beyond the safe integer range', () => {
    const huge = money(9_007_199_254_740_993n); // 2^53 + 1
    expect(moneyToJson(huge).minor).toBe('9007199254740993');
    expect(moneyFromJson(moneyToJson(huge)).minor).toBe(huge.minor);
  });
});

describe('json boundary', () => {
  it('serialises minor units as a string, never a number', () => {
    const json = moneyToJson(money(1234n));
    expect(typeof json.minor).toBe('string');
    expect(JSON.parse(JSON.stringify(json))).toEqual({ currency: 'SAR', minor: '1234' });
  });

  it('rejects a malformed minor value', () => {
    expect(() => moneyFromJson({ currency: 'SAR', minor: '12.5' })).toThrow(InvalidAmountError);
  });
});
