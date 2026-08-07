import { InvalidAmountError } from '../errors.js';

/**
 * Rounding is a financial decision, so it is named rather than implied.
 *
 * `half-up` is the default across Korvi because it is what Saudi VAT
 * documentation and every invoice a merchant has ever seen already do.
 */
export type RoundingMode = 'half-up' | 'half-even' | 'trunc';

/**
 * Compute `value * numerator / denominator` entirely in bigint.
 *
 * This is the only sanctioned way to scale money. It never converts to a
 * float, so it cannot introduce the fractional halalas that ADR-0002 exists to
 * prevent. Rounding is applied to the magnitude and the sign re-applied
 * afterwards, so -0.5 and +0.5 round symmetrically outward.
 */
export function mulDivRound(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator === 0n) {
    throw new InvalidAmountError('mulDivRound: denominator must not be zero.');
  }

  const negative = value < 0n !== numerator < 0n;
  const absValue = value < 0n ? -value : value;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const product = absValue * absNumerator;
  const quotient = product / absDenominator;
  const remainder = product % absDenominator;

  let rounded = quotient;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    if (mode === 'half-up') {
      if (twice >= absDenominator) rounded += 1n;
    } else if (mode === 'half-even') {
      if (twice > absDenominator || (twice === absDenominator && quotient % 2n === 1n)) {
        rounded += 1n;
      }
    }
    // 'trunc' keeps the quotient as-is.
  }

  return negative ? -rounded : rounded;
}
