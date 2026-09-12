import { describe, expect, it } from 'vitest';
import {
  MAX_STOCK_LINES,
  StockRequestError,
  assertQuantityShape,
  canonicalAdjustmentForm,
  canonicalCountForm,
  canonicalTransferForm,
  canonicalUuid,
  isWholeUnitScaled,
  parseRevision,
  parseSignedScaled,
  validateAdjustmentRequest,
  validateCountRequest,
  validateTransferRequest,
} from '../stock.js';
import type { AdjustmentRequest, CountRequest, TransferRequest } from '../stock.js';

const PRODUCT_A = '018f2b1a-0000-7000-8000-0000000000a1';
const PRODUCT_B = '018f2b1a-0000-7000-8000-0000000000b2';
const BRANCH_A = '018f2b1a-0000-7000-8000-00000000b001';
const BRANCH_B = '018f2b1a-0000-7000-8000-00000000b002';

function adjustment(over: Partial<AdjustmentRequest> = {}): AdjustmentRequest {
  return {
    operationId: 'op-1',
    branchId: BRANCH_A,
    reason: 'تلف',
    lines: [{ productId: PRODUCT_A, deltaQuantityScaled: '-2000' }],
    ...over,
  };
}

function count(over: Partial<CountRequest> = {}): CountRequest {
  return {
    operationId: 'op-1',
    branchId: BRANCH_A,
    reason: null,
    lines: [{ productId: PRODUCT_A, countedQuantityScaled: '4000', expectedRevision: '3' }],
    ...over,
  };
}

function transfer(over: Partial<TransferRequest> = {}): TransferRequest {
  return {
    operationId: 'op-1',
    fromBranchId: BRANCH_A,
    toBranchId: BRANCH_B,
    reason: null,
    lines: [{ productId: PRODUCT_A, quantityScaled: '1000' }],
    ...over,
  };
}

function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof StockRequestError) return error.detail;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
}

describe('scaled quantity parsing', () => {
  it('accepts signed integer text and refuses everything that is not', () => {
    expect(parseSignedScaled('0', 'q')).toBe(0n);
    expect(parseSignedScaled('-2000', 'q')).toBe(-2000n);
    expect(parseSignedScaled('123456789012345678', 'q')).toBe(123456789012345678n);

    // Each of these is a way a float or a sloppy client would arrive.
    for (const bad of ['1.5', '2e3', '', ' 1', '1 ', '+1', '007', '-0', 'NaN', 'Infinity']) {
      expect(
        refusalOf(() => parseSignedScaled(bad, 'q')),
        bad,
      ).toBe('invalid-quantity');
    }
  });

  it('keeps precision a JSON number would have lost', () => {
    // Beyond 2^53. Parsed as text into a bigint, so it survives exactly; a
    // Number round-trip would not have.
    const huge = '9007199254740993';
    expect(parseSignedScaled(huge, 'q').toString()).toBe(huge);
    expect(Number(huge).toString()).not.toBe(huge);
  });

  it('treats revision as an unsigned counter', () => {
    expect(parseRevision('0')).toBe(0n);
    for (const bad of ['-1', '1.0', '', 'x']) {
      expect(
        refusalOf(() => parseRevision(bad)),
        bad,
      ).toBe('invalid-revision');
    }
  });
});

describe('unit and weighted quantity rules', () => {
  it('measures wholeness against the fixed 1000 scale', () => {
    expect(isWholeUnitScaled(2000n)).toBe(true);
    expect(isWholeUnitScaled(-2000n)).toBe(true);
    expect(isWholeUnitScaled(1500n)).toBe(false);
  });

  it('refuses a fraction of a unit product and allows one for a weighted product', () => {
    expect(refusalOf(() => assertQuantityShape(1500n, 'unit', 'q'))).toBe(
      'fractional-unit-quantity',
    );
    expect(() => assertQuantityShape(2000n, 'unit', 'q')).not.toThrow();
    // 1.5 kg is a real weight, and the scale is the only precision allowed.
    expect(() => assertQuantityShape(1500n, 'weighted', 'q')).not.toThrow();
  });
});

