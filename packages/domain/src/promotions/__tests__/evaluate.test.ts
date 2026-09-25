import { describe, expect, it } from 'vitest';
import {
  InvalidPromotionDefinitionError,
  evaluatePromotions,
  type PromotionCandidate,
} from '../evaluate.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    promotionId: '00000000-0000-7000-8000-000000000100',
    revision: 1n,
    merchantCode: 'PROMO-1',
    name: 'عرض',
    status: 'active',
    priority: 100,
    stackingMode: 'stackable',
    startsAtMs: null,
    endsAtMs: null,
    effect: { kind: 'percentage', basisPoints: 1_000n },
    minimumEligibleSubtotalMinor: 0n,
    target: { kind: 'basket' },
    coupon: null,
    ...overrides,
  };
}

const lines = [
  { lineId: '1', productId: 'p1', grossMinor: 333n },
  { lineId: '2', productId: 'p2', grossMinor: 333n },
  { lineId: '3', productId: 'p3', grossMinor: 334n },
] as const;

describe('deterministic promotion evaluator', () => {
  it('allocates an indivisible fixed promotion exactly by largest remainder', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [candidate({ effect: { kind: 'fixed', amountMinor: 5n } })],
    });

    expect(result.totalDiscountMinor).toBe(5n);
    expect(result.lineDiscounts.map((entry) => entry.amountMinor)).toEqual([2n, 1n, 2n]);
    expect(result.lineDiscounts.reduce((sum, entry) => sum + entry.amountMinor, 0n)).toBe(5n);
  });

  it('stacks sequentially against the remaining eligible base', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines: [{ lineId: '1', productId: 'p1', grossMinor: 1_000n }],
      candidates: [
        candidate({
          promotionId: 'b',
          priority: 200,
          effect: { kind: 'percentage', basisPoints: 1_000n },
        }),
        candidate({
          promotionId: 'a',
          priority: 100,
          effect: { kind: 'fixed', amountMinor: 100n },
        }),
      ],
    });

    expect(result.applications.map((entry) => entry.promotionId)).toEqual(['b', 'a']);
    expect(result.applications[0]?.eligibleBaseMinor).toBe(1_000n);
    expect(result.applications[0]?.amountMinor).toBe(100n);
    expect(result.applications[1]?.eligibleBaseMinor).toBe(900n);
    expect(result.applications[1]?.amountMinor).toBe(100n);
    expect(result.totalDiscountMinor).toBe(200n);
  });

  it('chooses one exclusive promotion by merchant priority then immutable id, not by discount size', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [
        candidate({
          promotionId: 'z',
          stackingMode: 'exclusive',
          priority: 500,
          effect: { kind: 'fixed', amountMinor: 900n },
        }),
        candidate({
          promotionId: 'a',
          stackingMode: 'exclusive',
          priority: 600,
          effect: { kind: 'fixed', amountMinor: 1n },
        }),
        candidate({
          promotionId: 'stacked',
          stackingMode: 'stackable',
          priority: 999,
          effect: { kind: 'fixed', amountMinor: 999n },
        }),
      ],
    });

    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]?.promotionId).toBe('a');
    expect(result.totalDiscountMinor).toBe(1n);
  });

  it('does not let an ineligible exclusive rule suppress eligible stackable policy', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [
        candidate({
          promotionId: 'exclusive-miss',
          stackingMode: 'exclusive',
          priority: 999,
          target: { kind: 'products', productIds: ['not-in-cart'] },
          effect: { kind: 'fixed', amountMinor: 900n },
        }),
        candidate({
          promotionId: 'stackable-hit',
          stackingMode: 'stackable',
          priority: 100,
          effect: { kind: 'fixed', amountMinor: 25n },
        }),
      ],
    });

    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]?.promotionId).toBe('stackable-hit');
    expect(result.totalDiscountMinor).toBe(25n);
  });

  it('uses id as deterministic tie-breaker regardless of input order', () => {
    const a = candidate({ promotionId: 'a', priority: 10 });
    const b = candidate({ promotionId: 'b', priority: 10 });

    const first = evaluatePromotions({ evaluatedAtMs: NOW, lines, candidates: [b, a] });
    const second = evaluatePromotions({ evaluatedAtMs: NOW, lines, candidates: [a, b] });

    expect(first.applications.map((entry) => entry.promotionId)).toEqual(['a', 'b']);
    expect(second).toEqual(first);
  });

  it('targets only the explicit product allow-list', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [
        candidate({
          effect: { kind: 'fixed', amountMinor: 500n },
          target: { kind: 'products', productIds: ['p2'] },
        }),
      ],
    });

    expect(result.totalDiscountMinor).toBe(333n);
    expect(result.lineDiscounts).toEqual([
      { lineId: '1', amountMinor: 0n },
      { lineId: '2', amountMinor: 333n },
      { lineId: '3', amountMinor: 0n },
    ]);
  });

  it('applies the minimum subtotal to the eligible target base, not the whole cart', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [
        candidate({
          minimumEligibleSubtotalMinor: 334n,
          target: { kind: 'products', productIds: ['p2'] },
        }),
      ],
    });
    expect(result.applications).toHaveLength(0);
  });

  it('ignores draft, paused, archived, not-yet-active and expired candidates', () => {
    const inactive = [
      candidate({ promotionId: 'draft', status: 'draft' }),
      candidate({ promotionId: 'paused', status: 'paused' }),
      candidate({ promotionId: 'archived', status: 'archived' }),
      candidate({ promotionId: 'future', startsAtMs: NOW + 1 }),
      candidate({ promotionId: 'expired', endsAtMs: NOW }),
    ];
    expect(
      evaluatePromotions({ evaluatedAtMs: NOW, lines, candidates: inactive }).applications,
    ).toHaveLength(0);
  });

  it('carries a server-resolved coupon snapshot without treating it as money', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines,
      candidates: [
        candidate({
          coupon: {
            couponId: '00000000-0000-7000-8000-000000000200',
            normalizedCode: 'SAVE-10',
          },
        }),
      ],
    });

    expect(result.applications[0]?.coupon).toEqual({
      couponId: '00000000-0000-7000-8000-000000000200',
      normalizedCode: 'SAVE-10',
    });
  });

  it('never discounts below zero even when stacked fixed effects exceed the cart', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines: [{ lineId: '1', productId: 'p1', grossMinor: 100n }],
      candidates: [
        candidate({
          promotionId: 'a',
          priority: 2,
          effect: { kind: 'fixed', amountMinor: 90n },
        }),
        candidate({
          promotionId: 'b',
          priority: 1,
          effect: { kind: 'fixed', amountMinor: 90n },
        }),
      ],
    });

    expect(result.totalDiscountMinor).toBe(100n);
    expect(result.applications.map((entry) => entry.amountMinor)).toEqual([90n, 10n]);
  });

  it('bounds the number of applied stackable promotions', () => {
    const result = evaluatePromotions({
      evaluatedAtMs: NOW,
      lines: [{ lineId: '1', productId: 'p1', grossMinor: 1_000n }],
      candidates: Array.from({ length: 8 }, (_, index) =>
        candidate({
          promotionId: String(index).padStart(2, '0'),
          priority: 100 - index,
          effect: { kind: 'fixed', amountMinor: 1n },
        }),
      ),
      maxAppliedPromotions: 3,
    });

    expect(result.applications).toHaveLength(3);
    expect(result.totalDiscountMinor).toBe(3n);
  });

  it('rejects malformed promotion policy instead of silently normalizing it', () => {
    expect(() =>
      evaluatePromotions({
        evaluatedAtMs: NOW,
        lines,
        candidates: [candidate({ effect: { kind: 'percentage', basisPoints: 10_001n } })],
      }),
    ).toThrow(InvalidPromotionDefinitionError);

    expect(() =>
      evaluatePromotions({
        evaluatedAtMs: NOW,
        lines,
        candidates: [
          candidate({
            target: { kind: 'products', productIds: ['p1', 'p1'] },
          }),
        ],
      }),
    ).toThrow(InvalidPromotionDefinitionError);
  });

  it('reconciles every deterministic allocation across adversarial small baskets', () => {
    for (let total = 1n; total <= 100n; total += 1n) {
      const result = evaluatePromotions({
        evaluatedAtMs: NOW,
        lines: [
          { lineId: 'a', productId: 'a', grossMinor: total },
          { lineId: 'b', productId: 'b', grossMinor: total + 1n },
          { lineId: 'c', productId: 'c', grossMinor: total + 2n },
        ],
        candidates: [
          candidate({
            effect: { kind: 'percentage', basisPoints: 3_333n },
          }),
        ],
      });
      const granted = result.lineDiscounts.reduce((sum, entry) => sum + entry.amountMinor, 0n);
      expect(granted).toBe(result.totalDiscountMinor);
      expect(granted).toBeLessThanOrEqual(total * 3n + 3n);
    }
  });
});
