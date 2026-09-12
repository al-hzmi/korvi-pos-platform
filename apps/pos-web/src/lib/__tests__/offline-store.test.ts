import { describe, expect, it } from 'vitest';
import {
  OfflineStoreError,
  classifyIndexedDbError,
  isOfflineSaleDraft,
  isProductSummary,
  offlineSaleScopeKey,
} from '../offline-store';

const PRODUCT = {
  id: '018f2000-0000-7000-8000-0000000000a1',
  sku: 'MILK-1L',
  nameAr: 'حليب',
  nameEn: 'Milk',
  productType: 'unit',
  unitLabel: 'حبة',
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000012',
  trackInventory: true,
} as const;

const SCOPE = {
  tenantId: '018f2000-0000-7000-8000-000000000001',
  branchId: '018f2000-0000-7000-8000-000000000002',
  terminalId: '018f2000-0000-7000-8000-000000000003',
  userId: '018f2000-0000-7000-8000-000000000004',
  shiftId: '018f2000-0000-7000-8000-000000000005',
} as const;

describe('offline store validation', () => {
  it('accepts exact string financial fields and refuses floating or corrupt catalogue values', () => {
    expect(isProductSummary(PRODUCT)).toBe(true);
    expect(isProductSummary({ ...PRODUCT, priceMinor: 11.5 })).toBe(false);
    expect(isProductSummary({ ...PRODUCT, vatBasisPoints: 1500.5 })).toBe(false);
    expect(isProductSummary({ ...PRODUCT, productType: 'other' })).toBe(false);
  });

  it('accepts a valid durable sale draft and rejects a floating quantity', () => {
    const draft = {
      lines: [
        {
          productId: PRODUCT.id,
          sku: PRODUCT.sku,
          nameAr: PRODUCT.nameAr,
          nameEn: PRODUCT.nameEn,
          productType: PRODUCT.productType,
          unitLabel: PRODUCT.unitLabel,
          unitPriceMinor: PRODUCT.priceMinor,
          vatBasisPoints: PRODUCT.vatBasisPoints,
          quantityScaled: '2000',
        },
      ],
      cash: '50.00',
      priceMode: 'inclusive',
      updatedAt: '2026-09-12T00:00:00.000Z',
    } as const;

    expect(isOfflineSaleDraft(draft)).toBe(true);
    expect(
      isOfflineSaleDraft({
        ...draft,
        lines: [{ ...draft.lines[0], quantityScaled: '2.5' }],
      }),
    ).toBe(false);
  });

  it('partitions drafts by every identity that defines a physical cashier sale context', () => {
    const key = offlineSaleScopeKey(SCOPE);
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, tenantId: `${SCOPE.tenantId}-other` }));
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, branchId: `${SCOPE.branchId}-other` }));
    expect(key).not.toBe(
      offlineSaleScopeKey({ ...SCOPE, terminalId: `${SCOPE.terminalId}-other` }),
    );
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, userId: `${SCOPE.userId}-other` }));
    expect(key).not.toBe(offlineSaleScopeKey({ ...SCOPE, shiftId: `${SCOPE.shiftId}-other` }));
  });

  it('classifies quota and version failures without hiding unknown transaction failures', () => {
    expect(classifyIndexedDbError(new DOMException('full', 'QuotaExceededError')).code).toBe(
      'quota',
    );
    expect(classifyIndexedDbError(new DOMException('old', 'VersionError')).code).toBe('version');
    expect(classifyIndexedDbError(new Error('boom')).code).toBe('transaction');
    expect(classifyIndexedDbError(new OfflineStoreError('corrupt', 'bad')).code).toBe('corrupt');
  });
});
