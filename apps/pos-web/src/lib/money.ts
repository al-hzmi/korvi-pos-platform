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

/**
 * A partially-typed amount, accepted so the field does not fight the cashier.
 *
 * "12." is on the way to "12.50"; it is not an error yet, and it means twelve.
 */
function normalize(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

export function parseSarToMinor(input: string): Parsed<string> {
  const trimmed = input.trim();
  if (trimmed === '') return unparsed('empty');
  if (!SAR_KEYSTROKES.test(trimmed)) {
    // Told apart on purpose: "1.234" is a precision problem the cashier can
    // fix by deleting a digit, and "1e3" is not a number they meant to type.
    return unparsed(/^\d+\.\d{3,}$/.test(trimmed) ? 'precision' : 'format');
  }
  try {
    return parsed(moneyFromMajorString(normalize(trimmed)).minor.toString());
  } catch {
    return unparsed('format');
  }
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
