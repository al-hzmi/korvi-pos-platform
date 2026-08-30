import { describe, expect, it } from 'vitest';
import {
  MAX_PURCHASING_LINES,
  MAX_PURCHASING_REFERENCE,
  MAX_SUPPLIER_NAME,
  PURCHASING_MOVEMENT_KIND,
  PurchasingRequestError,
  assertPurchasingQuantityShape,
  canonicalPurchaseOrderForm,
  canonicalPurchaseReceiptForm,
  canonicalSupplierCreateForm,
  canonicalSupplierUpdateForm,
  derivePurchaseOrderStatus,
  parsePositiveScaled,
  remainingQuantityScaled,
  validatePurchaseOrderRequest,
  validatePurchaseReceiptRequest,
  validateSupplierCreate,
  validateSupplierUpdate,
} from '../purchasing.js';
import type { PurchaseOrderRequest, PurchaseReceiptRequest } from '../purchasing.js';

const SUPPLIER = '018f2b1a-0000-7000-8000-0000000005a1';
const BRANCH = '018f2b1a-0000-7000-8000-00000000b001';
const PRODUCT_A = '018f2b1a-0000-7000-8000-0000000000a1';
const PRODUCT_B = '018f2b1a-0000-7000-8000-0000000000b2';
const PO = '018f2b1a-0000-7000-8000-00000000d001';
const LINE_A = '018f2b1a-0000-7000-8000-00000000c001';
const LINE_B = '018f2b1a-0000-7000-8000-00000000c002';

function order(over: Partial<PurchaseOrderRequest> = {}): PurchaseOrderRequest {
  return {
    operationId: 'op-1',
    supplierId: SUPPLIER,
    branchId: BRANCH,
    reference: null,
    lines: [{ productId: PRODUCT_A, orderedQuantityScaled: '100000' }],
    ...over,
  };
}

function receipt(over: Partial<PurchaseReceiptRequest> = {}): PurchaseReceiptRequest {
  return {
    operationId: 'op-1',
    purchaseOrderId: PO,
    reference: null,
    lines: [{ purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '30000' }],
    ...over,
  };
}

function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof PurchasingRequestError) return error.detail;
    throw error;
  }
  throw new Error('Expected the request to be refused.');
}

describe('purchasing quantities', () => {
  it('parses an exact scaled integer without going through a float', () => {
    expect(parsePositiveScaled('100000', 'q')).toBe(100_000n);
    // Beyond 2^53: the value a Number would silently round is preserved here.
    expect(parsePositiveScaled('9007199254740993', 'q')).toBe(9_007_199_254_740_993n);
  });

  it('refuses zero, negatives and anything that is not canonical integer text', () => {
    expect(refusalOf(() => parsePositiveScaled('0', 'q'))).toBe('non-positive-quantity');
    expect(refusalOf(() => parsePositiveScaled('-1000', 'q'))).toBe('non-positive-quantity');
    expect(refusalOf(() => parsePositiveScaled('1.5', 'q'))).toBe('invalid-quantity');
    expect(refusalOf(() => parsePositiveScaled('1e3', 'q'))).toBe('invalid-quantity');
    expect(refusalOf(() => parsePositiveScaled('007', 'q'))).toBe('invalid-quantity');
    expect(refusalOf(() => parsePositiveScaled(' 1000', 'q'))).toBe('invalid-quantity');
  });

  it('holds a unit product to whole units and lets a weighted one be fractional', () => {
    expect(() => {
      assertPurchasingQuantityShape(2_000n, 'unit', 'q');
    }).not.toThrow();
    expect(
      refusalOf(() => {
        assertPurchasingQuantityShape(2_500n, 'unit', 'q');
      }),
    ).toBe('fractional-unit-quantity');
    expect(() => {
      assertPurchasingQuantityShape(2_500n, 'weighted', 'q');
    }).not.toThrow();
  });
});

describe('supplier requests', () => {
  it('trims the name and refuses an empty or over-long one', () => {
    expect(validateSupplierCreate({ operationId: 'op', name: '  مؤسسة الرياض  ' })).toEqual({
      name: 'مؤسسة الرياض',
    });
    expect(refusalOf(() => validateSupplierCreate({ operationId: 'op', name: '   ' }))).toBe(
      'invalid-name',
    );
    expect(
      refusalOf(() =>
        validateSupplierCreate({ operationId: 'op', name: 'x'.repeat(MAX_SUPPLIER_NAME + 1) }),
      ),
    ).toBe('invalid-name');
  });

  it('keeps a false isActive distinct from an unstated one', () => {
    expect(
      validateSupplierUpdate({ operationId: 'op', supplierId: SUPPLIER, isActive: false }),
    ).toEqual({ supplierId: SUPPLIER, name: undefined, isActive: false });
    expect(validateSupplierUpdate({ operationId: 'op', supplierId: SUPPLIER, name: 'A' })).toEqual({
      supplierId: SUPPLIER,
      name: 'A',
      isActive: undefined,
    });
  });

  it('refuses an update that changes nothing', () => {
    expect(
      refusalOf(() => validateSupplierUpdate({ operationId: 'op', supplierId: SUPPLIER })),
    ).toBe('invalid-name');
  });

  it('canonicalizes the supplier id and refuses a non-UUID', () => {
    expect(
      validateSupplierUpdate({
        operationId: 'op',
        supplierId: SUPPLIER.toUpperCase(),
        isActive: true,
      }).supplierId,
    ).toBe(SUPPLIER);
    expect(
      refusalOf(() =>
        validateSupplierUpdate({ operationId: 'op', supplierId: 'not-a-uuid', isActive: true }),
      ),
    ).toBe('invalid-uuid');
  });
});