describe('adjustment requests', () => {
  it('accepts a signed delta and refuses a zero one', () => {
    expect(validateAdjustmentRequest(adjustment()).lines).toEqual([
      { productId: PRODUCT_A, deltaQuantityScaled: -2000n },
    ]);
    expect(
      refusalOf(() =>
        validateAdjustmentRequest(
          adjustment({ lines: [{ productId: PRODUCT_A, deltaQuantityScaled: '0' }] }),
        ),
      ),
    ).toBe('zero-delta');
  });

  it('requires a bounded reason', () => {
    expect(refusalOf(() => validateAdjustmentRequest(adjustment({ reason: '   ' })))).toBe(
      'invalid-reason',
    );
    expect(
      refusalOf(() => validateAdjustmentRequest(adjustment({ reason: 'x'.repeat(201) }))),
    ).toBe('invalid-reason');
  });

  it('refuses two lines for the same product', () => {
    expect(
      refusalOf(() =>
        validateAdjustmentRequest(
          adjustment({
            lines: [
              { productId: PRODUCT_A, deltaQuantityScaled: '1000' },
              { productId: PRODUCT_A, deltaQuantityScaled: '-1000' },
            ],
          }),
        ),
      ),
    ).toBe('duplicate-product');
  });

  it('bounds the line count in both directions', () => {
    expect(refusalOf(() => validateAdjustmentRequest(adjustment({ lines: [] })))).toBe('no-lines');
    const many = Array.from({ length: MAX_STOCK_LINES + 1 }, (_, index) => ({
      productId: `018f2b1a-0000-7000-8000-${index.toString().padStart(12, '0')}`,
      deltaQuantityScaled: '1000',
    }));
    expect(refusalOf(() => validateAdjustmentRequest(adjustment({ lines: many })))).toBe(
      'too-many-lines',
    );
  });
});

describe('count requests', () => {
  it('accepts an absolute observation and a revision', () => {
    expect(validateCountRequest(count()).lines).toEqual([
      { productId: PRODUCT_A, countedQuantityScaled: 4000n, expectedRevision: 3n },
    ]);
  });

  it('refuses a negative observation', () => {
    // You cannot see less than nothing on a shelf, and this is the one path
    // where the client does not get to state a delta.
    expect(
      refusalOf(() =>
        validateCountRequest(
          count({
            lines: [{ productId: PRODUCT_A, countedQuantityScaled: '-1', expectedRevision: '0' }],
          }),
        ),
      ),
    ).toBe('negative-count');
  });

  it('accepts a zero observation, which is a real thing to find', () => {
    expect(
      validateCountRequest(
        count({
          lines: [{ productId: PRODUCT_A, countedQuantityScaled: '0', expectedRevision: '7' }],
        }),
      ).lines,
    ).toEqual([{ productId: PRODUCT_A, countedQuantityScaled: 0n, expectedRevision: 7n }]);
  });
});

describe('transfer requests', () => {
  it('refuses a transfer to the same branch', () => {
    expect(refusalOf(() => validateTransferRequest(transfer({ toBranchId: BRANCH_A })))).toBe(
      'same-branch',
    );
  });

  it('refuses a non-positive quantity, because direction is the branch pair', () => {
    for (const bad of ['0', '-1000']) {
      expect(
        refusalOf(() =>
          validateTransferRequest(
            transfer({ lines: [{ productId: PRODUCT_A, quantityScaled: bad }] }),
          ),
        ),
        bad,
      ).toBe('non-positive-quantity');
    }
  });
});

/**
 * UUID identity is the row, not the spelling.
 *
 * PostgreSQL accepts either casing and stores one identity, so `018F…A8` and
 * `018f…a8` are the same product. Every comparison Strike 5A makes — duplicate
 * detection, same-branch, ordering, fingerprints — must agree with that, or a
 * merchant gets a database error where a typed refusal was promised, and a
 * lawful retry gets a conflict where a replay was promised.
 */
