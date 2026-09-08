import { describe, expect, it } from 'vitest';
import {
  beginCostBalanceRefresh,
  failCostBalanceRefresh,
} from '../control/inventory-cost-panel';
import {
  beginInventoryBalanceRefresh,
  failInventoryBalanceRefresh,
} from '../control/inventory-panel';
import {
  beginPurchasingRefresh,
  failPurchasingRefresh,
} from '../control/purchasing-panel';
import type { CostBalancesState } from '../control/inventory-cost-panel';
import type { InventoryBalancesState } from '../control/inventory-panel';
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

describe('inventory balance refresh pagination ownership', () => {
  const branchId = '018fb000-0000-7000-8000-0000000000a1';
  const current: InventoryBalancesState = {
    kind: 'ready',
    branchId,
    page: { rows: [], nextCursor: 'balance-next' },
    loadingMore: true,
    refreshing: false,
    generation: 4,
    loadFailure: null,
  };

  it('retires an in-flight balance page when a first-page read supersedes it', () => {
    expect(beginInventoryBalanceRefresh(current, branchId)).toEqual({
      ...current,
      loadingMore: false,
      refreshing: true,
      loadFailure: null,
    });
  });

  it('keeps pagination retired if the replacement balance read fails', () => {
    const refreshing = beginInventoryBalanceRefresh(current, branchId);

    expect(failInventoryBalanceRefresh(refreshing, branchId, networkFailure)).toEqual({
      ...current,
      loadingMore: false,
      refreshing: false,
      loadFailure: networkFailure,
    });
  });
});

describe('cost balance refresh pagination ownership', () => {
  const current: CostBalancesState = {
    kind: 'ready',
    page: { rows: [], nextCursor: 'cost-next' },
    loadingMore: true,
    refreshing: false,
    generation: 7,
    loadFailure: null,
  };

  it('retires an in-flight cost page when first-page cost facts supersede it', () => {
    expect(beginCostBalanceRefresh(current)).toEqual({
      ...current,
      loadingMore: false,
      refreshing: true,
      loadFailure: null,
    });
  });

  it('keeps cost pagination retired if the replacement cost read fails', () => {
    const refreshing = beginCostBalanceRefresh(current);

    expect(failCostBalanceRefresh(refreshing, networkFailure)).toEqual({
      ...current,
      loadingMore: false,
      refreshing: false,
      loadFailure: networkFailure,
    });
  });
});
