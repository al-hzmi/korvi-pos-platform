import { describe, expect, it } from 'vitest';
import { bindVisibleSelectionId } from '../../lib/draft-identity';

describe('visible draft identity binding', () => {
  it('materializes the visible default when decision input begins', () => {
    expect(bindVisibleSelectionId('', 'product-1')).toBe('product-1');
  });

  it('never replaces an already-bound identity after refresh', () => {
    expect(bindVisibleSelectionId('product-1', 'product-2')).toBe('product-1');
    expect(bindVisibleSelectionId('removed-product', undefined)).toBe('removed-product');
  });

  it('stays unbound when there is no visible entity to bind', () => {
    expect(bindVisibleSelectionId('', undefined)).toBe('');
  });
});
