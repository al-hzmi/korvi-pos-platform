import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import {
  buildInventoryCommandIntent,
  describeInventoryCommandFailure,
  inventoryFlightOutcomeFor,
} from '../inventory-command';
import type { InventoryBalanceRow } from '../api-types';

const ROW: InventoryBalanceRow = {
  branchId: 'branch-1',
  productId: 'product-1',
  sku: 'SKU-1',
  nameAr: 'صنف',
  nameEn: null,
  productType: 'unit',
  unitLabel: 'each',
  isActive: true,
  trackInventory: true,
  quantityScaled: '5000',
  revision: '9007199254740993',
};

describe('inventory command failures', () => {
  it('treats a timeout as ambiguous and permits only the same retry', () => {
    const failure = describeInventoryCommandFailure(new ApiError(0, 'timeout', null));
    expect(failure.action).toBe('retry-same');
    expect(inventoryFlightOutcomeFor(failure.action)).toBe('ambiguous');
    expect(failure.message).toContain('بنفس العملية');
  });

  it('requires fresh server stock after a stale count', () => {
    const failure = describeInventoryCommandFailure(
      new ApiError(409, 'stock_changed', 'تغيّر رصيد المخزون أثناء الجرد.'),
    );
    expect(failure).toMatchObject({ action: 'refresh-stock', code: 'stock_changed' });
    expect(inventoryFlightOutcomeFor(failure.action)).toBe('amendable');
  });

  it('refreshes rather than guessing after the locked source rejects stock', () => {
    const failure = describeInventoryCommandFailure(
      new ApiError(409, 'insufficient_stock', 'الكمية المتوفرة لا تكفي.'),
    );
    expect(failure).toEqual({
      code: 'insufficient_stock',
      message: 'الكمية المتوفرة لا تكفي.',
      action: 'refresh-stock',
    });
  });

  it('blocks a reused operation identity with different intent', () => {
    const failure = describeInventoryCommandFailure(
      new ApiError(409, 'idempotency_conflict', 'رقم العملية مستخدم لطلب مختلف.'),
    );
    expect(failure.action).toBe('blocking');
    expect(inventoryFlightOutcomeFor(failure.action)).toBe('blocked');
  });

  it('uses the server Arabic refusal without leaking transport details', () => {
    const failure = describeInventoryCommandFailure(
      new ApiError(422, 'fractional_unit_quantity', 'هذا الصنف يُباع بالعدد.'),
    );
    expect(failure).toEqual({
      code: 'fractional_unit_quantity',
      message: 'هذا الصنف يُباع بالعدد.',
      action: 'edit-command',
    });
  });
});

describe('inventory command drafts', () => {
  it('binds a zero shelf count to the exact revision that was displayed', () => {
    const result = buildInventoryCommandIntent(
      {
        kind: 'count',
        branchId: 'branch-1',
        destinationBranchId: null,
        product: ROW,
        quantity: '0',
        reason: '  جرد دوري  ',
      },
      () => 'count-op',
    );
    expect(result).toEqual({
      ok: true,
      intent: {
        kind: 'count',
        request: {
          operationId: 'count-op',
          branchId: 'branch-1',
          reason: 'جرد دوري',
          lines: [
            {
              productId: 'product-1',
              countedQuantityScaled: '0',
              expectedRevision: '9007199254740993',
            },
          ],
        },
      },
    });
  });

  it('refuses a transfer to its source and an unexplained adjustment', () => {
    expect(
      buildInventoryCommandIntent(
        {
          kind: 'transfer',
          branchId: 'branch-1',
          destinationBranchId: 'branch-1',
          product: ROW,
          quantity: '1',
          reason: '',
        },
        () => 'transfer-op',
      ),
    ).toMatchObject({ ok: false });
    expect(
      buildInventoryCommandIntent(
        {
          kind: 'adjustment',
          branchId: 'branch-1',
          destinationBranchId: null,
          product: ROW,
          quantity: '-1',
          reason: '   ',
        },
        () => 'adjust-op',
      ),
    ).toMatchObject({ ok: false });
  });
});
