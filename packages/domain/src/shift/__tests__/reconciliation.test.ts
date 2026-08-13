import { describe, expect, it } from 'vitest';
import {
  CashMovementSignError,
  ManualAmountError,
  cashVarianceMinor,
  expectedCashMinor,
  reconcileDrawer,
  signedManualAmount,
  summariseDrawer,
} from '../reconciliation.js';
import type { DrawerMovement } from '../reconciliation.js';

/**
 * The subtraction a shift close reduces to.
 *
 * Two failure modes matter here and neither announces itself. A sign applied
 * twice turns a shortfall into a surplus of the same size, and a rounded or
 * clamped variance hides the first halala of a systematic error — the one
 * that would have been noticed.
 */

const opening = 20_000n;

function movement(kind: DrawerMovement['kind'], amountMinor: bigint): DrawerMovement {
  return { kind, amountMinor };
}

describe('a magnitude becomes a signed amount', () => {
  it('adds on a pay-in and subtracts on a pay-out', () => {
    expect(signedManualAmount('pay-in', 5_000n)).toBe(5_000n);
    expect(signedManualAmount('pay-out', 5_000n)).toBe(-5_000n);
  });

  it('refuses nothing and refuses a negative', () => {
    expect(() => signedManualAmount('pay-in', 0n)).toThrow(ManualAmountError);
    expect(() => signedManualAmount('pay-out', 0n)).toThrow(ManualAmountError);
    expect(() => signedManualAmount('pay-in', -1n)).toThrow(ManualAmountError);
  });
});

describe('categorising the drawer', () => {
  it('keeps magnitudes apart rather than netting them', () => {
    const breakdown = summariseDrawer(opening, [
      movement('opening-float', 0n),
      movement('sale', 11_500n),
      movement('sale', 2_300n),
      movement('refund', -1_150n),
      movement('pay-in', 5_000n),
      movement('pay-out', -750n),
    ]);

    expect(breakdown).toEqual({
      openingFloatMinor: 20_000n,
      cashSalesMinor: 13_800n,
      cashRefundsMinor: 1_150n,
      paidInMinor: 5_000n,
      paidOutMinor: 750n,
    });
  });

  it('refuses a movement whose sign contradicts its kind', () => {
    expect(() => summariseDrawer(opening, [movement('refund', 1_150n)])).toThrow(
      CashMovementSignError,
    );
    expect(() => summariseDrawer(opening, [movement('pay-out', 750n)])).toThrow(
      CashMovementSignError,
    );
    expect(() => summariseDrawer(opening, [movement('sale', -1n)])).toThrow(CashMovementSignError);
    expect(() => summariseDrawer(opening, [movement('pay-in', -1n)])).toThrow(
      CashMovementSignError,
    );
  });

  it('refuses an opening-float movement that carries money', () => {
    expect(() => summariseDrawer(opening, [movement('opening-float', 20_000n)])).toThrow(
      CashMovementSignError,
    );
  });

  it('refuses a negative opening float', () => {
    expect(() => summariseDrawer(-1n, [])).toThrow(CashMovementSignError);
  });
});

describe('the cash equation', () => {
  it('applies the signs exactly once', () => {
    expect(
      expectedCashMinor({
        openingFloatMinor: 20_000n,
        cashSalesMinor: 13_800n,
        cashRefundsMinor: 1_150n,
        paidInMinor: 5_000n,
        paidOutMinor: 750n,
      }),
    ).toBe(36_900n);
  });

  it('does not double-negate a refund or a pay-out', () => {
    // The defect this exists to catch: subtracting an already-negative total.
    const asymmetric = summariseDrawer(1_000n, [
      movement('sale', 10_000n),
      movement('refund', -4_000n),
      movement('pay-in', 300n),
      movement('pay-out', -200n),
    ]);
    expect(expectedCashMinor(asymmetric)).toBe(7_100n);
  });
});

describe('the variance', () => {
  it('is one halala when the drawer is one halala over', () => {
    const reconciliation = reconcileDrawer(opening, [movement('sale', 11_500n)], 31_501n);
    expect(reconciliation.expectedCashMinor).toBe(31_500n);
    expect(reconciliation.varianceMinor).toBe(1n);
  });

  it('is minus one halala when it is one halala short', () => {
    const reconciliation = reconcileDrawer(opening, [movement('sale', 11_500n)], 31_499n);
    expect(reconciliation.varianceMinor).toBe(-1n);
  });

  it('is zero on an exact drawer, and is not clamped either way', () => {
    expect(reconcileDrawer(opening, [], 20_000n).varianceMinor).toBe(0n);
    expect(reconcileDrawer(opening, [], 0n).varianceMinor).toBe(-20_000n);
  });

  it('stays exact past the largest safe JavaScript integer', () => {
    // 2^53 is where a number stops being able to count halalas. A bigint does
    // not care, and neither does BIGINT.
    const huge = 9_007_199_254_740_993n;
    const reconciliation = reconcileDrawer(huge, [movement('sale', 1n)], huge + 2n);
    expect(reconciliation.expectedCashMinor).toBe(huge + 1n);
    expect(reconciliation.varianceMinor).toBe(1n);
    expect(reconciliation.expectedCashMinor.toString()).toBe('9007199254740994');
  });

  it('refuses a negative count', () => {
    expect(() => cashVarianceMinor(-1n, 0n)).toThrow(ManualAmountError);
  });
});

describe('the whole reconciliation', () => {
  it('reports every category and the two derived figures', () => {
    const reconciliation = reconcileDrawer(
      20_000n,
      [
        movement('opening-float', 0n),
        movement('sale', 11_500n),
        movement('refund', -1_150n),
        movement('pay-in', 5_000n),
        movement('pay-out', -750n),
      ],
      34_600n,
    );

    expect(reconciliation).toEqual({
      openingFloatMinor: 20_000n,
      cashSalesMinor: 11_500n,
      cashRefundsMinor: 1_150n,
      paidInMinor: 5_000n,
      paidOutMinor: 750n,
      expectedCashMinor: 34_600n,
      declaredCashMinor: 34_600n,
      varianceMinor: 0n,
    });
  });
});
