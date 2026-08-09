import { DomainError } from '../errors.js';

/**
 * How a partial return keeps its arithmetic honest.
 *
 * The naive implementation prorates each return on its own: take the line's
 * net, multiply by the quantity coming back, divide by the quantity sold,
 * round. It is wrong, and it is wrong in the direction that costs a merchant
 * money without anybody noticing. A line of three items whose net is 1000
 * halalas prorates to 333 each; three separate returns of one item refund 999
 * and the merchant keeps a halala that belongs to the customer. Return the
 * same three on one document and the refund is 1000. The same goods, two
 * different answers, and no error message anywhere.
 *
 * So nothing is prorated per return. Each component is prorated against the
 * *cumulative* quantity returned so far, and what this return pays is the
 * difference between the new cumulative target and what has already been
 * refunded:
 *
 *   target(q) = floor(original * q / soldQuantity)
 *   thisReturn = target(newCumulative) - alreadyRefunded
 *
 * At full quantity the target is the original component exactly, so the sum of
 * every return against a line equals the line — for any sequence of partial
 * returns, in any order, of any sizes. The remainder lands on whichever return
 * crosses the boundary rather than being lost at each step.
 *
 * `alreadyRefunded` is read from the return rows that exist, not recomputed
 * from the formula. If an earlier return was written by an older version of
 * this code, or corrected by hand, the cumulative identity still closes: the
 * last return absorbs the difference.
 *
 * Integer arithmetic throughout. Every value here is a bigint of minor units
 * or of scaled quantity, and there is no point at which a ratio becomes a
 * number (ADR-0002).
 */

export class ProrationError extends DomainError {
  public override readonly name = 'ProrationError';
}

/**
 * The cumulative share of `original` owed once `returned` of `sold` has come
 * back.
 *
 * Floor rather than round, and floor is deliberate: it makes the sequence
 * monotone, which is what makes every individual delta non-negative. A
 * rounding rule that could step down would produce a return line asking the
 * customer for money back.
 */
export function cumulativeTarget(original: bigint, returned: bigint, sold: bigint): bigint {
  if (sold <= 0n) throw new ProrationError('A line that sold nothing cannot be returned.');
  if (returned < 0n) throw new ProrationError('A negative cumulative return is not a quantity.');
  if (returned > sold) throw new ProrationError('More has been returned than was ever sold.');
  if (original < 0n) throw new ProrationError('A negative original component cannot be prorated.');

  // BigInt division truncates toward zero; both operands are non-negative, so
  // that is floor.
  return (original * returned) / sold;
}

/**
 * The five components that are prorated, and the one that is derived.
 *
 * Gross, net, the two discounts and VAT are each prorated against the
 * cumulative quantity. `total` is then derived as `net + vat` rather than
 * prorated, because that is the identity Korvi actually enforces on a line —
 * in the database, in the domain, and on a receipt.
 *
 * `gross - discounts` is deliberately *not* asserted to equal net. Under
 * tax-inclusive pricing, which is what Saudi retail uses, the extended price
 * already contains the VAT: gross minus the discounts is the *total*, and the
 * net is extracted from it. Under tax-exclusive pricing the same subtraction
 * gives the net. One expression cannot be both, so the only identity carried
 * here is the one that holds in either mode.
 *
 * Deriving `total` also keeps every delta non-negative: each prorated
 * component is monotone in the cumulative quantity, so each delta is at least
 * zero, and total is the sum of two such deltas.
 */
export interface LineComponents {
  readonly netMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly basketDiscountMinor: bigint;
  readonly vatMinor: bigint;
  readonly grossMinor: bigint;
  readonly totalMinor: bigint;
}

export interface ProrationInput {
  /** What the original sale line says. Never today's catalogue. */
  readonly original: LineComponents;
  readonly soldQuantityScaled: bigint;
  /** Finalized returns against this line, before this one. */
  readonly returnedQuantityScaled: bigint;
  readonly refunded: Pick<
    LineComponents,
    'grossMinor' | 'netMinor' | 'lineDiscountMinor' | 'basketDiscountMinor' | 'vatMinor'
  >;
  /** What is coming back now. */
  readonly quantityScaled: bigint;
}

export function prorateLine(input: ProrationInput): LineComponents {
  const { original, soldQuantityScaled: sold, refunded } = input;
  const cumulative = input.returnedQuantityScaled + input.quantityScaled;

  const grossMinor = cumulativeTarget(original.grossMinor, cumulative, sold) - refunded.grossMinor;
  const netMinor = cumulativeTarget(original.netMinor, cumulative, sold) - refunded.netMinor;
  const lineDiscountMinor =
    cumulativeTarget(original.lineDiscountMinor, cumulative, sold) - refunded.lineDiscountMinor;
  const basketDiscountMinor =
    cumulativeTarget(original.basketDiscountMinor, cumulative, sold) - refunded.basketDiscountMinor;
  const vatMinor = cumulativeTarget(original.vatMinor, cumulative, sold) - refunded.vatMinor;

  if (
    grossMinor < 0n ||
    netMinor < 0n ||
    lineDiscountMinor < 0n ||
    basketDiscountMinor < 0n ||
    vatMinor < 0n
  ) {
    // Only reachable when the refunded totals already exceed the cumulative
    // target — a line that has been over-refunded by something other than this
    // code. Refusing is the only safe answer: the alternative is a return
    // document that takes money back off a customer.
    throw new ProrationError('This line has already been refunded beyond its cumulative share.');
  }

  return {
    grossMinor,
    netMinor,
    lineDiscountMinor,
    basketDiscountMinor,
    vatMinor,
    totalMinor: netMinor + vatMinor,
  };
}
