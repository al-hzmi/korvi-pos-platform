import { describe, expect, it } from 'vitest';
import {
  resolveOrderLineProduct,
  resolvePurchasingSelection,
} from '../control/purchasing-operations';

const products = [
  {
    id: 'product-1',
    sku: 'RICE-1',
    nameAr: 'أرز 1',
    nameEn: null,
    productType: 'unit' as const,
    unitLabel: 'حبة',
    isActive: true,
    trackInventory: true,
  },
  {
    id: 'product-2',
    sku: 'RICE-2',
    nameAr: 'أرز 2',
    nameEn: null,
    productType: 'unit' as const,
    unitLabel: 'حبة',
    isActive: true,
    trackInventory: true,
  },
] as const;

describe('purchasing explicit selection identity', () => {
  it('keeps the visible initial default when no explicit id exists yet', () => {
    expect(resolvePurchasingSelection(products, '')?.id).toBe('product-1');
    expect(resolveOrderLineProduct(products, '', 0)?.id).toBe('product-1');
    expect(resolveOrderLineProduct(products, '', 1)?.id).toBe('product-2');
  });

  it('resolves an explicit id only to that exact row', () => {
    expect(resolvePurchasingSelection(products, 'product-2')?.id).toBe('product-2');
    expect(resolveOrderLineProduct(products, 'product-2', 0)?.id).toBe('product-2');
  });

  it('fails closed when a previously explicit selection disappears after refresh', () => {
    expect(resolvePurchasingSelection(products, 'removed-supplier')).toBeUndefined();
    expect(resolveOrderLineProduct(products, 'removed-product', 0)).toBeUndefined();
  });
});
