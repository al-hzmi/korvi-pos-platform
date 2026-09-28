import { describe, expect, it } from 'vitest';
import {
  LotDomainError,
  assertLotEntriesReconcile,
  deriveLotCountPlan,
  lotDateState,
  parseCalendarDate,
  selectLotAllocations,
} from '../lot.js';

const LOT_A = '018f2b1a-0000-7000-8000-0000000000a1';
const LOT_B = '018f2b1a-0000-7000-8000-0000000000b2';
const LOT_C = '018f2b1a-0000-7000-8000-0000000000c3';

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof LotDomainError) return error.detail;
    throw error;
  }
  throw new Error('expected refusal');
}

describe('lot calendar semantics', () => {
  it('validates date-only facts without timezone-dependent parsing', () => {
    expect(parseCalendarDate('2026-09-29')).toBeGreaterThan(0);
    for (const bad of ['2026-02-30', '2026-9-1', '2026-13-01', '', '2026-09-29T00:00:00Z']) {
      expect(refusal(() => parseCalendarDate(bad))).toBe('invalid-date');
    }
  });

  it('blocks expired expiry but keeps past best-before as a distinct fact', () => {
    expect(lotDateState('expiry', '2026-09-28', '2026-09-29')).toBe('expired');
    expect(lotDateState('best-before', '2026-09-28', '2026-09-29')).toBe('past-best-before');
    expect(lotDateState('expiry', '2026-09-29', '2026-09-29')).toBe('eligible');
    expect(lotDateState(null, null, '2026-09-29')).toBe('unknown');
  });

  it('refuses half-known date identity', () => {
    expect(refusal(() => lotDateState('expiry', null, '2026-09-29'))).toBe('invalid-date-shape');
  });
});

describe('deterministic outgoing lot selection', () => {
  const base = [
    {
      lotId: LOT_A,
      availableQuantityScaled: 2_000n,
      firstObservedAtMs: 100,
      dateKind: 'expiry' as const,
      dateValue: '2026-10-05',
      status: 'active' as const,
    },
    {
      lotId: LOT_B,
      availableQuantityScaled: 3_000n,
      firstObservedAtMs: 200,
      dateKind: 'best-before' as const,
      dateValue: '2026-10-01',
      status: 'active' as const,
    },
    {
      lotId: LOT_C,
      availableQuantityScaled: 5_000n,
      firstObservedAtMs: 50,
      dateKind: null,
      dateValue: null,
      status: 'active' as const,
    },
  ];

  it('FEFO uses known date first and unknown date last', () => {
    expect(
      selectLotAllocations({
        requiredQuantityScaled: 4_000n,
        policy: 'fefo',
        businessDate: '2026-09-29',
        candidates: base,
      }),
    ).toEqual([
      { lotId: LOT_B, quantityScaled: 3_000n },
      { lotId: LOT_A, quantityScaled: 1_000n },
    ]);
  });

  it('FIFO uses first receipt order and ignores date order after expiry eligibility', () => {
    expect(
      selectLotAllocations({
        requiredQuantityScaled: 4_000n,
        policy: 'fifo',
        businessDate: '2026-09-29',
        candidates: base,
      }),
    ).toEqual([{ lotId: LOT_C, quantityScaled: 4_000n }]);
  });

  it('never auto-selects an expired expiry lot, while past best-before remains eligible', () => {
    const selected = selectLotAllocations({
      requiredQuantityScaled: 1_000n,
      policy: 'fefo',
      businessDate: '2026-10-02',
      candidates: [
        { ...base[0]!, dateValue: '2026-09-30' },
        { ...base[1]!, dateValue: '2026-09-30' },
      ],
    });
    expect(selected).toEqual([{ lotId: LOT_B, quantityScaled: 1_000n }]);
  });

  it('refuses instead of consuming blocked/expired/insufficient lot stock', () => {
    expect(
      refusal(() =>
        selectLotAllocations({
          requiredQuantityScaled: 9_000n,
          policy: 'fefo',
          businessDate: '2026-09-29',
          candidates: [{ ...base[0]!, status: 'blocked' }, base[1]!],
        }),
      ),
    ).toBe('insufficient-eligible-lot');
  });

  it('uses lot id as the final deterministic tie break', () => {
    const equal = [
      { ...base[1]!, lotId: LOT_B, firstObservedAtMs: 100, dateValue: '2026-10-01' },
      { ...base[1]!, lotId: LOT_A, firstObservedAtMs: 100, dateValue: '2026-10-01' },
    ];
    expect(
      selectLotAllocations({
        requiredQuantityScaled: 4_000n,
        policy: 'fefo',
        businessDate: '2026-09-29',
        candidates: equal,
      }),
    ).toEqual([
      { lotId: LOT_A, quantityScaled: 3_000n },
      { lotId: LOT_B, quantityScaled: 1_000n },
    ]);
  });
});

