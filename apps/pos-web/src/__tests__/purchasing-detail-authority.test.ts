import { describe, expect, it } from 'vitest';
import {
  purchasingDetailAfterIdentityChange,
  type DetailState,
} from '../components/control/purchasing-operations';

function readyDetail(orderId = 'order-a'): DetailState {
  return {
    kind: 'ready',
    order: {
      id: orderId,
      supplierId: 'supplier-a',
      branchId: 'branch-a',
      reference: 'PO-1',
      status: 'open',
      orderedAt: '2026-09-09T00:00:00.000Z',
      lines: [
        {
          id: 'line-a',
          productId: 'product-a',
          orderedQuantityScaled: '4000',
          receivedQuantityScaled: '0',
          remainingQuantityScaled: '4000',
        },
      ],
    },
    receipts: [],
  };
}

describe('purchasing detail identity authority', () => {
  it('invalidates ready detail synchronously before entering receiving', () => {
    const current = readyDetail();
    expect(
      purchasingDetailAfterIdentityChange(current, 'orders', 'receiving', 'order-a', 'order-a'),
    ).toEqual({ kind: 'loading', orderId: 'order-a' });
  });

  it('invalidates ready detail synchronously when selecting another order', () => {
    const current = readyDetail();
    expect(
      purchasingDetailAfterIdentityChange(current, 'receiving', 'receiving', 'order-a', 'order-b'),
    ).toEqual({ kind: 'loading', orderId: 'order-b' });
  });

  it('preserves committed detail when neither workspace nor order identity changes', () => {
    const current = readyDetail();
    expect(
      purchasingDetailAfterIdentityChange(current, 'receiving', 'receiving', 'order-a', 'order-a'),
    ).toBe(current);
  });

  it('drops detail entirely when the next workspace cannot own an order detail', () => {
    const current = readyDetail();
    expect(
      purchasingDetailAfterIdentityChange(current, 'orders', 'suppliers', 'order-a', 'order-a'),
    ).toEqual({ kind: 'idle' });
    expect(
      purchasingDetailAfterIdentityChange(current, 'orders', 'receiving', 'order-a', ''),
    ).toEqual({ kind: 'idle' });
  });
});
