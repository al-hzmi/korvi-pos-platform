import { describe, expect, it } from 'vitest';
import {
  buildPurchaseOrderIntent,
  buildPurchaseReceiptIntent,
  describePurchasingCommandFailure,
} from '../purchasing-command';
import { ApiError } from '../api';
import type { PurchaseOrder, PurchasingProduct } from '../api-types';

const UNIT: PurchasingProduct = {
  id: 'product-unit',
  sku: 'UNIT',
  nameAr: 'صنف عددي',
  nameEn: null,
  productType: 'unit',
  unitLabel: 'حبة',
  isActive: true,
  trackInventory: true,
};

const WEIGHTED: PurchasingProduct = {
  ...UNIT,
  id: 'product-weighted',
  sku: 'WEIGHT',
  nameAr: 'صنف وزني',
  productType: 'weighted',
  unitLabel: 'كجم',
};

const ORDER: PurchaseOrder = {
  id: 'order-1',
  supplierId: 'supplier-1',
  branchId: 'branch-1',
  reference: null,
  status: 'partially_received',
  orderedAt: '2026-08-31T00:00:00.000Z',
  lines: [
    {
      id: 'line-1',
      productId: WEIGHTED.id,
      orderedQuantityScaled: '900719925474099300',
      receivedQuantityScaled: '1000',
      remainingQuantityScaled: '900719925474098300',
    },
  ],
};

describe('purchasing command construction', () => {
  it('preserves multi-line quantities past JavaScript safe integer range exactly', () => {
    const built = buildPurchaseOrderIntent(
      {
        supplierId: 'supplier-1',
        branchId: 'branch-1',
        reference: ' PO-900 ',
        lines: [
          { product: UNIT, quantity: '900719925474099' },
          { product: WEIGHTED, quantity: '999999999999999.999' },
        ],
      },
      () => 'op-order',
    );

    expect(built).toEqual({
      ok: true,
      intent: {
        kind: 'order-create',
        request: {
          operationId: 'op-order',
          supplierId: 'supplier-1',
          branchId: 'branch-1',
          reference: 'PO-900',
          lines: [
            { productId: UNIT.id, orderedQuantityScaled: '900719925474099000' },
            { productId: WEIGHTED.id, orderedQuantityScaled: '999999999999999999' },
          ],
        },
      },
    });
  });

  it('refuses duplicate products and fractional unit quantities before minting an id', () => {
    let minted = false;
    const duplicate = buildPurchaseOrderIntent(
      {
        supplierId: 's',
        branchId: 'b',
        reference: '',
        lines: [
          { product: UNIT, quantity: '1' },
          { product: UNIT, quantity: '2' },
        ],
      },
      () => {
        minted = true;
        return 'op';
      },
    );
    expect(duplicate.ok).toBe(false);
    expect(minted).toBe(false);

    const fractional = buildPurchaseOrderIntent(
      {
        supplierId: 's',
        branchId: 'b',
        reference: '',
        lines: [{ product: UNIT, quantity: '1.5' }],
      },
      () => 'op',
    );
    expect(fractional).toMatchObject({ ok: false });
  });

  it('builds a partial receipt from server line identities and never includes cost authority', () => {
    const built = buildPurchaseReceiptIntent(
      {
        order: ORDER,
        reference: ' DN-7 ',
        products: [WEIGHTED],
        quantities: { 'line-1': '2.125' },
      },
      () => 'op-receipt',
    );
    expect(built).toEqual({
      ok: true,
      intent: {
        kind: 'receipt',
        request: {
          operationId: 'op-receipt',
          purchaseOrderId: ORDER.id,
          reference: 'DN-7',
          lines: [{ purchaseOrderLineId: 'line-1', acceptedQuantityScaled: '2125' }],
        },
      },
    });
    expect(JSON.stringify(built)).not.toMatch(
      /inventoryValue|productId|branchId|supplierId|status/,
    );
  });

  it('refuses an obvious over-receipt using exact bigint comparison', () => {
    const built = buildPurchaseReceiptIntent(
      {
        order: ORDER,
        reference: '',
        products: [WEIGHTED],
        quantities: { 'line-1': '900719925474098.301' },
      },
      () => 'op',
    );
    expect(built).toMatchObject({ ok: false });
  });
});

describe('purchasing command failure classification', () => {
  it('keeps timeouts on the exact same operation and refreshes state conflicts', () => {
    expect(describePurchasingCommandFailure(new ApiError(0, 'timeout', null)).action).toBe(
      'retry-same',
    );
    expect(
      describePurchasingCommandFailure(new ApiError(409, 'over_receipt', 'تجاوز')).action,
    ).toBe('refresh-purchasing');
    expect(
      describePurchasingCommandFailure(new ApiError(409, 'idempotency_conflict', null)).action,
    ).toBe('blocking');
  });
});
