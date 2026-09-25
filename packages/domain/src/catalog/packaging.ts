import { DomainError } from '../errors.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';

export type PackagingRefusal =
  | 'invalid-factor'
  | 'invalid-commercial-quantity'
  | 'quantity-overflow';

export class PackagingError extends DomainError {
  public override readonly name = 'PackagingError';
  public readonly detail: PackagingRefusal;

  public constructor(detail: PackagingRefusal, message: string) {
    super(message);
    this.detail = detail;
  }
}

/**
 * The largest positive scaled quantity accepted by Korvi's existing stock
 * boundary: eighteen decimal digits.
 */
export const MAX_SCALED_QUANTITY = 999_999_999_999_999_999n;

/**
 * A V2-3 package is a non-base commercial unit for a unit Product.
 *
 * The base Product itself is the implicit factor-1 selling unit, so a package
 * factor must represent more than one whole base unit. Weighted/fractional
 * package graphs are deliberately outside ADR-0038.
 */
export function assertPackageBaseQuantityScaled(value: bigint): bigint {
  if (value <= QUANTITY_SCALE || value % QUANTITY_SCALE !== 0n) {
    throw new PackagingError(
      'invalid-factor',
      'A package must contain more than one whole base unit.',
    );
  }
  if (value > MAX_SCALED_QUANTITY) {
    throw new PackagingError('quantity-overflow', 'Package factor exceeds Korvi quantity bounds.');
  }
  return value;
}

/**
 * Convert whole package count into the one authoritative base Product quantity.
 *
 * commercialQuantityScaled=1000 means one package. No money is involved and
 * no rounding is permitted.
 */
export function packageInventoryQuantityScaled(input: {
  readonly commercialQuantityScaled: bigint;
  readonly packageBaseQuantityScaled: bigint;
}): bigint {
  const factor = assertPackageBaseQuantityScaled(input.packageBaseQuantityScaled);
  const commercial = input.commercialQuantityScaled;

  if (commercial <= 0n || commercial % QUANTITY_SCALE !== 0n) {
    throw new PackagingError(
      'invalid-commercial-quantity',
      'Package quantity must be a positive whole package count.',
    );
  }

  const packageCount = commercial / QUANTITY_SCALE;
  if (packageCount > MAX_SCALED_QUANTITY / factor) {
    throw new PackagingError(
      'quantity-overflow',
      'Package conversion exceeds Korvi quantity bounds.',
    );
  }
  return packageCount * factor;
}

/**
 * Base-unit commerce preserves the pre-V2-3 invariant: commercial quantity and
 * inventory quantity are one and the same scaled Product quantity.
 */
export function baseInventoryQuantityScaled(commercialQuantityScaled: bigint): bigint {
  if (commercialQuantityScaled <= 0n || commercialQuantityScaled > MAX_SCALED_QUANTITY) {
    throw new PackagingError(
      'invalid-commercial-quantity',
      'Base commercial quantity must be a positive bounded scaled quantity.',
    );
  }
  return commercialQuantityScaled;
}