describe('UUID identity is case-insensitive', () => {
  const UPPER_A = PRODUCT_A.toUpperCase();
  const UPPER_BRANCH_A = BRANCH_A.toUpperCase();

  it('canonicalizes to lowercase and refuses anything that is not a UUID', () => {
    expect(canonicalUuid(UPPER_A, 'productId')).toBe(PRODUCT_A);
    expect(canonicalUuid(`  ${UPPER_A}  `, 'productId')).toBe(PRODUCT_A);
    for (const bad of ['', 'not-a-uuid', PRODUCT_A.slice(0, -1), `${PRODUCT_A}x`]) {
      expect(
        refusalOf(() => canonicalUuid(bad, 'productId')),
        bad,
      ).toBe('invalid-uuid');
    }
  });

  it('A. catches one product spelled two ways as a duplicate', () => {
    // Without canonical identity this reaches the unique index instead, and the
    // merchant is shown a database failure rather than "this product is listed
    // twice".
    expect(
      refusalOf(() =>
        validateAdjustmentRequest(
          adjustment({
            lines: [
              { productId: PRODUCT_A, deltaQuantityScaled: '1000' },
              { productId: UPPER_A, deltaQuantityScaled: '-1000' },
            ],
          }),
        ),
      ),
    ).toBe('duplicate-product');
  });

  it('B. catches one branch spelled two ways as the same branch', () => {
    // Otherwise this reaches the table CHECK rather than the typed refusal.
    expect(
      refusalOf(() =>
        validateTransferRequest(transfer({ fromBranchId: BRANCH_A, toBranchId: UPPER_BRANCH_A })),
      ),
    ).toBe('same-branch');
  });

  it('C/D/E. produces identical canonical forms when only casing differs', () => {
    expect(JSON.stringify(canonicalAdjustmentForm(adjustment()))).toBe(
      JSON.stringify(
        canonicalAdjustmentForm(
          adjustment({
            branchId: UPPER_BRANCH_A,
            lines: [{ productId: UPPER_A, deltaQuantityScaled: '-2000' }],
          }),
        ),
      ),
    );

    expect(JSON.stringify(canonicalCountForm(count()))).toBe(
      JSON.stringify(
        canonicalCountForm(
          count({
            branchId: UPPER_BRANCH_A,
            lines: [{ productId: UPPER_A, countedQuantityScaled: '4000', expectedRevision: '3' }],
          }),
        ),
      ),
    );

    expect(JSON.stringify(canonicalTransferForm(transfer()))).toBe(
      JSON.stringify(
        canonicalTransferForm(
          transfer({
            fromBranchId: UPPER_BRANCH_A,
            toBranchId: BRANCH_B.toUpperCase(),
            lines: [{ productId: UPPER_A, quantityScaled: '1000' }],
          }),
        ),
      ),
    );
  });

  it('F. orders and returns lines by canonical product identity', () => {
    // PRODUCT_B uppercase sorts before PRODUCT_A lowercase as raw text, because
    // capitals precede lowercase in ASCII. Canonical identity is what decides
    // the order, so the result must not depend on how the caller typed it.
    const plan = validateAdjustmentRequest(
      adjustment({
        lines: [
          { productId: PRODUCT_B.toUpperCase(), deltaQuantityScaled: '-500' },
          { productId: PRODUCT_A, deltaQuantityScaled: '1000' },
        ],
      }),
    );
    expect(plan.lines.map((line) => line.productId)).toEqual([PRODUCT_A, PRODUCT_B]);
    // And every id the authority will consume is already canonical.
    expect(plan.branchId).toBe(BRANCH_A);
  });

  it('canonicalizes the branch and both transfer branches on the plan', () => {
    const plan = validateTransferRequest(
      transfer({
        fromBranchId: UPPER_BRANCH_A,
        toBranchId: BRANCH_B.toUpperCase(),
        lines: [{ productId: UPPER_A, quantityScaled: '1000' }],
      }),
    );
    expect(plan.fromBranchId).toBe(BRANCH_A);
    expect(plan.toBranchId).toBe(BRANCH_B);
    expect(plan.lines[0]?.productId).toBe(PRODUCT_A);

    const counted = validateCountRequest(count({ branchId: UPPER_BRANCH_A }));
    expect(counted.branchId).toBe(BRANCH_A);
  });
});

