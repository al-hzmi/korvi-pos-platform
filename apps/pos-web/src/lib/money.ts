import { moneyFromMajorString, moneyToMajorString } from '@korvi/domain';
import { parsed, unparsed } from './parse';
import type { Money } from '@korvi/domain';
import type { Parsed } from './parse';

/**
 * SAR at the keyboard.
 *
 * Everything crosses the wire as an integer string of halalas, and every
 * conversion between that and what a cashier types goes through here. There is
 * no Number() on this path and no toFixed: `19.99` is not representable in
 * binary floating point, and a till that loses a halala per sale loses a
 * reconciliation nobody can explain (ADR-0002).
 *
 * The parsing itself is delegated to @korvi/domain rather than reimplemented,
 * so the browser and the server agree by construction.
 */

/** What a person may type: digits, optionally a point, at most two more digits. */
const SAR_KEYSTROKES = /^\d{1,12}(?:\.\d{0,2})?$/;
const POSTGRES_BIGINT_SAR_KEYSTROKES = /^\d{1,17}(?:\.\d{0,2})?$/;
const POSTGRES_BIGINT_MAX = (1n << 63n) - 1n;

/**
 * A partially-typed amount, accepted so the field does not fight the cashier.
 *
 * "12." is on the way to "12.50"; it is not an error yet, and it means twelve.
 */
function normalize(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

function parseSar(input: string, keystrokes: RegExp, maximumMinor: bigint | null): Parsed<string> {
  const trimmed = input.trim();
  if (trimmed === '') return unparsed('empty');
  if (!keystrokes.test(trimmed)) {
    // Told apart on purpose: "1.234" is a precision problem the cashier can
    // fix by deleting a digit, and "1e3" is not a number they meant to type.
    return unparsed(/^\d+\.\d{3,}$/.test(trimmed) ? 'precision' : 'format');
  }
  try {
    const minor = moneyFromMajorString(normalize(trimmed)).minor;
    return maximumMinor !== null && minor > maximumMinor
      ? unparsed('format')
      : parsed(minor.toString());
  } catch {
    return unparsed('format');
  }
}

export function parseSarToMinor(input: string): Parsed<string> {
  return parseSar(input, SAR_KEYSTROKES, null);
}

/** Acquisition values may use the full non-negative PostgreSQL BIGINT range. */
export function parseSarToPostgresMinor(input: string): Parsed<string> {
  return parseSar(input, POSTGRES_BIGINT_SAR_KEYSTROKES, POSTGRES_BIGINT_MAX);
}

/** Halalas as they arrived from the server, rendered for a human. */
export function formatMinor(minor: string): string {
  return moneyToMajorString({ currency: 'SAR', minor: BigInt(minor) });
}

export function formatMoney(value: Money): string {
  return moneyToMajorString(value);
}

/** Change owed, as a string, or null when the cash does not cover the total. */
export function changeMinor(totalMinor: string, cashMinor: string): string | null {
  const difference = BigInt(cashMinor) - BigInt(totalMinor);
  return difference < 0n ? null : difference.toString();
}