describe('purchase order requests', () => {
  it('canonicalizes every identity and sorts lines by product', () => {
    const validated = validatePurchaseOrderRequest(
      order({
        supplierId: SUPPLIER.toUpperCase(),
        branchId: ` ${BRANCH.toUpperCase()} `,
        lines: [
          { productId: PRODUCT_B, orderedQuantityScaled: '2000' },
          { productId: PRODUCT_A, orderedQuantityScaled: '1000' },
        ],
      }),
    );
    expect(validated.supplierId).toBe(SUPPLIER);
    expect(validated.branchId).toBe(BRANCH);
    expect(validated.lines.map((line) => line.productId)).toEqual([PRODUCT_A, PRODUCT_B]);
    expect(validated.lines.map((line) => line.orderedQuantityScaled)).toEqual([1_000n, 2_000n]);
  });

  it('treats two spellings of one product id as one product', () => {
    expect(
      refusalOf(() =>
        validatePurchaseOrderRequest(
          order({
            lines: [
              { productId: PRODUCT_A, orderedQuantityScaled: '1000' },
              { productId: PRODUCT_A.toUpperCase(), orderedQuantityScaled: '2000' },
            ],
          }),
        ),
      ),
    ).toBe('duplicate-product');
  });

  it('refuses an empty or over-long line set', () => {
    expect(refusalOf(() => validatePurchaseOrderRequest(order({ lines: [] })))).toBe('no-lines');
    const many = Array.from({ length: MAX_PURCHASING_LINES + 1 }, (_unused, index) => ({
      productId: `018f2b1a-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
      orderedQuantityScaled: '1000',
    }));
    expect(refusalOf(() => validatePurchaseOrderRequest(order({ lines: many })))).toBe(
      'too-many-lines',
    );
  });

  it('normalizes a blank reference to null and refuses an over-long one', () => {
    expect(validatePurchaseOrderRequest(order({ reference: '   ' })).reference).toBeNull();
    expect(validatePurchaseOrderRequest(order({ reference: ' PO-77 ' })).reference).toBe('PO-77');
    expect(
      refusalOf(() =>
        validatePurchaseOrderRequest(
          order({ reference: 'x'.repeat(MAX_PURCHASING_REFERENCE + 1) }),
        ),
      ),
    ).toBe('invalid-reference');
  });

  it('refuses an ordered quantity of zero', () => {
    expect(
      refusalOf(() =>
        validatePurchaseOrderRequest(
          order({ lines: [{ productId: PRODUCT_A, orderedQuantityScaled: '0' }] }),
        ),
      ),
    ).toBe('non-positive-quantity');
  });
});

describe('purchase order status', () => {
  it('is open until something is received', () => {
    expect(
      derivePurchaseOrderStatus([
        { orderedQuantityScaled: 100n, receivedQuantityScaled: 0n },
        { orderedQuantityScaled: 50n, receivedQuantityScaled: 0n },
      ]),
    ).toBe('open');
  });

  it('is partially received when any line has some but not all', () => {
    expect(
      derivePurchaseOrderStatus([
        { orderedQuantityScaled: 100n, receivedQuantityScaled: 100n },
        { orderedQuantityScaled: 50n, receivedQuantityScaled: 0n },
      ]),
    ).toBe('partially_received');
    expect(
      derivePurchaseOrderStatus([{ orderedQuantityScaled: 100n, receivedQuantityScaled: 1n }]),
    ).toBe('partially_received');
  });

  it('is received only when every line is complete', () => {
    expect(
      derivePurchaseOrderStatus([
        { orderedQuantityScaled: 100n, receivedQuantityScaled: 100n },
        { orderedQuantityScaled: 50n, receivedQuantityScaled: 50n },
      ]),
    ).toBe('received');
  });

  it('computes the remaining quantity exactly', () => {
    expect(
      remainingQuantityScaled({ orderedQuantityScaled: 10_000n, receivedQuantityScaled: 6_000n }),
    ).toBe(4_000n);
    expect(
      remainingQuantityScaled({
        orderedQuantityScaled: 10_000n,
        receivedQuantityScaled: 10_000n,
      }),
    ).toBe(0n);
  });
});

describe('purchase receipt requests', () => {
  it('sorts lines by purchase-order line id so request order cannot change intent', () => {
    const validated = validatePurchaseReceiptRequest(
      receipt({
        lines: [
          { purchaseOrderLineId: LINE_B, acceptedQuantityScaled: '2000' },
          { purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '1000' },
        ],
      }),
    );
    expect(validated.lines.map((line) => line.purchaseOrderLineId)).toEqual([LINE_A, LINE_B]);
  });

  it('refuses two lines against one purchase-order line, whatever the casing', () => {
    expect(
      refusalOf(() =>
        validatePurchaseReceiptRequest(
          receipt({
            lines: [
              { purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '1000' },
              { purchaseOrderLineId: LINE_A.toUpperCase(), acceptedQuantityScaled: '1000' },
            ],
          }),
        ),
      ),
    ).toBe('duplicate-order-line');
  });

  it('refuses a zero or negative accepted quantity', () => {
    expect(
      refusalOf(() =>
        validatePurchaseReceiptRequest(
          receipt({ lines: [{ purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '0' }] }),
        ),
      ),
    ).toBe('non-positive-quantity');
    expect(
      refusalOf(() =>
        validatePurchaseReceiptRequest(
          receipt({ lines: [{ purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '-1000' }] }),
        ),
      ),
    ).toBe('non-positive-quantity');
  });
});

describe('canonical request forms', () => {
  it('are stable across line order', () => {
    const forward = canonicalPurchaseOrderForm(
      order({
        lines: [
          { productId: PRODUCT_A, orderedQuantityScaled: '1000' },
          { productId: PRODUCT_B, orderedQuantityScaled: '2000' },
        ],
      }),
    );
    const reversed = canonicalPurchaseOrderForm(
      order({
        lines: [
          { productId: PRODUCT_B, orderedQuantityScaled: '2000' },
          { productId: PRODUCT_A, orderedQuantityScaled: '1000' },
        ],
      }),
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));

    const receiptForward = canonicalPurchaseReceiptForm(
      receipt({
        lines: [
          { purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '1000' },
          { purchaseOrderLineId: LINE_B, acceptedQuantityScaled: '2000' },
        ],
      }),
    );
    const receiptReversed = canonicalPurchaseReceiptForm(
      receipt({
        lines: [
          { purchaseOrderLineId: LINE_B, acceptedQuantityScaled: '2000' },
          { purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '1000' },
        ],
      }),
    );
    expect(JSON.stringify(receiptForward)).toBe(JSON.stringify(receiptReversed));
  });

  it('are stable across UUID casing and reference whitespace', () => {
    expect(JSON.stringify(canonicalPurchaseOrderForm(order()))).toBe(
      JSON.stringify(
        canonicalPurchaseOrderForm(
          order({
            supplierId: SUPPLIER.toUpperCase(),
            branchId: BRANCH.toUpperCase(),
            reference: '  ',
            lines: [{ productId: PRODUCT_A.toUpperCase(), orderedQuantityScaled: '100000' }],
          }),
        ),
      ),
    );
  });

  it('are not stable across a changed quantity', () => {
    expect(JSON.stringify(canonicalPurchaseOrderForm(order()))).not.toBe(
      JSON.stringify(
        canonicalPurchaseOrderForm(
          order({ lines: [{ productId: PRODUCT_A, orderedQuantityScaled: '100001' }] }),
        ),
      ),
    );
    expect(JSON.stringify(canonicalPurchaseReceiptForm(receipt()))).not.toBe(
      JSON.stringify(
        canonicalPurchaseReceiptForm(
          receipt({ lines: [{ purchaseOrderLineId: LINE_A, acceptedQuantityScaled: '30001' }] }),
        ),
      ),
    );
  });

  it('ignores the operation id, which is the key rather than the intent', () => {
    expect(JSON.stringify(canonicalPurchaseOrderForm(order({ operationId: 'op-1' })))).toBe(
      JSON.stringify(canonicalPurchaseOrderForm(order({ operationId: 'op-2' }))),
    );
  });

  it('tells a name-only update apart from an active-state-only update', () => {
    const nameOnly = canonicalSupplierUpdateForm({
      operationId: 'op',
      supplierId: SUPPLIER,
      name: 'A',
    });
    const activeOnly = canonicalSupplierUpdateForm({
      operationId: 'op',
      supplierId: SUPPLIER,
      isActive: true,
    });
    expect(JSON.stringify(nameOnly)).not.toBe(JSON.stringify(activeOnly));
  });

  it('normalizes a supplier name the same way the validator does', () => {
    expect(JSON.stringify(canonicalSupplierCreateForm({ operationId: 'op', name: ' A ' }))).toBe(
      JSON.stringify(canonicalSupplierCreateForm({ operationId: 'x', name: 'A' })),
    );
  });
});

describe('ledger vocabulary', () => {
  it('reuses the ledger kind that already means "goods arrived"', () => {
    // The saas-foundation CHECK constraint has permitted 'receipt' since the
    // first migration, so receiving needs no widening of historical vocabulary
    // and overloads nothing (§13).
    expect(PURCHASING_MOVEMENT_KIND).toBe('receipt');
  });
});
