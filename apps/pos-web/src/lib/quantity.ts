import {
  QUANTITY_SCALE,
  quantity as brandQuantity,
  quantityFromDecimalString,
  quantityToDisplayString,
} from '@korvi/domain';
import { parsed, unparsed } from './parse';
import type { ProductType } from '@korvi/domain';
import type { Parsed } from './parse';

/**
 * Quantity at the keyboard, scaled by 1000 (ADR-0002 applied to weight).
 *
 * A unit product cannot be sold in thirds, so it is a whole number of units
 * here and a multiple of the scale on the wire. A weighted product carries up
 * to three decimals, which is what a retail scale reports and what the server
 * accepts — and, again, the conversion is string arithmetic, never a float.
 */

export const QUANTITY_STEP = QUANTITY_SCALE.toString();

const WHOLE = /^\d{1,9}$/;
const DECIMAL = /^\d{1,9}(?:\.\d{0,3})?$/;

function normalize(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

export function parseQuantityToScaled(input: string, productType: ProductType): Parsed<string> {
  const trimmed = input.trim();
  if (trimmed === '') return unparsed('empty');

  if (productType === 'unit') {
    if (!WHOLE.test(trimmed)) {
      return unparsed(trimmed.includes('.') ? 'precision' : 'format');
    }
  } else if (!DECIMAL.test(trimmed)) {
    return unparsed(/^\d+\.\d{4,}$/.test(trimmed) ? 'precision' : 'format');
  }

  let scaled: bigint;
  try {
    scaled = quantityFromDecimalString(normalize(trimmed));
  } catch {
    return unparsed('format');
  }
  // Zero is a line nobody meant to add, and the server rejects it anyway.
  if (scaled <= 0n) return unparsed('not-positive');
  return parsed(scaled.toString());
}

/** "2000" -> "2", "1250" -> "1.25". Trailing zeros are noise on a receipt. */
export function formatScaled(scaled: string): string {
  return quantityToDisplayString(brandQuantity(BigInt(scaled)));
}

export function addScaled(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

/**
 * One whole unit up, or one down.
 *
 * The decrement is the interesting half. Clamping a step to "at least one
 * unit" is right for a unit product and wrong for anything below a unit: a
 * naive clamp turns 0.500 minus one into 1.000, so pressing minus makes the
 * quantity *larger*. On a weighed line that is a customer charged for twice
 * what they bought.
 *
 * So the rule is stated as the invariant rather than as a formula: a decrement
 * never returns more than it was given. Weighted lines do not offer these
 * controls at all (they are edited in the decimal field), and `cartReducer`
 * refuses a step on one; this is the third lock on the same door.
 */
export function stepScaled(scaled: string, direction: 1 | -1): string {
  const current = BigInt(scaled);
  if (direction === 1) return (current + QUANTITY_SCALE).toString();

  const next = current - QUANTITY_SCALE;
  if (next >= QUANTITY_SCALE) return next.toString();
  // Below one unit after the step: settle on one unit, or stay put if there
  // was never a whole unit to begin with.
  return (current > QUANTITY_SCALE ? QUANTITY_SCALE : current).toString();
}
