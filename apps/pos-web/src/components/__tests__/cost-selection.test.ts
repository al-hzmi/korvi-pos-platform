import { describe, expect, it } from 'vitest';
import { resolveCostProduct } from '../control/inventory-cost-panel';
import type { InventoryCostBalanceRow } from '../../lib/api-types';

const products = [
  { productId: 'product-1' },
  { productId: 'product-2' },
] as InventoryCostBalanceRow[];

describe('cost explicit selection identity', () => {
  it('uses the first eligible row only before an explicit choice', () => {
    expect(resolveCostProduct(products, '')?.productId).toBe('product-1');
  });

  it('keeps an explicit choice bound to its exact product identity', () => {
    expect(resolveCostProduct(products, 'product-2')?.productId).toBe('product-2');
  });

  it('fails closed when a refreshed cost read removes the explicit product', () => {
    expect(resolveCostProduct(products, 'removed-product')).toBeUndefined();
  });
});