describe('canonical movement reconciliation', () => {
  it('requires lot entries to match the movement sign and exact total', () => {
    expect(() =>
      assertLotEntriesReconcile(-5_000n, [
        { lotId: LOT_A, quantityScaled: -2_000n },
        { lotId: LOT_B, quantityScaled: -3_000n },
      ]),
    ).not.toThrow();

    expect(
      refusal(() =>
        assertLotEntriesReconcile(-5_000n, [
          { lotId: LOT_A, quantityScaled: -2_000n },
          { lotId: LOT_B, quantityScaled: 3_000n },
        ]),
      ),
    ).toBe('allocation-sign-mismatch');

    expect(
      refusal(() => assertLotEntriesReconcile(5_000n, [{ lotId: LOT_A, quantityScaled: 4_000n }])),
    ).toBe('allocation-total-mismatch');
  });

  it('refuses duplicate lot rows because one movement has one canonical allocation per lot', () => {
    expect(
      refusal(() =>
        assertLotEntriesReconcile(2_000n, [
          { lotId: LOT_A, quantityScaled: 1_000n },
          { lotId: LOT_A, quantityScaled: 1_000n },
        ]),
      ),
    ).toBe('duplicate-lot');
  });
});

describe('lot-aware physical count planning', () => {
  it('identifies a zero-net lot reclassification without inventing a stock movement', () => {
    const plan = deriveLotCountPlan({
      current: [
        { lotId: LOT_A, quantityScaled: 5_000n },
        { lotId: LOT_B, quantityScaled: 5_000n },
      ],
      counted: [
        { lotId: LOT_A, quantityScaled: 4_000n },
        { lotId: LOT_B, quantityScaled: 6_000n },
      ],
    });
    expect(plan.totalDeltaQuantityScaled).toBe(0n);
    expect(plan.isZeroNetReclassification).toBe(true);
    expect(plan.lines).toEqual([
      {
        lotId: LOT_A,
        beforeQuantityScaled: 5_000n,
        countedQuantityScaled: 4_000n,
        deltaQuantityScaled: -1_000n,
      },
      {
        lotId: LOT_B,
        beforeQuantityScaled: 5_000n,
        countedQuantityScaled: 6_000n,
        deltaQuantityScaled: 1_000n,
      },
    ]);
  });

  it('separates Product stock delta from lot distribution deltas', () => {
    const plan = deriveLotCountPlan({
      current: [{ lotId: LOT_A, quantityScaled: 5_000n }],
      counted: [
        { lotId: LOT_A, quantityScaled: 4_000n },
        { lotId: LOT_B, quantityScaled: 2_000n },
      ],
    });
    expect(plan.totalBeforeQuantityScaled).toBe(5_000n);
    expect(plan.totalCountedQuantityScaled).toBe(6_000n);
    expect(plan.totalDeltaQuantityScaled).toBe(1_000n);
    expect(plan.isZeroNetReclassification).toBe(false);
  });
});
