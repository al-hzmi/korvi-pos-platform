import { describe, expect, it } from 'vitest';
import {
  ProductBootstrapError,
  basisPoints,
  normalizeProductBarcode,
  normalizeProductBootstrap,
  normalizeProductPriceMinor,
  normalizeProductSku,
} from '../../index.js';

const DEFAULT_VAT = basisPoints(1_500);

const valid = () => ({
  sku: ' sku-01 ',
  nameAr: ' قهوة ',
  nameEn: ' Coffee ',
  productType: 'unit' as const,
  unitLabel: ' each ',
  priceMinor: '1250',
  barcode: '6281000000012',
});

describe('product bootstrap invariants', () => {
  it('canonicalises the values that become catalogue keys and display text', () => {
    const result = normalizeProductBootstrap(valid(), DEFAULT_VAT);
    expect(result).toMatchObject({
      sku: 'SKU-01',
      nameAr: 'قهوة',
      nameEn: 'Coffee',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1250',
      barcode: '6281000000012',
    });
    expect(result.vatBasisPoints).toBe(1_500n);
  });

  it('uses the tenant default VAT unless the product explicitly supplies one', () => {
    expect(normalizeProductBootstrap(valid(), DEFAULT_VAT).vatBasisPoints).toBe(1_500n);
    expect(
      normalizeProductBootstrap({ ...valid(), vatBasisPoints: 0 }, DEFAULT_VAT).vatBasisPoints,
    ).toBe(0n);
  });

  it('rejects every representation that could reintroduce approximate money', () => {
    for (const bad of ['-1', '+1', '01', '1.5', '1e3', '', '1000000000000000']) {
      expect(() => normalizeProductPriceMinor(bad), bad).toThrow(ProductBootstrapError);
    }
    expect(normalizeProductPriceMinor('0')).toBe('0');
    expect(normalizeProductPriceMinor('999999999999999')).toBe('999999999999999');
  });

  it('measures the canonical SKU, not the spelling sent by the client', () => {
    expect(normalizeProductSku('ｓｋｕ-１２')).toBe('SKU-12');
    expect(() => normalizeProductSku('SKU 12')).toThrow(ProductBootstrapError);
  });

  it('refuses whitespace and control characters inside a barcode', () => {
    expect(() => normalizeProductBarcode('6281 0000')).toThrow(ProductBootstrapError);
    expect(() => normalizeProductBarcode('6281\n0000')).toThrow(ProductBootstrapError);
    expect(normalizeProductBarcode(' 62810000 ')).toBe('62810000');
  });

  it('refuses fractional, negative and over-range VAT rates', () => {
    for (const vat of [-1, 1.5, 10_001]) {
      expect(() => normalizeProductBootstrap({ ...valid(), vatBasisPoints: vat }, DEFAULT_VAT)).toThrow(
        ProductBootstrapError,
      );
    }
  });

  it('keeps product type finite and explicit', () => {
    expect(() =>
      normalizeProductBootstrap(
        { ...valid(), productType: 'service' as unknown as 'unit' },
        DEFAULT_VAT,
      ),
    ).toThrow(ProductBootstrapError);
  });

  it('turns an absent or blank optional English name and barcode into null', () => {
    const result = normalizeProductBootstrap(
      { ...valid(), nameEn: '   ', barcode: '   ' },
      DEFAULT_VAT,
    );
    expect(result.nameEn).toBeNull();
    expect(result.barcode).toBeNull();
  });
});
