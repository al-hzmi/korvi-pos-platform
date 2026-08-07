import { InvalidRateError } from '../errors.js';

/**
 * A tax or discount rate, in basis points, validated at construction.
 *
 * One representation for the whole system. Revision 1 had the domain speaking
 * `bigint` while the ports and the database column spoke `number`, with the
 * conversion left implicit at each crossing — which is exactly where a rate
 * quietly becomes a float and starts disagreeing with itself about a halala.
 *
 * The brand means a bare `bigint` cannot be passed where a rate is expected:
 * every value has been through `basisPoints()` and is therefore in range.
 *
 * 1 bp = 0.01%. 1500 bp = 15%.
 */
export type BasisPoints = bigint & { readonly __brand: 'BasisPoints' };

export const BASIS_POINT_SCALE = 10_000n;

/**
 * Upper bound: 100%.
 *
 * Not arbitrary — a tax rate above 100% is a data-entry error every time, and
 * catching it here is cheaper than discovering it on a printed invoice. Raise
 * it deliberately if a jurisdiction ever needs more.
 */
export const MAX_BASIS_POINTS = 10_000n;

export function basisPoints(value: bigint | number): BasisPoints {
  const asBigInt = typeof value === 'number' ? numberToBigInt(value) : value;

  if (asBigInt < 0n) {
    throw new InvalidRateError(`Rate must not be negative, got ${asBigInt.toString()} bp.`);
  }
  if (asBigInt > MAX_BASIS_POINTS) {
    throw new InvalidRateError(
      `Rate ${asBigInt.toString()} bp exceeds the ${MAX_BASIS_POINTS.toString()} bp ceiling ` +
        '(100%). A rate above 100% is a data-entry error.',
    );
  }
  return asBigInt as BasisPoints;
}

function numberToBigInt(value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new InvalidRateError(
      `Rate must be a whole number of basis points, got ${String(value)}. ` +
        'Fractional basis points would reintroduce float arithmetic (ADR-0002).',
    );
  }
  return BigInt(value);
}

/**
 * Narrow a value that crossed a boundary as a plain integer.
 *
 * The database column is `Int` and JSON carries a number, so this is the single
 * sanctioned entry point back into the branded type — and it validates, so a
 * corrupt row fails loudly instead of producing a wrong tax figure.
 */
export function basisPointsFromColumn(value: number): BasisPoints {
  return basisPoints(value);
}

/** Widen for storage or transport. Safe: the ceiling is far below 2^53. */
export function basisPointsToColumn(value: BasisPoints): number {
  return Number(value);
}

export function formatBasisPoints(value: BasisPoints): string {
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n
    ? `${whole.toString()}%`
    : `${whole.toString()}.${fraction.toString().padStart(2, '0')}%`;
}

/** Saudi standard VAT at the time of writing. */
export const VAT_STANDARD_BP: BasisPoints = basisPoints(1_500n);
export const VAT_ZERO_BP: BasisPoints = basisPoints(0n);
