import { describe, expect, it } from 'vitest';
import {
  CostingCapacityError,
  CostingRequestError,
  allocateOriginalSaleReturnBasis,
  applyKnownInflowAgainstDeficit,
  assertPoolFitsStock,
  bootstrapUnknownCost,
  canonicalCostBootstrapForm,
  consumeKnownCost,
  consumeOutflowUnknownFirst,
  incrementalAllocatedValue,
  parseNonNegativeMinor,
  prefixAllocatedValue,
} from '../costing.js';

function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CostingRequestError) return error.detail;
    throw error;
  }
  throw new Error('expected a costing refusal, and the call succeeded');
}

describe('costing request boundaries', () => {
  it('accepts exact non-negative minor-unit text and rejects float-like input', () => {
    expect(parseNonNegativeMinor('0', 'value')).toBe(0n);
    expect(parseNonNegativeMinor('9007199254740993', 'value')).toBe(9007199254740993n);
    for (const bad of ['-1', '01', '1.0', '1e3', '+1', '', ' 1', '1 ', 'NaN']) {
      expect(
        refusalOf(() => parseNonNegativeMinor(bad, 'value')),
        bad,
      ).toBe('invalid-money');
    }
  });

  it('accepts the PostgreSQL BIGINT maximum and refuses values beyond PostgreSQL BIGINT', () => {
    expect(parseNonNegativeMinor('9223372036854775807', 'value')).toBe(9_223_372_036_854_775_807n);
    expect(refusalOf(() => parseNonNegativeMinor('9223372036854775808', 'value'))).toBe(
      'invalid-money',
    );
  });
});

describe('integer value conservation', () => {
  it('allocates 100 across three equal units as 33 + 33 + 34 exactly', () => {
    expect(incrementalAllocatedValue(100n, 3000n, 0n, 1000n)).toBe(33n);
    expect(incrementalAllocatedValue(100n, 3000n, 1000n, 2000n)).toBe(33n);
    expect(incrementalAllocatedValue(100n, 3000n, 2000n, 3000n)).toBe(34n);
    expect(prefixAllocatedValue(100n, 3000n, 3000n)).toBe(100n);
  });

  it('leaves no residual when the final known quantity is consumed', () => {
    const first = consumeKnownCost({ knownQuantityScaled: 3000n, knownValueMinor: 100n }, 1000n);
    expect(first.consumedKnownValueMinor).toBe(33n);
    const second = consumeKnownCost(first, 1000n);
    expect(second.consumedKnownValueMinor).toBe(33n);
    const final = consumeKnownCost(second, 1000n);
    expect(final.consumedKnownValueMinor).toBe(34n);
    expect(final.knownQuantityScaled).toBe(0n);
    expect(final.knownValueMinor).toBe(0n);
  });
});

describe('unknown-first outflow', () => {
  it('consumes historical unknown stock before recorded-cost stock', () => {
    const result = consumeOutflowUnknownFirst(
      5000n,
      { knownQuantityScaled: 3000n, knownValueMinor: 120n },
      3000n,
    );
    expect(result.unknownQuantityConsumedScaled).toBe(2000n);
    expect(result.knownQuantityConsumedScaled).toBe(1000n);
    expect(result.knownValueConsumedMinor).toBe(40n);
    expect(result.knownQuantityScaled).toBe(2000n);
    expect(result.knownValueMinor).toBe(80n);
  });

  it('marks permitted oversell quantity unknown instead of fabricating cost', () => {
    const result = consumeOutflowUnknownFirst(
      1000n,
      { knownQuantityScaled: 1000n, knownValueMinor: 75n },
      2500n,
    );
    expect(result.knownQuantityConsumedScaled).toBe(1000n);
    expect(result.knownValueConsumedMinor).toBe(75n);
    expect(result.unknownQuantityConsumedScaled).toBe(1500n);
    expect(result.knownQuantityScaled).toBe(0n);
    expect(result.knownValueMinor).toBe(0n);
  });

  it('refuses a cost pool that pretends to own more quantity than positive stock', () => {
    expect(() =>
      assertPoolFitsStock(1000n, { knownQuantityScaled: 2000n, knownValueMinor: 10n }),
    ).toThrow(/exceeds positive stock/);
    expect(() =>
      assertPoolFitsStock(-1000n, { knownQuantityScaled: 1n, knownValueMinor: 1n }),
    ).toThrow(/exceeds positive stock/);
  });
});

