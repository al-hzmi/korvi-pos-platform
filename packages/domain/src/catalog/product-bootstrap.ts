import { DomainError, InvalidRateError } from '../errors.js';
import { basisPoints } from '../tax/basis-points.js';
import type { BasisPoints } from '../tax/basis-points.js';
import type { ProductType } from '../ports/persistence.js';

/**
 * The deliberately small catalogue write used by onboarding.
 *
 * This is not the inventory or purchasing model. It establishes one real
 * catalogue row using the same exact-money and tax representations the sale
 * engine already consumes, so onboarding cannot invent a second pricing model.
 * Stock availability remains separate inventory truth.
 */
export const MAX_PRODUCT_SKU = 64;
export const MAX_PRODUCT_NAME = 200;
export const MAX_UNIT_LABEL = 32;
export const MAX_PRODUCT_BARCODE = 64;

const MINOR_PATTERN = /^(0|[1-9][0-9]{0,14})$/;
function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
const WHITESPACE = /\s/u;

export class ProductBootstrapError extends DomainError {
  public override readonly name = 'ProductBootstrapError';
}

export interface ProductBootstrapDraft {
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn?: string | null | undefined;
  readonly productType: ProductType;
  readonly unitLabel: string;
  /** Halalas as a decimal integer string. Never a JSON number. */
  readonly priceMinor: string;
  /** Omitted means the tenant's configured default VAT rate. */
  readonly vatBasisPoints?: number | undefined;
  readonly barcode?: string | null | undefined;
}

export interface NormalizedProductBootstrap {
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  readonly priceMinor: string;
  readonly vatBasisPoints: BasisPoints;
  readonly barcode: string | null;
}

function normalizedText(value: string, max: number, label: string): string {
  const candidate = value.normalize('NFKC').trim();
  if (candidate === '' || candidate.length > max || hasAsciiControlCharacter(candidate)) {
    throw new ProductBootstrapError(`Invalid ${label}.`);
  }
  return candidate;
}

export function normalizeProductSku(value: string): string {
  const candidate = normalizedText(value, MAX_PRODUCT_SKU, 'product SKU').toUpperCase();
  // Upper-casing compatibility characters can expand them; measure the value
  // that will actually be persisted, not the pre-canonical form.
  if (candidate.length > MAX_PRODUCT_SKU || WHITESPACE.test(candidate)) {
    throw new ProductBootstrapError('Invalid product SKU.');
  }
  return candidate;
}

export function normalizeProductName(value: string): string {
  return normalizedText(value, MAX_PRODUCT_NAME, 'product name');
}

export function normalizeOptionalProductName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const candidate = value.normalize('NFKC').trim();
  if (candidate === '') return null;
  if (candidate.length > MAX_PRODUCT_NAME || hasAsciiControlCharacter(candidate)) {
    throw new ProductBootstrapError('Invalid optional product name.');
  }
  return candidate;
}

export function normalizeUnitLabel(value: string): string {
  return normalizedText(value, MAX_UNIT_LABEL, 'unit label');
}

export function normalizeProductBarcode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const candidate = value.normalize('NFKC').trim();
  if (candidate === '') return null;
  if (
    candidate.length > MAX_PRODUCT_BARCODE ||
    hasAsciiControlCharacter(candidate) ||
    WHITESPACE.test(candidate)
  ) {
    throw new ProductBootstrapError('Invalid product barcode.');
  }
  return candidate;
}

export function normalizeProductPriceMinor(value: string): string {
  if (!MINOR_PATTERN.test(value)) {
    throw new ProductBootstrapError(
      'Product price must be an exact non-negative minor-unit integer.',
    );
  }
  return value;
}

export function normalizeProductBootstrap(
  draft: ProductBootstrapDraft,
  defaultVatBasisPoints: BasisPoints,
): NormalizedProductBootstrap {
  if (draft.productType !== 'unit' && draft.productType !== 'weighted') {
    throw new ProductBootstrapError('Invalid product type.');
  }

  let vat: BasisPoints;
  try {
    vat =
      draft.vatBasisPoints === undefined
        ? defaultVatBasisPoints
        : basisPoints(draft.vatBasisPoints);
  } catch (error) {
    if (error instanceof InvalidRateError) {
      throw new ProductBootstrapError('Invalid VAT rate.');
    }
    throw error;
  }

  return {
    sku: normalizeProductSku(draft.sku),
    nameAr: normalizeProductName(draft.nameAr),
    nameEn: normalizeOptionalProductName(draft.nameEn),
    productType: draft.productType,
    unitLabel: normalizeUnitLabel(draft.unitLabel),
    priceMinor: normalizeProductPriceMinor(draft.priceMinor),
    vatBasisPoints: vat,
    barcode: normalizeProductBarcode(draft.barcode),
  };
}
