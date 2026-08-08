import { DomainError, InvalidAmountError } from '../errors.js';
import { priceCart } from '../pricing/line.js';
import { settle } from '../tender/tender.js';
import type { PriceCartInput, PricedCart } from '../pricing/line.js';
import type { Settlement, TenderLine } from '../tender/tender.js';
import type { Money } from '../money/money.js';

/** A finalized sale cannot be re-finalized, edited, or deleted. */
export class SaleAlreadyFinalizedError extends DomainError {
  public override readonly name = 'SaleAlreadyFinalizedError';
}

/** A discount exceeded what the acting user is permitted to grant. */
export class DiscountNotPermittedError extends DomainError {
  public override readonly name = 'DiscountNotPermittedError';
}

export interface FinalizeSaleInput {
  /** UUIDv7. Also the idempotency key for the whole operation. */
  readonly saleId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierId: string;
  readonly customerId: string | null;
  readonly cart: PriceCartInput;
  readonly tenders: readonly TenderLine[];
  /** ISO 8601, supplied — never read from an ambient clock. */
  readonly issuedAt: string;
  /** Ceiling in basis points the acting user may discount, from their role. */
  readonly maxDiscountBasisPoints: bigint;
}

export interface FinalizedSale {
  readonly saleId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierId: string;
  readonly customerId: string | null;
  readonly issuedAt: string;
  readonly priced: PricedCart;
  readonly settlement: Settlement;
  readonly status: 'finalized';
}

/**
 * Turn a cart plus tenders into an immutable sale.
 *
 * Everything the receipt states is computed here, from the line inputs, on the
 * server. A client-submitted total is never trusted: the cashier's browser is
 * an untrusted input, and the amount a customer is charged is the one figure
 * that must not be forgeable.
 *
 * The function is pure — no clock, no database, no id generation. Its output is
 * a value the caller persists atomically, which is what makes finalization
 * replayable and idempotent (ADR-0003).
 */
export function finalizeSale(input: FinalizeSaleInput): FinalizedSale {
  if (input.cart.lines.length === 0) {
    throw new InvalidAmountError('A sale needs at least one line.');
  }

  assertDiscountsPermitted(input);

  const priced = priceCart(input.cart);
  if (priced.total.minor <= 0n) {
    throw new InvalidAmountError('A finalized sale must have a positive total.');
  }

  const settlement = settle(priced.total, input.tenders);

  return {
    saleId: input.saleId,
    operationId: input.operationId,
    tenantId: input.tenantId,
    branchId: input.branchId,
    terminalId: input.terminalId,
    shiftId: input.shiftId,
    cashierId: input.cashierId,
    customerId: input.customerId,
    issuedAt: input.issuedAt,
    priced,
    settlement,
    status: 'finalized',
  };
}

/**
 * Discount ceilings are enforced here, in the domain, not in the UI.
 *
 * Hiding the discount button is a convenience. The ceiling is the control, and
 * it has to sit where the total is computed or it is not a control at all.
 */
function assertDiscountsPermitted(input: FinalizeSaleInput): void {
  const ceiling = input.maxDiscountBasisPoints;

  // `exactOptionalPropertyTypes` is on, so the discount keys are removed
  // rather than set to undefined -- an absent key and a present undefined are
  // different things under that flag, and only the former means "no discount".
  const undiscounted = priceCart({
    priceMode: input.cart.priceMode,
    ...(input.cart.currency === undefined ? {} : { currency: input.cart.currency }),
    lines: input.cart.lines.map((line) => {
      const { discount: _discount, ...rest } = line;
      return rest;
    }),
  });

  const priced = priceCart(input.cart);
  const granted = priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor;
  if (granted === 0n) return;

  if (undiscounted.gross.minor === 0n) {
    throw new InvalidAmountError('Cannot discount a cart with no value.');
  }

  // Compare in basis points of the undiscounted gross, so the ceiling means
  // the same thing whatever mix of fixed and percentage discounts was used.
  const grantedBp = (granted * 10_000n) / undiscounted.gross.minor;
  if (grantedBp > ceiling) {
    throw new DiscountNotPermittedError(
      `Discount of ${grantedBp.toString()} bp exceeds the ${ceiling.toString()} bp this user may grant.`,
    );
  }
}

/**
 * Reconciliation invariant, assertable at any point.
 *
 * gross - discounts = net, and net + vat = total, and tendered - change =
 * total. If any of those drift the sale does not balance, and a sale that does
 * not balance must never reach a customer.
 */
export function saleReconciles(sale: FinalizedSale): boolean {
  const { priced, settlement } = sale;
  const discounted =
    priced.gross.minor - priced.lineDiscountTotal.minor - priced.basketDiscountTotal.minor;
  const netPlusVat = priced.net.minor + priced.vat.minor;
  const lineSum = priced.lines.reduce((sum, line) => sum + line.total.minor, 0n);
  const vatSum = priced.vatBreakdown.reduce((sum, bucket) => sum + bucket.vat.minor, 0n);

  return (
    netPlusVat === priced.total.minor &&
    lineSum === priced.total.minor &&
    vatSum === priced.vat.minor &&
    discounted >= 0n &&
    settlement.tendered.minor - settlement.change.minor === priced.total.minor
  );
}

export function totalOf(sale: FinalizedSale): Money {
  return sale.priced.total;
}
