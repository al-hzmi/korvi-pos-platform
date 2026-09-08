import { describe, expect, it } from 'vitest';
import {
  beginPurchasingRefresh,
  failPurchasingRefresh,
} from '../control/purchasing-panel';
import type { PurchasingPages, PurchasingState } from '../control/purchasing-panel';
import type { Failure } from '../../lib/failures';

const pages: PurchasingPages = {
  branches: { rows: [], nextCursor: 'branch-next' },
  products: { rows: [], nextCursor: 'product-next' },
  suppliers: { rows: [], nextCursor: 'supplier-next' },
  orders: { rows: [], nextCursor: 'order-next' },
};

const networkFailure: Failure = {
  code: 'network',
  message: 'تعذر التحديث.',
  action: 'retry-same',
};

describe('purchasing refresh pagination ownership', () => {
  it('retires an in-flight page marker when first-page refresh supersedes it', () => {
    const current: PurchasingState = {
      kind: 'ready',
      pages,
      refreshing: false,
      loadingMore: 'products',
      failure: null,
    };

    const refreshing = beginPurchasingRefresh(current);

    expect(refreshing).toEqual({
      kind: 'ready',
      pages,
      refreshing: true,
      loadingMore: null,
      failure: null,
    });
  });

  it('does not resurrect cancelled pagination when the replacement refresh fails', () => {
    const current: PurchasingState = {
      kind: 'ready',
      pages,
      refreshing: true,
      loadingMore: 'orders',
      failure: null,
    };

    const failed = failPurchasingRefresh(current, networkFailure);

    expect(failed).toEqual({
      kind: 'ready',
      pages,
      refreshing: false,
      loadingMore: null,
      failure: networkFailure,
    });
  });
});