describe('known-cost inflow into negative stock', () => {
  it('keeps deficit-filling value as catch-up evidence and only assets the remainder', () => {
    const result = applyKnownInflowAgainstDeficit(
      -1000n,
      { knownQuantityScaled: 0n, knownValueMinor: 0n },
      3000n,
      100n,
    );
    expect(result.deficitFilledQuantityScaled).toBe(1000n);
    expect(result.deficitConsumedValueMinor).toBe(33n);
    expect(result.assetAddedQuantityScaled).toBe(2000n);
    expect(result.assetAddedValueMinor).toBe(67n);
    expect(result.knownQuantityScaled).toBe(2000n);
    expect(result.knownValueMinor).toBe(67n);
  });

  it('assets nothing when the entire known inflow only fills an existing deficit', () => {
    const result = applyKnownInflowAgainstDeficit(
      -5000n,
      { knownQuantityScaled: 0n, knownValueMinor: 0n },
      2000n,
      91n,
    );
    expect(result.deficitFilledQuantityScaled).toBe(2000n);
    expect(result.deficitConsumedValueMinor).toBe(91n);
    expect(result.knownQuantityScaled).toBe(0n);
    expect(result.knownValueMinor).toBe(0n);
  });

  it('refuses an aggregate value that cannot fit PostgreSQL BIGINT', () => {
    expect(() =>
      applyKnownInflowAgainstDeficit(
        1000n,
        { knownQuantityScaled: 1000n, knownValueMinor: 9_223_372_036_854_775_807n },
        1000n,
        1n,
      ),
    ).toThrow(CostingCapacityError);
  });
});

describe('prospective bootstrap', () => {
  it('derives and values only the currently unknown positive quantity', () => {
    const result = bootstrapUnknownCost(
      5000n,
      { knownQuantityScaled: 2000n, knownValueMinor: 80n },
      150n,
    );
    expect(result.valuedQuantityScaled).toBe(3000n);
    expect(result.knownQuantityScaled).toBe(5000n);
    expect(result.knownValueMinor).toBe(230n);
  });

  it('refuses when no positive unknown stock exists', () => {
    expect(
      refusalOf(() =>
        bootstrapUnknownCost(2000n, { knownQuantityScaled: 2000n, knownValueMinor: 80n }, 10n),
      ),
    ).toBe('nothing-to-value');
  });

  it('refuses before a bootstrap would overflow the stored aggregate value', () => {
    expect(() =>
      bootstrapUnknownCost(
        2000n,
        { knownQuantityScaled: 1000n, knownValueMinor: 9_223_372_036_854_775_807n },
        1n,
      ),
    ).toThrow(CostingCapacityError);
  });
});

describe('original-sale return basis', () => {
  it('restores the sale basis, not the current average, with exact cumulative remainder', () => {
    const basis = {
      knownQuantityScaled: 3000n,
      unknownQuantityScaled: 1000n,
      knownValueMinor: 100n,
    };
    const first = allocateOriginalSaleReturnBasis(basis, 0n, 1000n);
    const second = allocateOriginalSaleReturnBasis(basis, 1000n, 1000n);
    const third = allocateOriginalSaleReturnBasis(basis, 2000n, 1000n);
    const final = allocateOriginalSaleReturnBasis(basis, 3000n, 1000n);

    expect(first).toMatchObject({ knownQuantityScaled: 1000n, knownValueMinor: 33n });
    expect(second).toMatchObject({ knownQuantityScaled: 1000n, knownValueMinor: 33n });
    expect(third).toMatchObject({ knownQuantityScaled: 1000n, knownValueMinor: 34n });
    expect(final).toMatchObject({
      knownQuantityScaled: 0n,
      unknownQuantityScaled: 1000n,
      knownValueMinor: 0n,
      cumulativeReturnedQuantityScaled: 4000n,
    });
    expect(
      first.knownValueMinor +
        second.knownValueMinor +
        third.knownValueMinor +
        final.knownValueMinor,
    ).toBe(100n);
  });
  it('canonicalizes cost bootstrap intent and refuses malformed money', () => {
    expect(
      canonicalCostBootstrapForm({
        operationId: '  op-1  ',
        branchId: '018F6000-0000-7000-8000-000000000001',
        productId: '018F6000-0000-7000-8000-000000000002',
        totalValueMinor: '100',
      }),
    ).toEqual([
      'inventory-cost-bootstrap',
      'op-1',
      '018f6000-0000-7000-8000-000000000001',
      '018f6000-0000-7000-8000-000000000002',
      '100',
    ]);

    expect(() =>
      canonicalCostBootstrapForm({
        operationId: 'op-2',
        branchId: '018f6000-0000-7000-8000-000000000001',
        productId: '018f6000-0000-7000-8000-000000000002',
        totalValueMinor: '01',
      }),
    ).toThrow(CostingRequestError);
  });
});
