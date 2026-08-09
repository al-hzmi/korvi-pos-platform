import { DomainError } from '../errors.js';
import {
  ELECTRONIC_SCHEMES,
  MAX_TENDER_REFERENCE_LENGTH,
  looksLikeCardNumber,
} from '../tender/tender.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';
import { prorateLine } from './prorate.js';
import type { BasisPoints } from '../tax/basis-points.js';
import type { ProductType } from '../ports/persistence.js';
import type { TenderScheme } from '../tender/tender.js';
import type { LineComponents } from './prorate.js';

/**
 * Returning goods, as a commercial document.
 *
 * A return is a new document that refers to a sale; it never edits one. The
 * original sale is the only authority for what anything cost — a price change,
 * a VAT change, a rename or a deactivated product must not alter what a
 * customer gets back for goods they bought last month, and the only way to
 * guarantee that is to read the snapshot the sale wrote and nothing else.
 *
 * Everything in this module is pure. It decides what a return is worth and
 * refuses the ones that are not lawful; it does not know what a database, an
 * HTTP request or a shift is. The quantities it is asked about are the ones
 * the caller proved inside a transaction — this module cannot prevent a race
 * and does not pretend to (ADR-0013).
 */

export class InvalidReturnQuantityError extends DomainError {
  public override readonly name = 'InvalidReturnQuantityError';
}

export class OverReturnError extends DomainError {
  public override readonly name = 'OverReturnError';
}

export class DuplicateReturnLineError extends DomainError {
  public override readonly name = 'DuplicateReturnLineError';
}

export class UnknownSaleLineError extends DomainError {
  public override readonly name = 'UnknownSaleLineError';
}

export class NothingReturnableError extends DomainError {
  public override readonly name = 'NothingReturnableError';
}

export class SaleNotReturnableError extends DomainError {
  public override readonly name = 'SaleNotReturnableError';
}

export class InvalidRefundError extends DomainError {
  public override readonly name = 'InvalidRefundError';
}

/**
 * What one sale line permits, as proved from persisted rows.
 *
 * `productType` is the snapshot taken when the sale was written, not the
 * catalogue's answer today. A product changed from unit to weighted next year
 * must not make last year's receipt fractional, and reading the live row would
 * do exactly that. It is nullable because sale lines written before Korvi
 * snapshotted it cannot be improved retroactively: where the fact is absent,
 * no rule is invented (see ADR-0016).
 */
export interface ReturnableLine {
  readonly saleLineId: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly soldQuantityScaled: bigint;
  readonly returnedQuantityScaled: bigint;
  readonly original: LineComponents;
  readonly refunded: Pick<
    LineComponents,
    'grossMinor' | 'netMinor' | 'lineDiscountMinor' | 'basketDiscountMinor' | 'vatMinor'
  >;
}

export function remainingQuantity(line: ReturnableLine): bigint {
  const remaining = line.soldQuantityScaled - line.returnedQuantityScaled;
  return remaining > 0n ? remaining : 0n;
}

export type RefundKind = 'cash' | 'electronic';

export type RefundIntent =
  | { readonly kind: 'cash' }
  | {
      readonly kind: 'electronic';
      readonly scheme: TenderScheme;
      /** Somebody else's approval. Never a card number — see ADR-0015. */
      readonly reference: string;
    };

/**
 * One refund per return document, and one method on it.
 *
 * Split refunds are not refused because they are hard; they are refused
 * because Korvi has no way to prove that two external approvals against one
 * return are not the same approval counted twice. When there is a mechanism
 * that can prove it, that is a strike of its own.
 */
export function assertRefundIntent(intent: RefundIntent): void {
  if (intent.kind === 'cash') return;

  if (!ELECTRONIC_SCHEMES.includes(intent.scheme)) {
    throw new InvalidRefundError('That is not a scheme Korvi records refunds against.');
  }
  const reference = intent.reference.trim();
  if (reference === '') {
    throw new InvalidRefundError(
      'An electronic refund records an approval that happened elsewhere; it needs its reference.',
    );
  }
  if (reference.length > MAX_TENDER_REFERENCE_LENGTH) {
    throw new InvalidRefundError('That refund reference is longer than a reference should be.');
  }
  // The API refuses cardholder data by name and by value before anything
  // reaches here. This is the domain saying the same thing, so a caller that
  // is not the API cannot put a PAN in a settlement row either.
  if (looksLikeCardNumber(reference)) {
    throw new InvalidRefundError(
      'That reference looks like a card number. Korvi will not store one.',
    );
  }
}

export interface RequestedReturnLine {
  readonly saleLineId: string;
  readonly quantityScaled: bigint;
}

export interface ReturnLineDraft {
  readonly saleLineId: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType | null;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: bigint;
  readonly components: LineComponents;
}

export interface ReturnDraft {
  readonly lines: readonly ReturnLineDraft[];
  readonly grossMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly basketDiscountMinor: bigint;
  readonly netMinor: bigint;
  readonly vatMinor: bigint;
  readonly totalMinor: bigint;
}

