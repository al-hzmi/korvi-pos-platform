import { withTenant } from '../tenant-context.js';
import { iso, minor, oneOf, tenantParam } from './mapping.js';
import type {
  CouponPolicyRecord,
  CouponPolicyStatus,
  PromotionActivationMode,
  PromotionCheckoutPolicy,
  PromotionCheckoutResolution,
  PromotionPolicyEffectKind,
  PromotionPolicyRecord,
  PromotionPolicyStackingMode,
  PromotionPolicyStatus,
  PromotionPolicyTargetKind,
  PromotionRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const PROMOTION_STATUSES: readonly PromotionPolicyStatus[] = ['draft', 'active', 'paused', 'archived'];
const ACTIVATION_MODES: readonly PromotionActivationMode[] = ['automatic', 'coupon'];
const STACKING_MODES: readonly PromotionPolicyStackingMode[] = ['stackable', 'exclusive'];
const EFFECT_KINDS: readonly PromotionPolicyEffectKind[] = ['fixed', 'percentage'];
const TARGET_KINDS: readonly PromotionPolicyTargetKind[] = ['basket', 'products'];
const COUPON_STATUSES: readonly CouponPolicyStatus[] = ['active', 'paused', 'retired'];

interface PromotionRow {
  id: string;
  merchantCode: string;
  name: string;
  status: string;
  activationMode: string;
  priority: number;
  stackingMode: string;
  startsAt: Date | null;
  endsAt: Date | null;
  effectKind: string;
  effectValue: bigint;
  minimumEligibleSubtotalMinor: bigint;
  targetKind: string;
  revision: bigint;
  products: { productId: string }[];
}

interface CouponRow {
  id: string;
  promotionId: string;
  normalizedCode: string;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  totalRedemptionLimit: number | null;
  revision: bigint;
  promotion: PromotionRow;
  _count: { redemptions: number };
}

function promotionToDomain(row: PromotionRow): PromotionPolicyRecord {
  return {
    id: row.id,
    merchantCode: row.merchantCode,
    name: row.name,
    status: oneOf(PROMOTION_STATUSES, row.status, 'promotions.status'),
    activationMode: oneOf(ACTIVATION_MODES, row.activationMode, 'promotions.activationMode'),
    priority: row.priority,
    stackingMode: oneOf(STACKING_MODES, row.stackingMode, 'promotions.stackingMode'),
    startsAt: row.startsAt === null ? null : iso(row.startsAt),
    endsAt: row.endsAt === null ? null : iso(row.endsAt),
    effectKind: oneOf(EFFECT_KINDS, row.effectKind, 'promotions.effectKind'),
    effectValue: minor(row.effectValue),
    minimumEligibleSubtotalMinor: minor(row.minimumEligibleSubtotalMinor),
    targetKind: oneOf(TARGET_KINDS, row.targetKind, 'promotions.targetKind'),
    productIds: row.products.map((entry) => entry.productId).sort(),
    revision: minor(row.revision),
  };
}

function couponToDomain(row: CouponRow): CouponPolicyRecord {
  return {
    id: row.id,
    promotionId: row.promotionId,
    normalizedCode: row.normalizedCode,
    status: oneOf(COUPON_STATUSES, row.status, 'coupons.status'),
    startsAt: row.startsAt === null ? null : iso(row.startsAt),
    endsAt: row.endsAt === null ? null : iso(row.endsAt),
    totalRedemptionLimit: row.totalRedemptionLimit,
    revision: minor(row.revision),
    observedRedemptionCount: row._count.redemptions,
  };
}

function activeWindow(startsAt: Date | null, endsAt: Date | null, at: Date): boolean {
  return (startsAt === null || startsAt <= at) && (endsAt === null || at < endsAt);
}

function couponAvailable(row: CouponRow, at: Date): boolean {
  return (
    row.status === 'active' &&
    activeWindow(row.startsAt, row.endsAt, at) &&
    row.promotion.status === 'active' &&
    row.promotion.activationMode === 'coupon' &&
    activeWindow(row.promotion.startsAt, row.promotion.endsAt, at) &&
    (row.totalRedemptionLimit === null || row._count.redemptions < row.totalRedemptionLimit)
  );
}

/**
 * Current promotion/coupon policy resolver.
 *
 * This is deliberately NOT redemption authority. The count seen here may be
 * stale by the time the cashier confirms payment. recordSale re-locks each
 * coupon and revalidates the exact policy revision and redemption limit inside
 * the sale transaction before any financial fact can commit (ADR-0037).
 */
export function createPromotionRepository(prisma: PrismaClient): PromotionRepository {
  return {
    async resolveForCheckout(scope: TenantScope, input): Promise<PromotionCheckoutResolution> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const at = new Date(input.evaluatedAt);
        if (Number.isNaN(at.getTime())) throw new Error('Invalid promotion evaluation timestamp.');

        const requestedCodes = [...new Set(input.normalizedCouponCodes)].sort();
        const productIds = [...new Set(input.productIds)].sort();

        const automaticRows = (await tx.promotion.findMany({
          where: {
            tenantId: tenant,
            status: 'active',
            activationMode: 'automatic',
            OR: [
              { targetKind: 'basket' },
              ...(productIds.length === 0
                ? []
                : [{ targetKind: 'products', products: { some: { productId: { in: productIds } } } }]),
            ],
          },
          include: { products: { select: { productId: true } } },
          orderBy: [{ priority: 'desc' }, { id: 'asc' }],
        })) as PromotionRow[];

        const couponRows =
          requestedCodes.length === 0
            ? []
            : ((await tx.coupon.findMany({
                where: { tenantId: tenant, normalizedCode: { in: requestedCodes } },
                include: {
                  promotion: { include: { products: { select: { productId: true } } } },
                  _count: { select: { redemptions: true } },
                },
                orderBy: { normalizedCode: 'asc' },
              })) as CouponRow[]);

        const policies: PromotionCheckoutPolicy[] = [];
        for (const row of automaticRows) {
          if (!activeWindow(row.startsAt, row.endsAt, at)) continue;
          policies.push({ promotion: promotionToDomain(row), coupon: null });
        }

        const couponByCode = new Map(couponRows.map((row) => [row.normalizedCode, row] as const));
        const unavailableCouponCodes: string[] = [];
        for (const code of requestedCodes) {
          const row = couponByCode.get(code);
          if (row === undefined || !couponAvailable(row, at)) {
            unavailableCouponCodes.push(code);
            continue;
          }
          policies.push({
            promotion: promotionToDomain(row.promotion),
            coupon: couponToDomain(row),
          });
        }

        return { policies, unavailableCouponCodes };
      });
    },
  };
}
