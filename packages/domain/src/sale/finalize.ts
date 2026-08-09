import { DomainError, InvalidAmountError, InvalidDiscountError } from '../errors.js';
import { NO_DISCOUNT, applyDiscount, extendedPrice, priceCart } from '../pricing/line.js';
import {
  effectiveDiscountBasisPoints,
  isDiscountAuthorized,
} from '../pricing/discount-authority.js';
import { assertTenderComposition } from '../tender/tender.js';
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

  // Composition before settlement: a zero tender, a second cash line or an
  // electronic line with no approval behind it is not a payment to settle.
  // After the cart, so a basket that priced to nothing is still reported as
  // the cart problem it is.
  assertTenderComposition(input.tenders);

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
/**
 * The base a discount is measured against is the base it is taken from.
 *
 * This is the whole of the rule. Comparing every discount against the *cart*
 * gross lets a fixed amount destroy a small line and still look modest: a
 * manager capped at 2000 bp, given a 10.00 line beside a 90.00 line, could
 * take 10.00 off the small one — a 100 per cent discount on that line —
 * because 10.00 of a 100.00 cart reads as 1000 bp. The ceiling has to mean the
 * same thing wherever the discount lands, so each scope is checked against its
 * own base:
 *
 *   a line discount, against that line's undiscounted extended price;
 *   a basket discount, against the basket *after* line discounts, because that
 *     is the base priceCart actually applies it to;
 *   and then everything together, against the undiscounted cart gross, so
 *     several individually-legal discounts cannot be stacked into an illegal
 *     one.
 *
 * A requested rate is checked as a rate before any of that, because rounding
 * hides it otherwise: 2001 bp off 23.00 is 4.6023, which rounds to 4.60 — and
 * 4.60 reads back as exactly 2000 bp. The merchant set a rate; the rate is
 * what is checked.
 */
function assertDiscountsPermitted(input: FinalizeSaleInput): void {
  const ceiling = input.maxDiscountBasisPoints;

  function refuseRate(requested: bigint, scope: string): void {
    if (requested > ceiling) {
      throw new DiscountNotPermittedError(
        `A ${requested.toString()} bp ${scope} discount exceeds the ${ceiling.toString()} bp this user may grant.`,
      );
    }
  }

  function refuseAmount(amount: bigint, base: bigint, scope: string): void {
    // Rejected, not capped. applyDiscount would clamp this to the base, which
    // is correct for pricing and wrong here: clamping answers a request nobody
    // made, at a price the cashier never quoted.
    if (amount > base) {
      throw new InvalidDiscountError(
        `A ${scope} discount of ${amount.toString()} exceeds the ${base.toString()} it is taken from.`,
      );
    }
    if (!isDiscountAuthorized(amount, base, ceiling)) {
      const effective = effectiveDiscountBasisPoints(amount, base);
      throw new DiscountNotPermittedError(
        `A ${scope} discount of ${effective.toString()} bp exceeds the ${ceiling.toString()} bp this user may grant.`,
      );
    }
  }

  // --- each line, against its own extended price --------------------------
  let eligibleBasketBase = 0n;
  for (const line of input.cart.lines) {
    const gross = extendedPrice(line.unitPrice, line.quantity);
    const discount = line.discount ?? NO_DISCOUNT;

    if (discount.kind === 'percentage') {
      refuseRate(discount.value, 'line');
    } else if (discount.kind === 'fixed') {
      refuseAmount(discount.value, gross.minor, 'line');
    }

    // What a basket discount will actually be applied to.
    eligibleBasketBase += gross.minor - applyDiscount(gross, discount).minor;
  }

  // --- the basket, against what the lines left behind ---------------------
  const basket = input.cart.basketDiscount;
  if (basket !== undefined && basket.kind !== 'none') {
    if (basket.kind === 'percentage') {
      refuseRate(basket.value, 'basket');
    } else {
      refuseAmount(basket.value, eligibleBasketBase, 'basket');
    }
  }

  // --- and everything together, against the undiscounted cart -------------
  //
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

  // Rounded up, not truncated: 200 halalas off 1999 is 1000.5 bp, and a
  // cashier capped at 1000 bp would otherwise be given it every time.
  const grantedBp = effectiveDiscountBasisPoints(granted, undiscounted.gross.minor);
  if (!isDiscountAuthorized(granted, undiscounted.gross.minor, ceiling)) {
    throw new DiscountNotPermittedError(
      `Discounts totalling ${grantedBp.toString()} bp exceed the ${ceiling.toString()} bp this user may grant.`,
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
