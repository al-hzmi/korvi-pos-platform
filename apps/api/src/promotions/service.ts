import {
  PromotionAdminRefusedError,
  createMerchantCoupon,
  createMerchantPromotion,
  listMerchantPromotions,
  updateMerchantCoupon,
  updateMerchantPromotion,
} from '@korvi/database';
import {
  newId as defaultNewId,
  requirePrincipalPermission,
  tenantId as brandTenantId,
} from '@korvi/domain';
import type {
  CouponUpdateRequest,
  PrismaClient,
  PromotionAdminCoupon,
  PromotionAdminRecord,
  PromotionAdminRefusal,
  PromotionUpdateRequest,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export type PromotionAdminFailureReason = PromotionAdminRefusal;

export type PromotionAdminResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: PromotionAdminFailureReason };

export interface PromotionCreateInput {
  readonly merchantCode: string;
  readonly name: string;
  readonly activationMode: 'automatic' | 'coupon';
  readonly priority: number;
  readonly stackingMode: 'stackable' | 'exclusive';
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly effectKind: 'fixed' | 'percentage';
  readonly effectValue: string;
  readonly minimumEligibleSubtotalMinor: string;
  readonly targetKind: 'basket' | 'products';
  readonly productIds: readonly string[];
}

export interface PromotionUpdateInput {
  readonly expectedRevision: string;
  readonly merchantCode?: string | undefined;
  readonly name?: string | undefined;
  readonly status?: 'draft' | 'active' | 'paused' | 'archived' | undefined;
  readonly activationMode?: 'automatic' | 'coupon' | undefined;
  readonly priority?: number | undefined;
  readonly stackingMode?: 'stackable' | 'exclusive' | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly effectKind?: 'fixed' | 'percentage' | undefined;
  readonly effectValue?: string | undefined;
  readonly minimumEligibleSubtotalMinor?: string | undefined;
  readonly targetKind?: 'basket' | 'products' | undefined;
  readonly productIds?: readonly string[] | undefined;
}

export interface CouponCreateInput {
  readonly code: string;
  readonly status: 'active' | 'paused';
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly totalRedemptionLimit: number | null;
}

export interface CouponUpdateInput {
  readonly expectedRevision: string;
  readonly code?: string | undefined;
  readonly status?: 'active' | 'paused' | 'retired' | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly totalRedemptionLimit?: number | null | undefined;
}

export interface MerchantPromotionAdminService {
  list(principal: AuthenticatedPrincipal): Promise<readonly PromotionAdminRecord[]>;
  createPromotion(
    principal: AuthenticatedPrincipal,
    input: PromotionCreateInput,
  ): Promise<PromotionAdminResult<PromotionAdminRecord>>;
  updatePromotion(
    principal: AuthenticatedPrincipal,
    promotionId: string,
    input: PromotionUpdateInput,
  ): Promise<PromotionAdminResult<PromotionAdminRecord>>;
  createCoupon(
    principal: AuthenticatedPrincipal,
    promotionId: string,
    input: CouponCreateInput,
  ): Promise<PromotionAdminResult<PromotionAdminCoupon>>;
  updateCoupon(
    principal: AuthenticatedPrincipal,
    couponId: string,
    input: CouponUpdateInput,
  ): Promise<PromotionAdminResult<PromotionAdminCoupon>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

export function createMerchantPromotionAdminService(
  prisma: PrismaClient,
  options: {
    readonly now?: () => Date;
    readonly newId?: () => string;
  } = {},
): MerchantPromotionAdminService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultNewId;

  async function translate<T>(work: () => Promise<T>): Promise<PromotionAdminResult<T>> {
    try {
      return { outcome: 'success', value: await work() };
    } catch (error) {
      if (error instanceof PromotionAdminRefusedError) {
        return { outcome: 'failure', reason: error.detail };
      }
      throw error;
    }
  }

  return {
    async list(principal) {
      requirePrincipalPermission(principal, 'promotion.manage');
      return listMerchantPromotions(prisma, scopeOf(principal));
    },

    async createPromotion(principal, input) {
      requirePrincipalPermission(principal, 'promotion.manage');
      const occurredAt = now().toISOString();
      return translate(() =>
        createMerchantPromotion(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          {
            id: newId(),
            merchantCode: input.merchantCode,
            name: input.name,
            activationMode: input.activationMode,
            priority: input.priority,
            stackingMode: input.stackingMode,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            effectKind: input.effectKind,
            effectValue: input.effectValue,
            minimumEligibleSubtotalMinor: input.minimumEligibleSubtotalMinor,
            targetKind: input.targetKind,
            productTargets: input.productIds.map((productId) => ({ id: newId(), productId })),
            auditId: newId(),
            occurredAt,
          },
        ),
      );
    },

    async updatePromotion(principal, promotionId, input) {
      requirePrincipalPermission(principal, 'promotion.manage');
      const occurredAt = now().toISOString();
      const request: PromotionUpdateRequest = {
        expectedRevision: input.expectedRevision,
        ...(input.merchantCode === undefined ? {} : { merchantCode: input.merchantCode }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.activationMode === undefined ? {} : { activationMode: input.activationMode }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.stackingMode === undefined ? {} : { stackingMode: input.stackingMode }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
        ...(input.effectKind === undefined ? {} : { effectKind: input.effectKind }),
        ...(input.effectValue === undefined ? {} : { effectValue: input.effectValue }),
        ...(input.minimumEligibleSubtotalMinor === undefined
          ? {}
          : { minimumEligibleSubtotalMinor: input.minimumEligibleSubtotalMinor }),
        ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
        ...(input.productIds === undefined
          ? {}
          : {
              productTargets: input.productIds.map((productId) => ({
                id: newId(),
                productId,
              })),
            }),
        auditId: newId(),
        occurredAt,
      };
      return translate(() =>
        updateMerchantPromotion(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          promotionId,
          request,
        ),
      );
    },

    async createCoupon(principal, promotionId, input) {
      requirePrincipalPermission(principal, 'promotion.manage');
      const occurredAt = now().toISOString();
      return translate(() =>
        createMerchantCoupon(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          {
            id: newId(),
            promotionId,
            code: input.code,
            status: input.status,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            totalRedemptionLimit: input.totalRedemptionLimit,
            auditId: newId(),
            occurredAt,
          },
        ),
      );
    },

    async updateCoupon(principal, couponId, input) {
      requirePrincipalPermission(principal, 'promotion.manage');
      const occurredAt = now().toISOString();
      const request: CouponUpdateRequest = {
        expectedRevision: input.expectedRevision,
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
        ...(input.totalRedemptionLimit === undefined
          ? {}
          : { totalRedemptionLimit: input.totalRedemptionLimit }),
        auditId: newId(),
        occurredAt,
      };
      return translate(() =>
        updateMerchantCoupon(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          couponId,
          request,
        ),
      );
    },
  };
}
