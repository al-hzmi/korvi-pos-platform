import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createCheckoutPreviewService } from '../checkout/preview-service.js';
import {
  MemoryBusinessStore,
  memoryProductRepository,
  memoryTenantRepository,
  seedStore,
} from './support/memory-business.js';
import type {
  AuthenticatedPrincipal,
  PromotionCheckoutResolution,
  PromotionRepository,
} from '@korvi/domain';
import type { Fixture } from './support/memory-business.js';

const A: Fixture = {
  tenant: '018fd300-0000-7000-8000-00000000000a',
  branch: '018fd300-0000-7000-8000-0000000000a1',
  terminal: '018fd300-0000-7000-8000-0000000000a2',
  shift: '018fd300-0000-7000-8000-0000000000a3',
  user: '018fd300-0000-7000-8000-0000000000a4',
  milk: '018fd300-0000-7000-8000-0000000000a5',
  rice: '018fd300-0000-7000-8000-0000000000a6',
};

let store: MemoryBusinessStore;

function principal(): AuthenticatedPrincipal {
  return {
    tenantId: A.tenant,
    tenantSlug: 'preview-a',
    userId: A.user,
    sessionId: '018fd300-0000-7000-8000-0000000000e1',
    email: 'cashier@preview.test',
    displayName: 'كاشير',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: A.branch,
  };
}

function policyResolution(
  overrides: Partial<PromotionCheckoutResolution> = {},
): PromotionCheckoutResolution {
  return {
    policies: [
      {
        promotion: {
          id: '018fd300-0000-7000-8000-000000000101',
          merchantCode: 'AUTO-150',
          name: 'خصم 1.50',
          status: 'active',
          activationMode: 'automatic',
          priority: 100,
          stackingMode: 'stackable',
          startsAt: null,
          endsAt: null,
          effectKind: 'fixed',
          effectValue: '150',
          minimumEligibleSubtotalMinor: '0',
          targetKind: 'basket',
          productIds: [],
          revision: '1',
        },
        coupon: null,
      },
    ],
    unavailableCouponCodes: [],
    ...overrides,
  };
}

function promotions(
  resolve: PromotionRepository['resolveForCheckout'],
): PromotionRepository {
  return { resolveForCheckout: resolve };
}

beforeEach(() => {
  store = new MemoryBusinessStore();
  seedStore(store, A);
});

describe('checkout pricing preview', () => {
  it('uses the same integer VAT engine as checkout with no promotion', async () => {
    const service = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      now: () => new Date('2026-09-25T12:00:00.000Z'),
    });

    const result = await service.preview({
      principal: principal(),
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.pricing).toMatchObject({
      grossMinor: '2300',
      promotionDiscountMinor: '0',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
      applications: [],
    });
  });

  it('applies automatic policy before VAT without inventing browser money', async () => {
    const service = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      promotions: promotions(async () => policyResolution()),
      now: () => new Date('2026-09-25T12:00:00.000Z'),
    });

    const result = await service.preview({
      principal: principal(),
      lines: [{ productId: A.milk, quantityScaled: '2000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(result.pricing.grossMinor).toBe('2300');
    expect(result.pricing.promotionDiscountMinor).toBe('150');
    expect(result.pricing.totalMinor).toBe('2150');
    expect(result.pricing.netMinor).toBe('1870');
    expect(result.pricing.vatMinor).toBe('280');
    expect(result.pricing.applications).toEqual([
      {
        promotionId: '018fd300-0000-7000-8000-000000000101',
        merchantCode: 'AUTO-150',
        name: 'خصم 1.50',
        amountMinor: '150',
        couponCode: null,
      },
    ]);
  });

  it('normalizes coupon intent before policy resolution and requires it to apply', async () => {
    let observedCodes: readonly string[] = [];
    const service = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      promotions: promotions(async (_scope, input) => {
        observedCodes = input.normalizedCouponCodes;
        return policyResolution({
          policies: [
            {
              promotion: {
                ...policyResolution().policies[0]!.promotion,
                id: '018fd300-0000-7000-8000-000000000102',
                merchantCode: 'SAVE-10-PROMO',
                name: 'كوبون',
                activationMode: 'coupon',
                effectValue: '100',
              },
              coupon: {
                id: '018fd300-0000-7000-8000-000000000201',
                promotionId: '018fd300-0000-7000-8000-000000000102',
                normalizedCode: 'SAVE-10',
                status: 'active',
                startsAt: null,
                endsAt: null,
                totalRedemptionLimit: 10,
                revision: '3',
                observedRedemptionCount: 2,
              },
            },
          ],
        });
      }),
      now: () => new Date('2026-09-25T12:00:00.000Z'),
    });

    const result = await service.preview({
      principal: principal(),
      couponCodes: [' save-10 '],
      lines: [{ productId: A.milk, quantityScaled: '1000' }],
    });
    if (result.outcome !== 'success') throw new Error(result.reason);

    expect(observedCodes).toEqual(['SAVE-10']);
    expect(result.pricing.promotionDiscountMinor).toBe('100');
    expect(result.pricing.totalMinor).toBe('1050');
    expect(result.pricing.vatMinor).toBe('137');
    expect(result.pricing.applications[0]?.couponCode).toBe('SAVE-10');
  });

  it('fails closed for unavailable or ineligible coupons', async () => {
    const unavailable = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      promotions: promotions(async () => ({
        policies: [],
        unavailableCouponCodes: ['SAVE-10'],
      })),
    });
    expect(
      await unavailable.preview({
        principal: principal(),
        couponCodes: ['SAVE-10'],
        lines: [{ productId: A.milk, quantityScaled: '1000' }],
      }),
    ).toEqual({ outcome: 'failure', reason: 'coupon-unavailable' });

    const ineligible = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
      promotions: promotions(async () => ({
        ...policyResolution(),
        policies: [],
      })),
    });
    expect(
      await ineligible.preview({
        principal: principal(),
        couponCodes: ['SAVE-10'],
        lines: [{ productId: A.milk, quantityScaled: '1000' }],
      }),
    ).toEqual({ outcome: 'failure', reason: 'coupon-ineligible' });
  });

  it('refuses duplicate products, foreign ids and invalid unit quantity', async () => {
    const service = createCheckoutPreviewService({
      tenants: memoryTenantRepository(store),
      products: memoryProductRepository(store),
    });

    expect(
      await service.preview({
        principal: principal(),
        lines: [
          { productId: A.milk, quantityScaled: '1000' },
          { productId: A.milk, quantityScaled: '1000' },
        ],
      }),
    ).toEqual({ outcome: 'failure', reason: 'duplicate-line' });

    expect(
      await service.preview({
        principal: principal(),
        lines: [
          {
            productId: '018fd300-0000-7000-8000-0000000000ff',
            quantityScaled: '1000',
          },
        ],
      }),
    ).toEqual({ outcome: 'failure', reason: 'unknown-product' });

    expect(
      await service.preview({
        principal: principal(),
        lines: [{ productId: A.milk, quantityScaled: '1500' }],
      }),
    ).toEqual({ outcome: 'failure', reason: 'invalid-quantity' });
  });
});
