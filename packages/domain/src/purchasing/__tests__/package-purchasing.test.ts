import { describe, expect, it } from 'vitest';
import { canonicalPurchaseOrderForm, validatePurchaseOrderRequest } from '../purchasing.js';

const SUPPLIER = '018f2b1a-0000-7000-8000-0000000005a1';
const BRANCH = '018f2b1a-0000-7000-8000-00000000b001';
const PRODUCT = '018f2b1a-0000-7000-8000-0000000000a1';
const PACKAGE = '018f2b1a-0000-7000-8000-00000000a901';

describe('V2-3 purchasing package intent', () => {
  it('preserves the exact legacy v1 form for base-unit orders', () => {
    expect(
      canonicalPurchaseOrderForm({
        operationId: 'legacy-retry-key',
        supplierId: SUPPLIER,
        branchId: BRANCH,
        reference: null,
        lines: [{ productId: PRODUCT, orderedQuantityScaled: '24000' }],
      }),
    ).toEqual([
      'purchasing-order-create.v1',
      SUPPLIER,
      BRANCH,
      null,
      [[PRODUCT, '24000']],
    ]);
  });

  it('uses v2 for package intent and binds package identity', () => {
    const packaged = canonicalPurchaseOrderForm({
      operationId: 'package-order',
      supplierId: SUPPLIER,
      branchId: BRANCH,
      reference: null,
      lines: [{ productId: PRODUCT, packageId: PACKAGE, orderedQuantityScaled: '2000' }],
    });
    expect(packaged).toEqual([
      'purchasing-order-create.v2',
      SUPPLIER,
      BRANCH,
      null,
      [[PRODUCT, PACKAGE, '2000']],
    ]);
    expect(JSON.stringify(packaged)).not.toBe(
      JSON.stringify(
        canonicalPurchaseOrderForm({
          operationId: 'package-order',
          supplierId: SUPPLIER,
          branchId: BRANCH,
          reference: null,
          lines: [{ productId: PRODUCT, orderedQuantityScaled: '2000' }],
        }),
      ),
    );
  });

  it('canonicalizes package UUID identity', () => {
    const validated = validatePurchaseOrderRequest({
      operationId: 'package-order',
      supplierId: SUPPLIER,
      branchId: BRANCH,
      reference: null,
      lines: [
        {
          productId: PRODUCT,
          packageId: PACKAGE.toUpperCase(),
          orderedQuantityScaled: '3000',
        },
      ],
    });
    expect(validated.lines).toEqual([
      { productId: PRODUCT, packageId: PACKAGE, orderedQuantityScaled: 3000n },
    ]);
  });
});
