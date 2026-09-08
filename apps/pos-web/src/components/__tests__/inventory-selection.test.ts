import { describe, expect, it } from 'vitest';
import {
  resolveInventoryDestination,
  resolveInventoryProduct,
} from '../control/inventory-operations';
import type { InventoryBalanceRow, InventoryBranch } from '../../lib/api-types';

const products = [{ productId: 'product-1' }, { productId: 'product-2' }] as InventoryBalanceRow[];

const destinations = [{ id: 'branch-1' }, { id: 'branch-2' }] as InventoryBranch[];

describe('inventory explicit selection identity', () => {
  it('keeps the deliberate first default before an explicit choice', () => {
    expect(resolveInventoryProduct(products, '')?.productId).toBe('product-1');
    expect(resolveInventoryDestination(destinations, '')?.id).toBe('branch-1');
  });

  it('keeps an explicit choice bound to its exact identity', () => {
    expect(resolveInventoryProduct(products, 'product-2')?.productId).toBe('product-2');
    expect(resolveInventoryDestination(destinations, 'branch-2')?.id).toBe('branch-2');
  });

  it('fails closed instead of silently moving stock intent after refresh', () => {
    expect(resolveInventoryProduct(products, 'removed-product')).toBeUndefined();
    expect(resolveInventoryDestination(destinations, 'removed-branch')).toBeUndefined();
  });
});
