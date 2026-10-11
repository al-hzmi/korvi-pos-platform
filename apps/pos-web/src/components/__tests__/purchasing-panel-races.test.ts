import { describe, expect, it } from 'vitest';
import {
  appendPurchasingPageIfCurrent,
  beginPurchasingRefresh,
  canStartPurchasingPage,
  type PurchasingState,
} from '../control/purchasing-panel';

function readyState(
  overrides: Partial<Extract<PurchasingState, { kind: 'ready' }>> = {},
): Extract<PurchasingState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    pages: {
      branches: { rows: [], nextCursor: 'branches-2' },
      products: { rows: [], nextCursor: 'products-2' },
      suppliers: { rows: [], nextCursor: 'suppliers-2' },
      orders: { rows: [], nextCursor: 'orders-2' },
    },
    refreshing: false,
    loadingMore: null,
    failure: null,
    ...overrides,
  };
}

describe('purchasing refresh/pagination ownership', () => {
  it('refuses pagination whenever a first-page refresh already owns the read boundary', () => {
    const ready = readyState();

    expect(canStartPurchasingPage(ready, false, false)).toBe(true);
    expect(canStartPurchasingPage({ ...ready, refreshing: true }, false, false)).toBe(false);
    expect(canStartPurchasingPage(ready, false, true)).toBe(false);
    expect(canStartPurchasingPage(ready, true, false)).toBe(false);
    expect(canStartPurchasingPage({ ...ready, loadingMore: 'orders' }, false, false)).toBe(false);
  });

  it('rejects a superseded page after refresh replaces its cursor', () => {
    const paging = readyState({ loadingMore: 'suppliers' });
    const refreshed = {
      ...beginPurchasingRefresh(paging),
      pages: {
        ...paging.pages,
        suppliers: { rows: [], nextCursor: 'suppliers-new-2' },
      },
      refreshing: false,
    } as PurchasingState;

    const result = appendPurchasingPageIfCurrent(refreshed, 'suppliers', 'suppliers-2', {
      rows: [],
      nextCursor: 'suppliers-3',
    });

    expect(result).toBe(refreshed);
  });

  it('accepts only the page that still owns the exact cursor and loading slot', () => {
    const paging = readyState({ loadingMore: 'orders' });

    const applied = appendPurchasingPageIfCurrent(paging, 'orders', 'orders-2', {
      rows: [],
      nextCursor: 'orders-3',
    });

    expect(applied).not.toBe(paging);
    expect(applied.kind).toBe('ready');
    if (applied.kind !== 'ready') throw new Error('expected ready purchasing state');
    expect(applied.pages.orders.nextCursor).toBe('orders-3');
    expect(applied.loadingMore).toBeNull();

    expect(
      appendPurchasingPageIfCurrent(paging, 'suppliers', 'suppliers-2', {
        rows: [],
        nextCursor: 'suppliers-3',
      }),
    ).toBe(paging);
  });
});
