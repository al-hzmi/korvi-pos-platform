import { NonCashChangeError, UnderpaidError } from '../errors.js';
import { compareMoney, subtractMoney, sumMoney, zero } from '../money/money.js';
import type { Money } from '../money/money.js';

export type TenderKind = 'cash' | 'card' | 'mada' | 'transfer';

/**
 * Only cash can give change back.
 *
 * A card terminal settles the exact amount it was asked for; there is no
 * mechanism by which it returns money to the customer. Encoding that as data
 * rather than an `if` keeps the rule in one place when wallets are added.
 */
export const CHANGE_CAPABLE_TENDERS: readonly TenderKind[] = ['cash'];

export function canGiveChange(kind: TenderKind): boolean {
  return CHANGE_CAPABLE_TENDERS.includes(kind);
}

export interface TenderLine {
  readonly kind: TenderKind;
  readonly amount: Money;
}

export interface Settlement {
  readonly due: Money;
  readonly tendered: Money;
  /** Always drawn from cash. Zero when the payment was exact. */
  readonly change: Money;
  readonly changeFrom: TenderKind | null;
}

/**
 * Settle a sale against one or more tenders.
 *
 * The guard that matters: non-cash tenders may not exceed the amount due. The
 * cashier is expected to key the card amount first and let cash absorb the
 * remainder, which is also how the physical workflow runs.
 */
export function settle(due: Money, lines: readonly TenderLine[]): Settlement {
  if (due.minor < 0n) {
    throw new UnderpaidError('Amount due must not be negative.');
  }

  const currency = due.currency;
  const tendered = sumMoney(
    lines.map((line) => line.amount),
    currency,
  );

  for (const line of lines) {
    if (line.amount.minor < 0n) {
      throw new UnderpaidError(`Tender ${line.kind} must not be negative.`);
    }
  }

  const nonCash = sumMoney(
    lines.filter((line) => !canGiveChange(line.kind)).map((line) => line.amount),
    currency,
  );

  if (compareMoney(nonCash, due) > 0) {
    throw new NonCashChangeError(
      'Non-cash tenders exceed the amount due, and only cash can return change.',
    );
  }

  if (compareMoney(tendered, due) < 0) {
    throw new UnderpaidError('Tendered total does not cover the amount due.');
  }

  const change = subtractMoney(tendered, due);
  return {
    due,
    tendered,
    change,
    changeFrom: change.minor > 0n ? 'cash' : null,
  };
}

export function isSettled(settlement: Settlement): boolean {
  return compareMoney(settlement.tendered, settlement.due) >= 0;
}

export function noChange(currency: Money['currency'] = 'SAR'): Money {
  return zero(currency);
}