/**
 * The canonical form is what decides replay versus conflict, so it has to be
 * blind to everything that does not change the intent and sensitive to
 * everything that does.
 */
describe('canonical request form', () => {
  it('is stable across line order', () => {
    const ascending = adjustment({
      lines: [
        { productId: PRODUCT_A, deltaQuantityScaled: '1000' },
        { productId: PRODUCT_B, deltaQuantityScaled: '-500' },
      ],
    });
    const descending = adjustment({
      lines: [
        { productId: PRODUCT_B, deltaQuantityScaled: '-500' },
        { productId: PRODUCT_A, deltaQuantityScaled: '1000' },
      ],
    });
    expect(JSON.stringify(canonicalAdjustmentForm(ascending))).toBe(
      JSON.stringify(canonicalAdjustmentForm(descending)),
    );
  });

  it('is stable across JSON property order', () => {
    // Two objects with the same fields written in a different source order.
    const one = { productId: PRODUCT_A, deltaQuantityScaled: '1000' };
    const two = { deltaQuantityScaled: '1000', productId: PRODUCT_A };
    expect(JSON.stringify(canonicalAdjustmentForm(adjustment({ lines: [one] })))).toBe(
      JSON.stringify(canonicalAdjustmentForm(adjustment({ lines: [two] }))),
    );
  });

  it('ignores whitespace around a reason but not the reason itself', () => {
    expect(JSON.stringify(canonicalAdjustmentForm(adjustment({ reason: '  تلف  ' })))).toBe(
      JSON.stringify(canonicalAdjustmentForm(adjustment({ reason: 'تلف' }))),
    );
    expect(JSON.stringify(canonicalAdjustmentForm(adjustment({ reason: 'سرقة' })))).not.toBe(
      JSON.stringify(canonicalAdjustmentForm(adjustment({ reason: 'تلف' }))),
    );
  });

  it('changes when the intent changes', () => {
    const base = JSON.stringify(canonicalAdjustmentForm(adjustment()));
    const changes = [
      adjustment({ branchId: BRANCH_B }),
      adjustment({ lines: [{ productId: PRODUCT_B, deltaQuantityScaled: '-2000' }] }),
      adjustment({ lines: [{ productId: PRODUCT_A, deltaQuantityScaled: '-3000' }] }),
      // A sign flip is a different operation, not a retry.
      adjustment({ lines: [{ productId: PRODUCT_A, deltaQuantityScaled: '2000' }] }),
    ];
    for (const changed of changes) {
      expect(JSON.stringify(canonicalAdjustmentForm(changed))).not.toBe(base);
    }
  });

  it('does not depend on the operation id, which is the key rather than the intent', () => {
    expect(JSON.stringify(canonicalAdjustmentForm(adjustment({ operationId: 'other' })))).toBe(
      JSON.stringify(canonicalAdjustmentForm(adjustment())),
    );
  });

  it('binds the counted revision, so a recount of a moved shelf is a new intent', () => {
    const first = canonicalCountForm(count());
    const later = canonicalCountForm(
      count({
        lines: [{ productId: PRODUCT_A, countedQuantityScaled: '4000', expectedRevision: '4' }],
      }),
    );
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(later));
  });

  it('binds transfer direction, so a reversed transfer is a different intent', () => {
    const forward = canonicalTransferForm(transfer());
    const backward = canonicalTransferForm(
      transfer({ fromBranchId: BRANCH_B, toBranchId: BRANCH_A }),
    );
    expect(JSON.stringify(forward)).not.toBe(JSON.stringify(backward));
  });

  it('treats an empty reason and no reason as the same absence', () => {
    expect(JSON.stringify(canonicalTransferForm(transfer({ reason: '   ' })))).toBe(
      JSON.stringify(canonicalTransferForm(transfer({ reason: null }))),
    );
  });
});