export interface PlanReturnInput {
  readonly available: readonly ReturnableLine[];
  readonly requested: readonly RequestedReturnLine[];
  readonly refund: RefundIntent;
}

/**
 * Turn a request into the document it would produce, or refuse it.
 *
 * The quantities in `available` must have been read inside the transaction
 * that will write the result. A preflight read is a courtesy to the user
 * interface; it is not authority, and two cashiers returning the last unit of
 * the same line will both have seen it available.
 */
export function planReturn(input: PlanReturnInput): ReturnDraft {
  assertRefundIntent(input.refund);

  if (input.requested.length === 0) {
    throw new InvalidReturnQuantityError('A return of no lines is not a return.');
  }

  const byId = new Map(input.available.map((line) => [line.saleLineId, line]));
  const seen = new Set<string>();
  const lines: ReturnLineDraft[] = [];

  for (const request of input.requested) {
    if (seen.has(request.saleLineId)) {
      // Two rows for one line would each pass a remaining-quantity check their
      // sum fails, which is the same defect the checkout refuses on the way in.
      throw new DuplicateReturnLineError('One line, one row. Sum the quantity in the client.');
    }
    seen.add(request.saleLineId);

    const line = byId.get(request.saleLineId);
    // Not found and belonging to another sale are the same answer on purpose:
    // the caller learns that this sale does not have that line, and nothing
    // about whether the line exists somewhere else.
    if (line === undefined) {
      throw new UnknownSaleLineError('That line is not part of this sale.');
    }

    if (request.quantityScaled <= 0n) {
      throw new InvalidReturnQuantityError('A return quantity must be positive.');
    }
    // Whole units only where the sale itself recorded that the line was sold
    // by the unit. If the immutable product-type snapshot is absent, today's
    // catalogue is not consulted and divisibility is not used as a heuristic.
    // The only safe operation is returning the entire remaining quantity: that
    // requires no interpretation of whether the historical line was unit or
    // weighted. Any partial return must wait for a line whose type is known.
    if (line.productType === 'unit' && request.quantityScaled % QUANTITY_SCALE !== 0n) {
      throw new InvalidReturnQuantityError('A unit product cannot be returned in fractions.');
    }

    const remaining = remainingQuantity(line);
    if (line.productType === null && request.quantityScaled !== remaining) {
      throw new InvalidReturnQuantityError(
        'This historical line has no immutable unit/weight snapshot; only its entire remaining quantity can be returned.',
      );
    }
    if (remaining === 0n) {
      throw new NothingReturnableError('Everything on that line has already been returned.');
    }
    if (request.quantityScaled > remaining) {
      throw new OverReturnError('That is more than the line has left to return.');
    }

    lines.push({
      saleLineId: line.saleLineId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      productType: line.productType,
      vatBasisPoints: line.vatBasisPoints,
      quantityScaled: request.quantityScaled,
      components: prorateLine({
        original: line.original,
        soldQuantityScaled: line.soldQuantityScaled,
        returnedQuantityScaled: line.returnedQuantityScaled,
        refunded: line.refunded,
        quantityScaled: request.quantityScaled,
      }),
    });
  }

  const sum = (pick: (components: LineComponents) => bigint): bigint =>
    lines.reduce((total, line) => total + pick(line.components), 0n);

  const draft: ReturnDraft = {
    lines,
    grossMinor: sum((components) => components.grossMinor),
    lineDiscountMinor: sum((components) => components.lineDiscountMinor),
    basketDiscountMinor: sum((components) => components.basketDiscountMinor),
    netMinor: sum((components) => components.netMinor),
    vatMinor: sum((components) => components.vatMinor),
    totalMinor: sum((components) => components.totalMinor),
  };

  if (draft.totalMinor <= 0n) {
    // A return worth nothing is a refund of nothing. It would still consume a
    // return number and a drawer movement, and reconcile against nothing.
    throw new NothingReturnableError('That return is worth nothing to refund.');
  }
  assertReturnReconciles(draft);
  return draft;
}

/**
 * The identity every money document in Korvi satisfies, asserted before it can
 * be written.
 *
 * `net + VAT = total`, at the line and at the document. It is deliberately the
 * only one: `gross - discounts` equals the total under tax-inclusive pricing
 * and the net under tax-exclusive, so asserting either would be wrong for half
 * of Korvi's tenants.
 *
 * The database says the same thing in CHECK constraints, and finding out there
 * means finding out from a driver error at the end of a transaction that has
 * already moved stock.
 */
export function assertReturnReconciles(draft: ReturnDraft): void {
  for (const line of draft.lines) {
    const { netMinor, vatMinor, totalMinor } = line.components;
    if (netMinor + vatMinor !== totalMinor) {
      throw new ProrationMismatchError('A return line does not reconcile: net + VAT <> total.');
    }
  }
  if (draft.netMinor + draft.vatMinor !== draft.totalMinor) {
    throw new ProrationMismatchError('The return does not reconcile: net + VAT <> total.');
  }
}

export class ProrationMismatchError extends DomainError {
  public override readonly name = 'ProrationMismatchError';
}
