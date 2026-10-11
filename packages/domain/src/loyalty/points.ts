/**
 * V2-6: purely integer loyalty arithmetic. Points are NOT money; the value of
 * a redemption must enter the existing pricing/VAT authority as a discount.
 * Never mint ledger entries from these helpers outside the sale transaction.
 */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export interface LoyaltyPointsPolicy {
  readonly earnNumerator: bigint;
  readonly earnDenominator: bigint;
  readonly redeemValueMinorPerPoint: bigint;
}

export class InvalidLoyaltyPolicyError extends Error {
  public override readonly name = 'InvalidLoyaltyPolicyError';
  public constructor() {
    super('Invalid loyalty policy or points operation.');
  }
}

function boundedInteger(value: bigint, positive: boolean): void {
  if (value < (positive ? 1n : 0n) || value > MAX_BIGINT) {
    throw new InvalidLoyaltyPolicyError();
  }
}

export function validateLoyaltyPointsPolicy(policy: LoyaltyPointsPolicy): void {
  boundedInteger(policy.earnNumerator, true);
  boundedInteger(policy.earnDenominator, true);
  boundedInteger(policy.redeemValueMinorPerPoint, true);
}

/** Earn on server-finalized, eligible halalas, never a client-estimated total. */
export function earnedLoyaltyPoints(
  eligibleMinor: bigint,
  policy: LoyaltyPointsPolicy,
): bigint {
  validateLoyaltyPointsPolicy(policy);
  boundedInteger(eligibleMinor, false);
  const points = (eligibleMinor * policy.earnNumerator) / policy.earnDenominator;
  boundedInteger(points, false);
  return points;
}

/** Quote only; not an authorization to redeem or a receipt amount. */
export function quotedLoyaltyRedemptionMinor(
  points: bigint,
  availablePoints: bigint,
  policy: LoyaltyPointsPolicy,
): bigint {
  validateLoyaltyPointsPolicy(policy);
  boundedInteger(points, true);
  boundedInteger(availablePoints, false);
  if (points > availablePoints) throw new InvalidLoyaltyPolicyError();
  const minor = points * policy.redeemValueMinorPerPoint;
  boundedInteger(minor, true);
  return minor;
}

export function sumLoyaltyPoints(
  entries: readonly { readonly pointsDelta: bigint }[],
): bigint {
  return entries.reduce((sum, entry) => sum + entry.pointsDelta, 0n);
}
