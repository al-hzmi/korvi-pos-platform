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

  it('builds an unvalued partial receipt without inventing cost authority', () => {
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

  it('keeps explicit valued receipt totals exact and distinguishes known zero from omission', () => {
    const secondLine = {
      ...ORDER.lines[0]!,
      id: 'line-2',
      productId: UNIT.id,
      orderedQuantityScaled: '2000',
      receivedQuantityScaled: '0',
      remainingQuantityScaled: '2000',
    };
    const order = { ...ORDER, lines: [ORDER.lines[0]!, secondLine] };
    const built = buildPurchaseReceiptIntent(
      {
        order,
        reference: '',
        products: [WEIGHTED, UNIT],
        quantities: { 'line-1': '2.125', 'line-2': '1' },
        inventoryValues: {
          'line-1': { enabled: true, value: '90071992547409.93' },
          'line-2': { enabled: true, value: '0.00' },
        },
      },
      () => 'op-valued-receipt',
    );

    expect(built).toEqual({
      ok: true,
      intent: {
        kind: 'receipt',
        request: {
          operationId: 'op-valued-receipt',
          purchaseOrderId: ORDER.id,
          reference: null,
          lines: [
            {
              purchaseOrderLineId: 'line-1',
              acceptedQuantityScaled: '2125',
              inventoryValueMinor: '9007199254740993',
            },
            {
              purchaseOrderLineId: 'line-2',
              acceptedQuantityScaled: '1000',
              inventoryValueMinor: '0',
            },
          ],
        },
      },
    });
    expect(BigInt('9007199254740993')).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('omits a disabled value and refuses enabled value without a receipt quantity', () => {
    const omitted = buildPurchaseReceiptIntent(
      {
        order: ORDER,
        reference: '',
        products: [WEIGHTED],
        quantities: { 'line-1': '1' },
        inventoryValues: { 'line-1': { enabled: false, value: '77.00' } },
      },
      () => 'op-unknown',
    );
    expect(JSON.stringify(omitted)).not.toContain('inventoryValueMinor');

    let minted = false;
    const invalid = buildPurchaseReceiptIntent(
      {
        order: ORDER,
        reference: '',
        products: [WEIGHTED],
        quantities: {},
        inventoryValues: { 'line-1': { enabled: true, value: '10.00' } },
      },
      () => {
        minted = true;
        return 'op';
      },
    );
    expect(invalid).toMatchObject({ ok: false });
    expect(minted).toBe(false);
  });

  it('refuses malformed or over-precise acquisition value before minting an operation', () => {
    for (const value of ['', '1.001', '1e3', '-1', '9,00']) {
      let minted = false;
      const built = buildPurchaseReceiptIntent(
        {
          order: ORDER,
          reference: '',
          products: [WEIGHTED],
          quantities: { 'line-1': '1' },
          inventoryValues: { 'line-1': { enabled: true, value } },
        },
        () => {
          minted = true;
          return 'op';
        },
      );
      expect(built.ok, value).toBe(false);
      expect(minted, value).toBe(false);
    }
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
