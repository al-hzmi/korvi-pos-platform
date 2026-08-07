import { mulDivRound } from '../money/rounding.js';
import { BASIS_POINT_SCALE } from './basis-points.js';
import type { BasisPoints } from './basis-points.js';
import type { Money } from '../money/money.js';

/**
 * VAT arithmetic.
 *
 * Rates arrive as `BasisPoints`, which is validated at construction, so these
 * functions do not re-check the range — the type is the guarantee.
 */

/** Tax on a net (tax-exclusive) amount. */
export function taxFromNet(net: Money, rate: BasisPoints): Money {
  return { currency: net.currency, minor: mulDivRound(net.minor, rate, BASIS_POINT_SCALE) };
}

/** Tax already contained inside a gross (tax-inclusive) amount. */
export function taxFromGross(gross: Money, rate: BasisPoints): Money {
  return {
    currency: gross.currency,
    minor: mulDivRound(gross.minor, rate, BASIS_POINT_SCALE + rate),
  };
}

export function netFromGross(gross: Money, rate: BasisPoints): Money {
  return { currency: gross.currency, minor: gross.minor - taxFromGross(gross, rate).minor };
}

export function grossFromNet(net: Money, rate: BasisPoints): Money {
  return { currency: net.currency, minor: net.minor + taxFromNet(net, rate).minor };
}
