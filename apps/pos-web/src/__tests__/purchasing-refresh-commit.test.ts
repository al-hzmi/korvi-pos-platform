import { describe, expect, it } from 'vitest';
import {
  hasCommittedPurchasingRefresh,
  type PurchasingPages,
  type PurchasingState,
} from '../components/control/purchasing-panel';

function emptyPages(): PurchasingPages {
  const page = { rows: [], nextCursor: null };
  return {
    branches: page,
    products: page,
    suppliers: page,
    orders: page,
  };
}

describe('purchasing refresh commit authority', () => {
  it('does not acknowledge a network-complete refresh before its exact pages are committed', () => {
    const previous = emptyPages();
    const refreshed = emptyPages();
    const staleReady: PurchasingState = {
      kind: 'ready',
      pages: previous,
      refreshing: false,
      loadingMore: null,
      failure: null,
    };
    const refreshing: PurchasingState = { ...staleReady, refreshing: true };

    expect(hasCommittedPurchasingRefresh(refreshing, refreshed)).toBe(false);
    expect(hasCommittedPurchasingRefresh(staleReady, refreshed)).toBe(false);
  });

  it('acknowledges only the exact refreshed page snapshot after commit', () => {
    const refreshed = emptyPages();
    const committed: PurchasingState = {
      kind: 'ready',
      pages: refreshed,
      refreshing: false,
      loadingMore: null,
      failure: null,
    };

    expect(hasCommittedPurchasingRefresh(committed, refreshed)).toBe(true);
    expect(hasCommittedPurchasingRefresh(committed, { ...refreshed })).toBe(false);
  });
});
