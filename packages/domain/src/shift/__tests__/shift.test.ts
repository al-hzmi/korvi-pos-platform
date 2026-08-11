import { describe, expect, it } from 'vitest';
import {
  cashBreakdown,
  ShiftStateError,
  cashVariance,
  closeShift,
  expectedCash,
  openShift,
  recordMovement,
  signedManualCashAmount,
} from '../shift.js';
import type { CashMovement, ShiftState } from '../shift.js';
import { money } from '../../money/money.js';

const AT = '2026-08-08T08:00:00Z';

const movement = (
  over: Partial<CashMovement> & Pick<CashMovement, 'kind' | 'amount'>,
): CashMovement => ({
  id: over.id ?? 'm1',
  kind: over.kind,
  amount: over.amount,
  reason: over.reason ?? null,
  at: over.at ?? AT,
});

describe('drawer reconciliation breakdown', () => {
  it('uses positive magnitudes and the authoritative sign equation', () => {
    const result = cashBreakdown(101n, [
      { kind: 'sale', amountMinor: 37n },
      { kind: 'refund', amountMinor: -11n },
      { kind: 'pay-in', amountMinor: 19n },
      { kind: 'pay-out', amountMinor: -7n },
    ]);
    expect(result).toEqual({
      openingFloatMinor: 101n,
      cashSalesMinor: 37n,
      cashRefundsMinor: 11n,
      paidInMinor: 19n,
      paidOutMinor: 7n,
      expectedCashMinor: 139n,
    });
  });

  it('preserves large integers and one-halala variances', () => {
    const expected = cashBreakdown(9_007_199_254_740_993n, []).expectedCashMinor;
    expect(9_007_199_254_740_994n - expected).toBe(1n);
    expect(9_007_199_254_740_992n - expected).toBe(-1n);
  });

  it('signs public manual movement magnitudes and rejects zero/negative values', () => {
    expect(signedManualCashAmount('pay-in', 5_000n)).toBe(5_000n);
    expect(signedManualCashAmount('pay-out', 5_000n)).toBe(-5_000n);
    expect(() => signedManualCashAmount('pay-in', 0n)).toThrow(ShiftStateError);
    expect(() => signedManualCashAmount('pay-out', -1n)).toThrow(ShiftStateError);
  });
});

const withCash = (openingFloat: bigint, movements: readonly CashMovement[]): ShiftState =>
  movements.reduce(
    (shift, entry) => recordMovement(shift, entry),
    openShift('shift-1', money(openingFloat), AT),
  );

describe('opening', () => {
  it('starts open with the declared float', () => {
    const shift = openShift('shift-1', money(50_000n), AT);
    expect(shift.status).toBe('open');
    expect(shift.openingFloat.minor).toBe(50_000n);
    expect(expectedCash(shift).minor).toBe(50_000n);
  });

  it('refuses a negative float', () => {
    expect(() => openShift('shift-1', money(-1n), AT)).toThrow(ShiftStateError);
  });

  it('accepts a zero float', () => {
    expect(openShift('shift-1', money(0n), AT).openingFloat.minor).toBe(0n);
  });
});

describe('cash movements', () => {
  it('adds cash sales to the expected drawer', () => {
    const shift = withCash(50_000n, [
      movement({ id: 'a', kind: 'sale', amount: money(11_500n) }),
      movement({ id: 'b', kind: 'sale', amount: money(2_300n) }),
    ]);
    expect(expectedCash(shift).minor).toBe(63_800n);
  });

  it('subtracts cash refunds', () => {
    const shift = withCash(50_000n, [
      movement({ id: 'a', kind: 'sale', amount: money(11_500n) }),
      movement({ id: 'b', kind: 'refund', amount: money(-5_000n) }),
    ]);
    expect(expectedCash(shift).minor).toBe(56_500n);
  });

  it('handles pay-ins and pay-outs', () => {
    const shift = withCash(10_000n, [
      movement({ id: 'a', kind: 'pay-in', amount: money(5_000n), reason: 'float top-up' }),
      movement({ id: 'b', kind: 'pay-out', amount: money(-2_500n), reason: 'supplier' }),
    ]);
    expect(expectedCash(shift).minor).toBe(12_500n);
  });

  it('insists on the sign matching the movement kind', () => {
    const shift = openShift('shift-1', money(10_000n), AT);
    expect(() => recordMovement(shift, movement({ kind: 'refund', amount: money(500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'pay-out', amount: money(500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'sale', amount: money(-500n) }))).toThrow(
      ShiftStateError,
    );
    expect(() => recordMovement(shift, movement({ kind: 'pay-in', amount: money(-500n) }))).toThrow(
      ShiftStateError,
    );
  });

  it('refuses movements once the shift is closed', () => {
    const closed = closeShift(openShift('shift-1', money(10_000n), AT), money(10_000n));
    expect(() => recordMovement(closed, movement({ kind: 'sale', amount: money(100n) }))).toThrow(
      ShiftStateError,
    );
  });

  it('appends rather than replacing, so the trail survives', () => {
    const shift = withCash(0n, [
      movement({ id: 'a', kind: 'sale', amount: money(100n) }),
      movement({ id: 'b', kind: 'sale', amount: money(200n) }),
    ]);
    expect(shift.movements.map((entry) => entry.id)).toEqual(['shift-1', 'a', 'b']);
  });
});

describe('closing and variance', () => {
  it('reports a balanced drawer as zero variance', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_500n))).minor).toBe(0n);
  });

  it('reports a shortfall as negative', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_400n))).minor).toBe(-100n);
  });

  it('reports a surplus as positive', () => {
    const shift = withCash(50_000n, [movement({ kind: 'sale', amount: money(11_500n) })]);
    expect(cashVariance(closeShift(shift, money(61_600n))).minor).toBe(100n);
  });

  it('does not hide a single-halala variance', () => {
    const shift = withCash(0n, [movement({ kind: 'sale', amount: money(333n) })]);
    expect(cashVariance(closeShift(shift, money(332n))).minor).toBe(-1n);
  });

  it('refuses a variance before cash is declared', () => {
    expect(() => cashVariance(openShift('shift-1', money(0n), AT))).toThrow(ShiftStateError);
  });

  it('refuses a negative declaration', () => {
    expect(() => closeShift(openShift('shift-1', money(0n), AT), money(-1n))).toThrow(
      ShiftStateError,
    );
  });

  it('refuses to close twice', () => {
    const closed = closeShift(openShift('shift-1', money(0n), AT), money(0n));
    expect(() => closeShift(closed, money(0n))).toThrow(ShiftStateError);
  });
});

describe('reconciliation determinism', () => {
  it('always equals float plus the signed sum of movements', () => {
    for (let float = 0n; float <= 100_000n; float += 12_345n) {
      const movements: CashMovement[] = [];
      let signedSum = 0n;
      for (let index = 0; index < 12; index += 1) {
        const isRefund = index % 4 === 3;
        const amount = BigInt(index + 1) * 137n;
        movements.push(
          movement({
            id: `m${String(index)}`,
            kind: isRefund ? 'refund' : 'sale',
            amount: money(isRefund ? -amount : amount),
          }),
        );
        signedSum += isRefund ? -amount : amount;
      }

      const shift = withCash(float, movements);
      expect(expectedCash(shift).minor).toBe(float + signedSum);
      expect(cashVariance(closeShift(shift, money(float + signedSum))).minor).toBe(0n);
    }
  });
});
