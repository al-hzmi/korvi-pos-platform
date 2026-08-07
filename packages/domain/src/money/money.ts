import { CurrencyMismatchError, InvalidAmountError } from '../errors.js';

/** ISO 4217 codes Korvi handles. Widening this is a migration, not an edit. */
export type Currency = 'SAR';

/** Minor units in one major unit. 100 halalas to the riyal. */
export const MINOR_UNITS_PER_MAJOR = 100n;

/**
 * An amount of money, stored as an integer count of minor units.
 *
 * There is no float anywhere in this type by construction, which is the whole
 * point: `0.1 + 0.2` is a rounding bug in every other POS, and a merchant
 * discovers it as an unexplained few halalas in the bank reconciliation.
 */
export interface Money {
  readonly currency: Currency;
  readonly minor: bigint;
}

export function money(minor: bigint, currency: Currency = 'SAR'): Money {
  return { currency, minor };
}

export function zero(currency: Currency = 'SAR'): Money {
  return { currency, minor: 0n };
}

/**
 * Parse a decimal string such as "12.34" without ever touching a float.
 *
 * Strings are the only safe transport for money across a JSON boundary, so
 * this is also the inbound half of the serialisation rule in ADR-0002.
 */
export function moneyFromMajorString(input: string, currency: Currency = 'SAR'): Money {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) {
    throw new InvalidAmountError(`Not a decimal amount: "${input}".`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';

  if (fraction.length > 2) {
    throw new InvalidAmountError(
      `"${input}" carries more precision than a halala; refusing to round silently.`,
    );
  }

  const padded = fraction.padEnd(2, '0');
  const minor = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(padded === '' ? '0' : padded);
  return { currency, minor: sign * minor };
}

/** Render as a fixed two-decimal string. The outbound half of ADR-0002. */
export function moneyToMajorString(value: Money): string {
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const whole = absolute / MINOR_UNITS_PER_MAJOR;
  const fraction = absolute % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`Cannot combine ${a.currency} with ${b.currency}.`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, minor: a.minor - b.minor };
}

export function negateMoney(value: Money): Money {
  return { currency: value.currency, minor: -value.minor };
}

export function sumMoney(values: readonly Money[], currency: Currency = 'SAR'): Money {
  return values.reduce<Money>((acc, value) => addMoney(acc, value), zero(currency));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function isZeroMoney(value: Money): boolean {
  return value.minor === 0n;
}

export function isNegativeMoney(value: Money): boolean {
  return value.minor < 0n;
}

/**
 * JSON-safe shape. `minor` leaves as a string because `JSON.stringify` throws
 * on bigint, and a number would silently lose precision above 2^53 — the exact
 * failure ADR-0002 forbids.
 */
export interface MoneyJson {
  readonly currency: Currency;
  readonly minor: string;
}

export function moneyToJson(value: Money): MoneyJson {
  return { currency: value.currency, minor: value.minor.toString() };
}

export function moneyFromJson(value: MoneyJson): Money {
  if (!/^-?\d+$/.test(value.minor)) {
    throw new InvalidAmountError(`Minor units must be an integer string, got "${value.minor}".`);
  }
  return { currency: value.currency, minor: BigInt(value.minor) };
}
