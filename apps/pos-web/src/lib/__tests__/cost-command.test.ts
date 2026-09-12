import { describe, expect, it } from 'vitest';
import {
  buildCostBootstrapIntent,
  costFlightOutcomeFor,
  describeCostCommandFailure,
} from '../cost-command';
import { ApiError } from '../api';
import type { InventoryCostBalanceRow } from '../api-types';

const ROW: InventoryCostBalanceRow = {
  branchId: 'branch-1',
  productId: 'product-1',
  sku: 'MILK-1L',
  nameAr: 'حليب',
  nameEn: 'Milk',
  productType: 'unit',
  unitLabel: 'حبة',
  isActive: true,
  trackInventory: true,
  quantityScaled: '9007199254740993000',
  knownQuantityScaled: '7000000000000000000',
  unknownPositiveQuantityScaled: '2007199254740993000',
  knownValueMinor: '900719925474099300',
  stockRevision: '12',
  costRevision: '8',
};

describe('cost command construction', () => {
  it('preserves exact integers and binds the decision to the displayed cost observation', () => {
    const built = buildCostBootstrapIntent(
      { branchId: ROW.branchId, product: ROW, totalValue: '90071992547409.93' },
      () => 'cost-op',
    );

    expect(built).toEqual({
      ok: true,
      intent: {
        kind: 'bootstrap',
        request: {
          operationId: 'cost-op',
          branchId: ROW.branchId,
          productId: ROW.productId,
          totalValueMinor: '9007199254740993',
          expectedStockRevision: '12',
          expectedCostRevision: '8',
          expectedUnknownPositiveQuantityScaled: '2007199254740993000',
        },
      },
    });
    expect(JSON.stringify(built)).not.toMatch(
      /knownQuantity|knownValue|valuedQuantity|tenant|actor|resultRevision|currentRevision/,
    );
  });

  it('keeps a stated zero as a legitimate known-zero valuation', () => {
    expect(
      buildCostBootstrapIntent(
        { branchId: ROW.branchId, product: ROW, totalValue: '0.00' },
        () => 'zero-op',
      ),
    ).toMatchObject({ ok: true, intent: { request: { totalValueMinor: '0' } } });
  });

  it('refuses an ineligible row or invalid value before minting an operation', () => {
    for (const input of [
      { product: { ...ROW, unknownPositiveQuantityScaled: '0' }, totalValue: '10.00' },
      { product: { ...ROW, isActive: false }, totalValue: '10.00' },
      { product: ROW, totalValue: '' },
      { product: ROW, totalValue: '1.001' },
      { product: ROW, totalValue: '92233720368547758.08' },
    ]) {
      let minted = false;
      const built = buildCostBootstrapIntent({ branchId: ROW.branchId, ...input }, () => {
        minted = true;
        return 'op';
      });
      expect(built.ok, input.totalValue).toBe(false);
      expect(minted, input.totalValue).toBe(false);
    }
  });
});

describe('cost command failure classification', () => {
  it('retries only ambiguous requests and refreshes changed valuation state', () => {
    expect(describeCostCommandFailure(new ApiError(0, 'timeout', null)).action).toBe('retry-same');
    expect(describeCostCommandFailure(new ApiError(409, 'nothing_to_value', null)).action).toBe(
      'refresh-cost',
    );
    expect(describeCostCommandFailure(new ApiError(409, 'cost_state_changed', null)).action).toBe(
      'refresh-cost',
    );
    expect(costFlightOutcomeFor('refresh-cost')).toBe('amendable');
    expect(describeCostCommandFailure(new ApiError(409, 'idempotency_conflict', null)).action).toBe(
      'blocking',
    );
    expect(describeCostCommandFailure(new ApiError(422, 'invalid_money', null)).action).toBe(
      'edit-command',
    );
  });
});
