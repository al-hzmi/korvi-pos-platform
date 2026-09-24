import { DomainError } from '../errors.js';
import { priceCart } from '../pricing/line.js';
import { QUANTITY_SCALE, quantity } from '../quantity/quantity.js';
import type { Money } from '../money/money.js';
import type { PriceMode } from '../pricing/line.js';
import type { BasisPoints } from '../tax/basis-points.js';

export class InvalidNoReceiptExchangeQuantityError extends DomainError {
  public override readonly name = 'InvalidNoReceiptExchangeQuantityError';
}

export class DuplicateNoReceiptExchangeProductError extends DomainError {
  public override readonly name = 'DuplicateNoReceiptExchangeProductError';
}

export class NoReceiptExchangeAllowanceError extends DomainError {
  public override readonly name = 'NoReceiptExchangeAllowanceError';
}

export interface NoReceiptExchangeCurrentProduct {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly quantityScaled: bigint;
  readonly currentUnitReferencePrice: Money;
  readonly currentVatBasisPoints: BasisPoints;
  readonly trackInventory: boolean;
}

export interface NoReceiptExchangeAcceptedLine {
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly quantityScaled: bigint;
  readonly currentUnitReferencePriceMinor: bigint;
  readonly currentVatBasisPoints: BasisPoints;
  readonly currentReferenceTotalMinor: bigint;
  readonly trackInventory: boolean;
}

export interface NoReceiptExchangePolicyPlan {
  readonly currency: string;
  /** Current merchant-policy reference only; never original-sale evidence. */
  readonly referenceCeilingMinor: bigint;
  readonly approvedAllowanceMinor: bigint;
  readonly lines: readonly NoReceiptExchangeAcceptedLine[];
}

/**
 * Value goods only under current merchant policy.
 *
 * There is intentionally no original-sale input. With no receipt Korvi has no
 * authority to reconstruct original price, VAT, discounts, tender, historical
 * cost or invoice provenance (ADR-0036).
 */
export function planNoReceiptExchangePolicy(input: {
  readonly priceMode: PriceMode;
  readonly currency: string;
  readonly accepted: readonly NoReceiptExchangeCurrentProduct[];
  readonly approvedAllowanceMinor: bigint;
}): NoReceiptExchangePolicyPlan {
  if (input.accepted.length === 0) {
    throw new InvalidNoReceiptExchangeQuantityError('At least one accepted product is required.');
  }

  const seen = new Set<string>();
  for (const line of input.accepted) {
    if (seen.has(line.productId)) {
      throw new DuplicateNoReceiptExchangeProductError(
        'Each accepted product may appear only once in a no-receipt exchange.',
      );
    }
    seen.add(line.productId);
    if (line.quantityScaled <= 0n) {
      throw new InvalidNoReceiptExchangeQuantityError(
        'Accepted exchange quantity must be positive.',
      );
    }
    if (line.productType === 'unit' && line.quantityScaled % QUANTITY_SCALE !== 0n) {
      throw new InvalidNoReceiptExchangeQuantityError(
        'Unit products may only be accepted in whole-unit quantities.',
      );
    }
  }

  const priced = priceCart({
    priceMode: input.priceMode,
    currency: input.currency as 'SAR',
    lines: input.accepted.map((line, index) => ({
      lineId: `accepted-${String(index + 1)}`,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      nameEn: line.nameEn,
      unitPrice: line.currentUnitReferencePrice,
      quantity: quantity(line.quantityScaled),
      vatRate: line.currentVatBasisPoints,
    })),
  });

  if (input.approvedAllowanceMinor < 0n || input.approvedAllowanceMinor > priced.total.minor) {
    throw new NoReceiptExchangeAllowanceError(
      'Approved allowance must stay within the current-policy reference ceiling.',
    );
  }

  return {
    currency: input.currency,
    referenceCeilingMinor: priced.total.minor,
    approvedAllowanceMinor: input.approvedAllowanceMinor,
    lines: input.accepted.map((line, index) => {
      const pricedLine = priced.lines[index];
      if (pricedLine === undefined) throw new Error('No-receipt exchange pricing invariant failed.');
      return {
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        quantityScaled: line.quantityScaled,
        currentUnitReferencePriceMinor: line.currentUnitReferencePrice.minor,
        currentVatBasisPoints: line.currentVatBasisPoints,
        currentReferenceTotalMinor: pricedLine.total.minor,
        trackInventory: line.trackInventory,
      };
    }),
  };
}
