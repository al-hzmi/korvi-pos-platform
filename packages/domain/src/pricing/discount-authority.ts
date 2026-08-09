import { BASIS_POINT_SCALE } from '../tax/basis-points.js';

/**
 * How much of a base a discount actually took, expressed as a rate.
 *
 * The authorisation a principal carries is a rate — `maxDiscountBasisPoints` —
 * but a cashier may also grant a fixed amount off, and the two have to be
 * comparable or the ceiling means nothing against half the discounts a shop
 * gives. So a fixed discount is converted to the rate it is equivalent to,
 * against the base it was taken from.
 *
 * Rounded UP, and that is the whole point of this function existing.
 *
 * Truncating division is the obvious way to write it and it is wrong in a way
 * nobody notices: a cashier authorised to 1000 bp on a base of 1999 halalas
 * may take 200 halalas, because 200 x 10000 / 1999 truncates to 1000. The real
 * rate is 1000.5 bp. One halala over the ceiling every time, granted by the
 * rounding rather than by the merchant — and repeatable, so it is a policy the
 * merchant never set. Rounding up means the ceiling is the ceiling.
 *
 * Integer arithmetic throughout. A rate computed through a float would drift
 * exactly where this is trying to be exact (ADR-0002).
 */
export function effectiveDiscountBasisPoints(grantedMinor: bigint, eligibleBase: bigint): bigint {
  if (grantedMinor <= 0n) return 0n;
  if (eligibleBase <= 0n) {
    // Something was discounted out of nothing. There is no rate that describes
    // that, and reporting zero would authorise it.
    return BASIS_POINT_SCALE + 1n;
  }
  const numerator = grantedMinor * BASIS_POINT_SCALE;
  // Ceiling division, written the integer way: no Math, no float, no rounding
  // mode to get wrong.
  return (numerator + eligibleBase - 1n) / eligibleBase;
}

/**
 * May this principal grant this discount against this base?
 *
 * `ceiling` comes from the session — the database decided it when the roles
 * were resolved — and never from the request. A browser that could send its
 * own ceiling would be authorising itself.
 */
export function isDiscountAuthorized(
  grantedMinor: bigint,
  eligibleBase: bigint,
  ceilingBasisPoints: bigint,
): boolean {
  if (grantedMinor <= 0n) return true;
  return effectiveDiscountBasisPoints(grantedMinor, eligibleBase) <= ceilingBasisPoints;
}
