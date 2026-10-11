import { DomainError } from '../errors.js';
import { QUANTITY_SCALE } from '../quantity/quantity.js';
import { assertPackageBaseQuantityScaled } from '../catalog/packaging.js';

export type PriceContext = 'retail' | 'wholesale';
export type ContextPriceListStatus = 'draft' | 'active' | 'paused' | 'archived';
export type PricingProvenance = 'product-base' | 'price-list-base' | 'price-list-package';

export type ContextPriceRefusal =
  | 'invalid-base-price'
  | 'invalid-entry-price'
  | 'ambiguous-active-list'
  | 'duplicate-price-entry'
  | 'wholesale-price-incomplete';

export class ContextPriceError extends DomainError {
  public override readonly name = 'ContextPriceError';
  public readonly detail: ContextPriceRefusal;

  public constructor(detail: ContextPriceRefusal, message: string) {
    super(message);
    this.detail = detail;
  }
}

export interface ContextPriceListEntry {
  readonly productId: string;
  readonly packageId: string | null;
  readonly priceMinor: bigint;
}

export interface ContextPriceList {
  readonly id: string;
  readonly code: string;
  readonly context: PriceContext;
  readonly status: ContextPriceListStatus;
  readonly revision: bigint;
  readonly entries: readonly ContextPriceListEntry[];
}

export interface ContextPriceTarget {
  readonly productId: string;
  readonly packageId: string | null;
  readonly packageBaseQuantityScaled: bigint | null;
  readonly productBasePriceMinor: bigint;
}

export interface ResolvedContextPrice {
  readonly context: PriceContext;
  readonly unitPriceMinor: bigint;
  readonly provenance: PricingProvenance;
  readonly priceListId: string | null;
  readonly priceListCode: string | null;
  readonly priceListRevision: bigint | null;
}

function checkedPrice(value: bigint, detail: ContextPriceRefusal): bigint {
  if (value < 0n) throw new ContextPriceError(detail, 'Price cannot be negative.');
  return value;
}

function selectedFactor(target: ContextPriceTarget): bigint {
  if (target.packageId === null) return QUANTITY_SCALE;
  if (target.packageBaseQuantityScaled === null) {
    throw new ContextPriceError(
      'duplicate-price-entry',
      'Package target is missing its package factor.',
    );
  }
  return assertPackageBaseQuantityScaled(target.packageBaseQuantityScaled);
}

function multipliedBasePrice(basePriceMinor: bigint, factorScaled: bigint): bigint {
  checkedPrice(basePriceMinor, 'invalid-base-price');
  return basePriceMinor * (factorScaled / QUANTITY_SCALE);
}

function uniqueEntry(
  list: ContextPriceList,
  productId: string,
  packageId: string | null,
): ContextPriceListEntry | null {
  const rows = list.entries.filter(
    (entry) => entry.productId === productId && entry.packageId === packageId,
  );
  if (rows.length > 1) {
    throw new ContextPriceError(
      'duplicate-price-entry',
      'Price list contains more than one entry for the same commercial target.',
    );
  }
  const row = rows.at(0) ?? null;
  if (row !== null) checkedPrice(row.priceMinor, 'invalid-entry-price');
  return row;
}

/**
 * Resolve a commercial unit price from server-owned context policy.
 *
 * The client selects a context only. The server snapshot proves that at most
 * one active list exists for that context and resolves every amount.
 */
export function resolveContextPrice(input: {
  readonly context: PriceContext;
  readonly target: ContextPriceTarget;
  readonly lists: readonly ContextPriceList[];
}): ResolvedContextPrice {
  checkedPrice(input.target.productBasePriceMinor, 'invalid-base-price');
  const factor = selectedFactor(input.target);

  const active = input.lists.filter(
    (list) => list.context === input.context && list.status === 'active',
  );
  if (active.length > 1) {
    throw new ContextPriceError(
      'ambiguous-active-list',
      'More than one active price list exists for one context.',
    );
  }
  const list = active.at(0) ?? null;

  if (list !== null) {
    const exact = uniqueEntry(list, input.target.productId, input.target.packageId);
    if (exact !== null) {
      return {
        context: input.context,
        unitPriceMinor: exact.priceMinor,
        provenance: input.target.packageId === null ? 'price-list-base' : 'price-list-package',
        priceListId: list.id,
        priceListCode: list.code,
        priceListRevision: list.revision,
      };
    }

    const base = uniqueEntry(list, input.target.productId, null);
    if (base !== null) {
      return {
        context: input.context,
        unitPriceMinor: multipliedBasePrice(base.priceMinor, factor),
        provenance: 'price-list-base',
        priceListId: list.id,
        priceListCode: list.code,
        priceListRevision: list.revision,
      };
    }
  }

  if (input.context === 'wholesale') {
    throw new ContextPriceError(
      'wholesale-price-incomplete',
      'Wholesale context has no authoritative price for this commercial unit.',
    );
  }

  return {
    context: 'retail',
    unitPriceMinor: multipliedBasePrice(input.target.productBasePriceMinor, factor),
    provenance: 'product-base',
    priceListId: null,
    priceListCode: null,
    priceListRevision: null,
  };
}
