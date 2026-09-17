import { describe, expect, it } from 'vitest';
import { cartReducer, cartToRequestLines } from '../lib/cart';
import { quickServiceOrderNumber } from '../lib/quick-service';
import type { ProductSummary } from '../lib/api-types';

const PRODUCT: ProductSummary = {
  id: '018f1000-0000-7000-8000-000000000111',
  sku: 'QS-1',
  nameAr: 'ساندويتش',
  nameEn: null,
  productType: 'unit',
  unitLabel: 'each',
  priceMinor: '1200',
  vatBasisPoints: 1500,
  primaryBarcode: null,
  trackInventory: true,
  categoryId: '018f1000-0000-7000-8000-000000000112',
  categoryNameAr: 'الساندويتشات',
  categorySortOrder: 1,
  imageUrl: 'https://example.test/qs-1.jpg',
};

describe('Quick-Service operational state', () => {
  it('derives the same order number from the same financial operation', () => {
    const operationId = '018f1000-0000-7000-8000-000000000123';
    expect(quickServiceOrderNumber(operationId, 'K01')).toBe(
      quickServiceOrderNumber(operationId, 'K01'),
    );
    expect(quickServiceOrderNumber(operationId, 'K01')).toBe('K01-00000123');
  });

  it('keeps preparation notes and options out of the checkout authority payload', () => {
    let lines = cartReducer([], { type: 'add', product: PRODUCT });
    lines = cartReducer(lines, {
      type: 'set-preparation',
      productId: PRODUCT.id,
      note: 'تغليف منفصل',
      options: 'بدون بصل',
    });

    expect(lines[0]).toMatchObject({
      preparationNote: 'تغليف منفصل',
      preparationOptions: 'بدون بصل',
    });
    expect(cartToRequestLines(lines)).toEqual([
      { productId: PRODUCT.id, quantityScaled: '1000' },
    ]);
  });
});
