import { DomainError } from '../errors.js';
import { addMoney, subtractMoney, zero } from '../money/money.js';
import type { Money } from '../money/money.js';

/**
 * Cashier shift arithmetic.
 *
 * The number that matters is the variance: declared cash minus expected cash.
 * Everything else exists to make that figure trustworthy, so every movement is
 * recorded rather than netted.
 */

export class ShiftStateError extends DomainError {
  public override readonly name = 'ShiftStateError';
}

export type ShiftStatus = 'open' | 'closed';

export type CashMovementKind = 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';

export type ManualCashMovementKind = 'pay-in' | 'pay-out';

export interface CashBreakdown {
  readonly openingFloatMinor: bigint;
  readonly cashSalesMinor: bigint;
  readonly cashRefundsMinor: bigint;
  readonly paidInMinor: bigint;
  readonly paidOutMinor: bigint;
  readonly expectedCashMinor: bigint;
}

export function signedManualCashAmount(kind: ManualCashMovementKind, amountMinor: bigint): bigint {
  if (amountMinor <= 0n) throw new ShiftStateError('Manual cash amount must be positive.');
  return kind === 'pay-in' ? amountMinor : -amountMinor;
}

/** Derive positive category magnitudes from authoritative signed movements. */
export function cashBreakdown(
  openingFloatMinor: bigint,
  movements: readonly { readonly kind: CashMovementKind; readonly amountMinor: bigint }[],
): CashBreakdown {
  if (openingFloatMinor < 0n) throw new ShiftStateError('Opening float must not be negative.');
  let cashSalesMinor = 0n;
  let cashRefundsMinor = 0n;
  let paidInMinor = 0n;
  let paidOutMinor = 0n;
  for (const movement of movements) {
    if (movement.kind === 'sale') {
      if (movement.amountMinor < 0n) throw new ShiftStateError('Sale cash must not be negative.');
      cashSalesMinor += movement.amountMinor;
    } else if (movement.kind === 'refund') {
      if (movement.amountMinor > 0n) throw new ShiftStateError('Refund cash must not be positive.');
      cashRefundsMinor += -movement.amountMinor;
    } else if (movement.kind === 'pay-in') {
      if (movement.amountMinor < 0n) throw new ShiftStateError('Pay-in cash must not be negative.');
      paidInMinor += movement.amountMinor;
    } else if (movement.kind === 'pay-out') {
      if (movement.amountMinor > 0n)
        throw new ShiftStateError('Pay-out cash must not be positive.');
      paidOutMinor += -movement.amountMinor;
    }
  }
  return {
    openingFloatMinor,
    cashSalesMinor,
    cashRefundsMinor,
    paidInMinor,
    paidOutMinor,
    expectedCashMinor:
      openingFloatMinor + cashSalesMinor - cashRefundsMinor + paidInMinor - paidOutMinor,
  };
}

export interface CashMovement {
  readonly id: string;
  readonly kind: CashMovementKind;
  /** Signed: a pay-out and a refund are negative. */
  readonly amount: Money;
  readonly reason: string | null;
  readonly at: string;
}

export interface ShiftState {
  readonly shiftId: string;
  readonly status: ShiftStatus;
  readonly openingFloat: Money;
  readonly movements: readonly CashMovement[];
  readonly declaredCash: Money | null;
}

/** Opening float plus every signed cash movement. What should be in the drawer. */
export function expectedCash(shift: ShiftState): Money {
  return shift.movements.reduce<Money>(
    (total, movement) => addMoney(total, movement.amount),
    shift.openingFloat,
  );
}

/**
 * Declared minus expected. Positive is a surplus, negative a shortfall.
 *
 * Not clamped and not rounded: a variance of one halala is information, and
 * hiding it is how a systematic error stays invisible for a month.
 */
export function cashVariance(shift: ShiftState): Money {
  if (shift.declaredCash === null) {
    throw new ShiftStateError('Cannot compute variance before cash is declared.');
  }
  return subtractMoney(shift.declaredCash, expectedCash(shift));
}

export function assertOpen(shift: ShiftState): void {
  if (shift.status !== 'open') {
    throw new ShiftStateError('This shift is closed.');
  }
}

export function openShift(shiftId: string, openingFloat: Money, at: string): ShiftState {
  if (openingFloat.minor < 0n) {
    throw new ShiftStateError('Opening float must not be negative.');
  }
  return {
    shiftId,
    status: 'open',
    openingFloat,
    movements: [
      { id: shiftId, kind: 'opening-float', amount: zero(openingFloat.currency), reason: null, at },
    ],
    declaredCash: null,
  };
}

export function recordMovement(shift: ShiftState, movement: CashMovement): ShiftState {
  assertOpen(shift);
  if ((movement.kind === 'pay-out' || movement.kind === 'refund') && movement.amount.minor > 0n) {
    throw new ShiftStateError(`${movement.kind} must be recorded as a negative amount.`);
  }
  if ((movement.kind === 'pay-in' || movement.kind === 'sale') && movement.amount.minor < 0n) {
    throw new ShiftStateError(`${movement.kind} must be recorded as a positive amount.`);
  }
  return { ...shift, movements: [...shift.movements, movement] };
}

export function closeShift(shift: ShiftState, declaredCash: Money): ShiftState {
  assertOpen(shift);
  if (declaredCash.minor < 0n) {
    throw new ShiftStateError('Declared cash must not be negative.');
  }
  return { ...shift, status: 'closed', declaredCash };
}
