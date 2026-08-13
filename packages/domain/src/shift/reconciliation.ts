import { DomainError } from '../errors.js';

/**
 * What should be in the drawer, and by how much the count disagrees.
 *
 * The whole of shift close reduces to one subtraction, and the only way that
 * subtraction is trustworthy is if every term feeding it is a persisted fact
 * with a sign nobody can argue about. So the categories are kept apart —
 * opening float, cash sales, cash refunds, paid in, paid out — as *positive
 * magnitudes*, and the equation puts the signs back:
 *
 *   expected = opening + cashSales - cashRefunds + paidIn - paidOut
 *   variance = declared - expected
 *
 * Storing magnitudes rather than signed sums is deliberate. A signed refund
 * total invites the reader to add it, and one double negation turns a shortfall
 * into a surplus of twice the size. The equation above is the only place the
 * signs are applied, and it is asserted again by a CHECK constraint on the row.
 *
 * Integer minor units throughout, and no clamping anywhere. One halala of
 * variance is information: it is the first sign of a systematic error, and a
 * rounding rule that swallowed it would hide the error for a month.
 */

export class CashMovementSignError extends DomainError {
  public override readonly name = 'CashMovementSignError';
}

export class ManualAmountError extends DomainError {
  public override readonly name = 'ManualAmountError';
}

/** The two movements an operator records by hand. */
export type ManualMovementKind = 'pay-in' | 'pay-out';

/**
 * A public magnitude becomes a persisted signed amount, here and nowhere else.
 *
 * The API takes a positive magnitude because "pay out 50" is what an operator
 * means, and a client that could send a sign could send the wrong one. The
 * conversion is a server decision and this is the whole of it.
 */
export function signedManualAmount(kind: ManualMovementKind, magnitudeMinor: bigint): bigint {
  if (magnitudeMinor <= 0n) {
    throw new ManualAmountError('A manual drawer movement must be a positive amount.');
  }
  return kind === 'pay-in' ? magnitudeMinor : -magnitudeMinor;
}

export interface DrawerMovement {
  readonly kind: 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';
  /** Signed, as persisted. */
  readonly amountMinor: bigint;
}

/**
 * The five figures a close is built from, every one a positive magnitude.
 */
export interface CashBreakdown {
  readonly openingFloatMinor: bigint;
  readonly cashSalesMinor: bigint;
  readonly cashRefundsMinor: bigint;
  readonly paidInMinor: bigint;
  readonly paidOutMinor: bigint;
}

/**
 * Categorise the drawer's movements, refusing any whose sign contradicts its
 * kind.
 *
 * A refund recorded positive would be added to the expected cash instead of
 * subtracted — a drawer that looks right while being short by twice the
 * refund. The database says the same thing in `cash_movements_sign`; this is
 * the same rule at the layer that does the arithmetic, so a bad row is refused
 * rather than quietly reconciled.
 *
 * `opening-float` movements carry zero: the float is the starting balance, not
 * money that arrived, and it enters through `openingFloatMinor`.
 */
export function summariseDrawer(
  openingFloatMinor: bigint,
  movements: readonly DrawerMovement[],
): CashBreakdown {
  if (openingFloatMinor < 0n) {
    throw new CashMovementSignError('An opening float cannot be negative.');
  }

  let cashSalesMinor = 0n;
  let cashRefundsMinor = 0n;
  let paidInMinor = 0n;
  let paidOutMinor = 0n;

  for (const movement of movements) {
    switch (movement.kind) {
      case 'sale':
        if (movement.amountMinor < 0n) {
          throw new CashMovementSignError('A cash sale cannot be negative.');
        }
        cashSalesMinor += movement.amountMinor;
        break;
      case 'refund':
        if (movement.amountMinor > 0n) {
          throw new CashMovementSignError('A cash refund cannot be positive.');
        }
        cashRefundsMinor += -movement.amountMinor;
        break;
      case 'pay-in':
        if (movement.amountMinor < 0n) {
          throw new CashMovementSignError('A pay-in cannot be negative.');
        }
        paidInMinor += movement.amountMinor;
        break;
      case 'pay-out':
        if (movement.amountMinor > 0n) {
          throw new CashMovementSignError('A pay-out cannot be positive.');
        }
        paidOutMinor += -movement.amountMinor;
        break;
      case 'opening-float':
        if (movement.amountMinor !== 0n) {
          throw new CashMovementSignError('An opening-float movement carries no money.');
        }
        break;
    }
  }

  return { openingFloatMinor, cashSalesMinor, cashRefundsMinor, paidInMinor, paidOutMinor };
}

/** opening + sales - refunds + paidIn - paidOut. The only place signs go back. */
export function expectedCashMinor(breakdown: CashBreakdown): bigint {
  return (
    breakdown.openingFloatMinor +
    breakdown.cashSalesMinor -
    breakdown.cashRefundsMinor +
    breakdown.paidInMinor -
    breakdown.paidOutMinor
  );
}

/** Declared minus expected. Positive is a surplus, negative a shortfall. */
export function cashVarianceMinor(declaredCashMinor: bigint, expected: bigint): bigint {
  if (declaredCashMinor < 0n) {
    throw new ManualAmountError('Declared cash cannot be negative.');
  }
  return declaredCashMinor - expected;
}

export interface DrawerReconciliation extends CashBreakdown {
  readonly expectedCashMinor: bigint;
  readonly declaredCashMinor: bigint;
  readonly varianceMinor: bigint;
}

/**
 * The whole reconciliation, from persisted movements and one declared count.
 *
 * Note what is absent: every input the client could have supplied except the
 * declared cash. Expected cash and variance are consequences, never assertions
 * (ADR-0017).
 */
export function reconcileDrawer(
  openingFloatMinor: bigint,
  movements: readonly DrawerMovement[],
  declaredCashMinor: bigint,
): DrawerReconciliation {
  const breakdown = summariseDrawer(openingFloatMinor, movements);
  const expected = expectedCashMinor(breakdown);
  return {
    ...breakdown,
    expectedCashMinor: expected,
    declaredCashMinor,
    varianceMinor: cashVarianceMinor(declaredCashMinor, expected),
  };
}
