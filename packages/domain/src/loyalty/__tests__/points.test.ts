import { describe, expect, it } from 'vitest';
import {
  InvalidLoyaltyPolicyError,
  earnedLoyaltyPoints,
  quotedLoyaltyRedemptionMinor,
  sumLoyaltyPoints,
} from '../points.js';

const policy = {
  earnNumerator: 1n,
  earnDenominator: 100n,
  redeemValueMinorPerPoint: 10n,
};

describe('V2-6 non-cash loyalty points', () => {
  it('earns from whole halalas with deterministic floor and no floats', () => {
    expect(earnedLoyaltyPoints(1450n, policy)).toBe(14n);
    expect(earnedLoyaltyPoints(99n, policy)).toBe(0n);
    expect(earnedLoyaltyPoints(0n, policy)).toBe(0n);
  });

  it('quotes redeemable value without claiming it is a payment or a VAT calculation', () => {
    expect(quotedLoyaltyRedemptionMinor(14n, 14n, policy)).toBe(140n);
    expect(() => quotedLoyaltyRedemptionMinor(15n, 14n, policy)).toThrow(
      InvalidLoyaltyPolicyError,
    );
  });

  it('rejects negative inputs, invalid policies, and 64-bit overflow', () => {
    expect(() => earnedLoyaltyPoints(-1n, policy)).toThrow(InvalidLoyaltyPolicyError);
    expect(() => earnedLoyaltyPoints(100n, { ...policy, earnDenominator: 0n })).toThrow(
      InvalidLoyaltyPolicyError,
    );
    expect(() =>
      earnedLoyaltyPoints(9_223_372_036_854_775_807n, {
        ...policy,
        earnNumerator: 2n,
        earnDenominator: 1n,
      }),
    ).toThrow(InvalidLoyaltyPolicyError);
    expect(() => quotedLoyaltyRedemptionMinor(0n, 0n, policy)).toThrow(InvalidLoyaltyPolicyError);
  });

  it('derives balance exclusively from signed historical entries', () => {
    expect(sumLoyaltyPoints([
      { pointsDelta: 14n },
      { pointsDelta: -6n },
      { pointsDelta: -3n },
      { pointsDelta: 6n },
    ])).toBe(11n);
  });
});
