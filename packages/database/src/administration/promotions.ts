import { InvalidCouponCodeError, normalizeCouponCode } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { lockPromotionPolicyExclusiveWithin } from '../repositories/promotion-repository.js';
import { tenantParam } from '../repositories/mapping.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';

export type PromotionAdminRefusal =
  | 'promotion-not-found'
  | 'coupon-not-found'
  | 'promotion-code-taken'
  | 'coupon-code-taken'
  | 'stale-revision'
  | 'invalid-state'
  | 'product-not-found'
  | 'invalid-input';

export class PromotionAdminRefusedError extends Error {
  public override readonly name = 'PromotionAdminRefusedError';
  public readonly detail: PromotionAdminRefusal;

  public constructor(detail: PromotionAdminRefusal) {
    super(`Promotion administration refused: ${detail}`);
    this.detail = detail;
  }
}

export interface PromotionAdminActor {
  readonly userId: string;
}

export interface PromotionAdminCoupon {
  readonly id: string;
  readonly promotionId: string;
  readonly normalizedCode: string;
  readonly status: 'active' | 'paused' | 'retired';
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly totalRedemptionLimit: number | null;
  readonly observedRedemptionCount: number;
  readonly revision: string;
}

export interface PromotionAdminRecord {
  readonly id: string;
  readonly merchantCode: string;
  readonly name: string;
  readonly status: 'draft' | 'active' | 'paused' | 'archived';
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
  readonly revision: string;
  readonly coupons: readonly PromotionAdminCoupon[];
}

export interface PromotionCreateRequest {
  readonly id: string;
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
  readonly productTargets: readonly {
    readonly id: string;
    readonly productId: string;
  }[];
  readonly auditId: string;
  readonly occurredAt: string;
}

export interface PromotionUpdateRequest {
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
  readonly productTargets?:
    | readonly {
        readonly id: string;
        readonly productId: string;
      }[]
    | undefined;
  readonly auditId: string;
  readonly occurredAt: string;
}

export interface CouponCreateRequest {
  readonly id: string;
  readonly promotionId: string;
  readonly code: string;
  readonly status: 'active' | 'paused';
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly totalRedemptionLimit: number | null;
  readonly auditId: string;
  readonly occurredAt: string;
}

export interface CouponUpdateRequest {
  readonly expectedRevision: string;
  readonly code?: string | undefined;
  readonly status?: 'active' | 'paused' | 'retired' | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
  readonly totalRedemptionLimit?: number | null | undefined;
  readonly auditId: string;
  readonly occurredAt: string;
}

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
  coupons: CouponRow[];
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
  _count: { redemptions: number };
}

const PROMOTION_WITH_CHILDREN = {
  products: { select: { productId: true }, orderBy: { productId: 'asc' } },
  coupons: {
    include: { _count: { select: { redemptions: true } } },
    orderBy: { normalizedCode: 'asc' },
  },
} as const;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function promotionStatus(value: string): PromotionAdminRecord['status'] {
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'archived') {
    return value;
  }
  throw new Error('Promotion status is outside the database contract.');
}

function activationMode(value: string): PromotionAdminRecord['activationMode'] {
  if (value === 'automatic' || value === 'coupon') return value;
  throw new Error('Promotion activation mode is outside the database contract.');
}

function stackingMode(value: string): PromotionAdminRecord['stackingMode'] {
  if (value === 'stackable' || value === 'exclusive') return value;
  throw new Error('Promotion stacking mode is outside the database contract.');
}

function effectKind(value: string): PromotionAdminRecord['effectKind'] {
  if (value === 'fixed' || value === 'percentage') return value;
  throw new Error('Promotion effect kind is outside the database contract.');
}

function targetKind(value: string): PromotionAdminRecord['targetKind'] {
  if (value === 'basket' || value === 'products') return value;
  throw new Error('Promotion target kind is outside the database contract.');
}

function couponStatus(value: string): PromotionAdminCoupon['status'] {
  if (value === 'active' || value === 'paused' || value === 'retired') return value;
  throw new Error('Coupon status is outside the database contract.');
}

function couponToAdmin(row: CouponRow): PromotionAdminCoupon {
  return {
    id: row.id,
    promotionId: row.promotionId,
    normalizedCode: row.normalizedCode,
    status: couponStatus(row.status),
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    totalRedemptionLimit: row.totalRedemptionLimit,
    observedRedemptionCount: row._count.redemptions,
    revision: row.revision.toString(),
  };
}

function promotionToAdmin(row: PromotionRow): PromotionAdminRecord {
  return {
    id: row.id,
    merchantCode: row.merchantCode,
    name: row.name,
    status: promotionStatus(row.status),
    activationMode: activationMode(row.activationMode),
    priority: row.priority,
    stackingMode: stackingMode(row.stackingMode),
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    effectKind: effectKind(row.effectKind),
    effectValue: row.effectValue.toString(),
    minimumEligibleSubtotalMinor: row.minimumEligibleSubtotalMinor.toString(),
    targetKind: targetKind(row.targetKind),
    productIds: row.products.map((entry) => entry.productId),
    revision: row.revision.toString(),
    coupons: row.coupons.map(couponToAdmin),
  };
}

async function loadPromotion(
  tx: TransactionClient,
  tenant: string,
  id: string,
): Promise<PromotionAdminRecord | null> {
  const row = (await tx.promotion.findFirst({
    where: { tenantId: tenant, id },
    include: PROMOTION_WITH_CHILDREN,
  })) as PromotionRow | null;
  return row === null ? null : promotionToAdmin(row);
}

function date(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new PromotionAdminRefusedError('invalid-input');
  return parsed;
}

function normalizedCoupon(value: string): string {
  try {
    return normalizeCouponCode(value);
  } catch (error) {
    if (error instanceof InvalidCouponCodeError) {
      throw new PromotionAdminRefusedError('invalid-input');
    }
    throw error;
  }
}

function revision(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error('invalid');
    return parsed;
  } catch {
    throw new PromotionAdminRefusedError('stale-revision');
  }
}

function validateWindow(startsAt: string | null, endsAt: string | null): void {
  const starts = date(startsAt);
  const ends = date(endsAt);
  if (starts !== null && ends !== null && ends <= starts) {
    throw new PromotionAdminRefusedError('invalid-input');
  }
}

function validateEffect(kind: 'fixed' | 'percentage', value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new PromotionAdminRefusedError('invalid-input');
  }
  if (kind === 'fixed' && parsed > 0n) return parsed;
  if (kind === 'percentage' && parsed >= 1n && parsed <= 10_000n) return parsed;
  throw new PromotionAdminRefusedError('invalid-input');
}

function validateMinimum(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error('invalid');
    return parsed;
  } catch {
    throw new PromotionAdminRefusedError('invalid-input');
  }
}

async function proveProducts(
  tx: TransactionClient,
  tenant: string,
  productIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(productIds)];
  if (unique.length !== productIds.length) throw new PromotionAdminRefusedError('invalid-input');
  if (unique.length === 0) return;
  const rows = await tx.product.findMany({
    where: { tenantId: tenant, id: { in: unique } },
    select: { id: true },
  });
  if (rows.length !== unique.length) throw new PromotionAdminRefusedError('product-not-found');
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actor: PromotionAdminActor,
  input: {
    readonly id: string;
    readonly eventType: string;
    readonly entityType: 'promotion' | 'coupon';
    readonly entityId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    readonly occurredAt: string;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: input.id,
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: { ...input.metadata },
      occurredAt: new Date(input.occurredAt),
    },
  });
}

export async function listMerchantPromotions(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<readonly PromotionAdminRecord[]> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = (await tx.promotion.findMany({
      where: { tenantId: tenantParam(scope) },
      include: PROMOTION_WITH_CHILDREN,
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { merchantCode: 'asc' }],
    })) as PromotionRow[];
    return rows.map(promotionToAdmin);
  });
}

export async function createMerchantPromotion(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: PromotionAdminActor,
  input: PromotionCreateRequest,
): Promise<PromotionAdminRecord> {
  validateWindow(input.startsAt, input.endsAt);
  const effectValue = validateEffect(input.effectKind, input.effectValue);
  const minimum = validateMinimum(input.minimumEligibleSubtotalMinor);
  if (input.targetKind === 'basket' && input.productTargets.length !== 0) {
    throw new PromotionAdminRefusedError('invalid-input');
  }
  if (input.targetKind === 'products' && input.productTargets.length === 0) {
    throw new PromotionAdminRefusedError('invalid-input');
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockPromotionPolicyExclusiveWithin(tx, tenant);

    const codeTaken = await tx.promotion.count({
      where: { tenantId: tenant, merchantCode: input.merchantCode },
    });
    if (codeTaken !== 0) throw new PromotionAdminRefusedError('promotion-code-taken');

    await proveProducts(
      tx,
      tenant,
      input.productTargets.map((target) => target.productId),
    );

    await tx.promotion.create({
      data: {
        id: input.id,
        tenantId: tenant,
        merchantCode: input.merchantCode,
        name: input.name,
        status: 'draft',
        activationMode: input.activationMode,
        priority: input.priority,
        stackingMode: input.stackingMode,
        startsAt: date(input.startsAt),
        endsAt: date(input.endsAt),
        effectKind: input.effectKind,
        effectValue,
        minimumEligibleSubtotalMinor: minimum,
        targetKind: input.targetKind,
        revision: 1n,
        updatedAt: new Date(input.occurredAt),
      },
    });

    if (input.productTargets.length > 0) {
      await tx.promotionProduct.createMany({
        data: input.productTargets.map((target) => ({
          id: target.id,
          tenantId: tenant,
          promotionId: input.id,
          productId: target.productId,
        })),
      });
    }

    await appendAudit(tx, tenant, actor, {
      id: input.auditId,
      eventType: 'promotion.created',
      entityType: 'promotion',
      entityId: input.id,
      metadata: {
        merchantCode: input.merchantCode,
        activationMode: input.activationMode,
        targetKind: input.targetKind,
      },
      occurredAt: input.occurredAt,
    });

    const created = await loadPromotion(tx, tenant, input.id);
    if (created === null) throw new Error('Promotion was created but could not be reloaded.');
    return created;
  });
}

export async function updateMerchantPromotion(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: PromotionAdminActor,
  promotionId: string,
  input: PromotionUpdateRequest,
): Promise<PromotionAdminRecord> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockPromotionPolicyExclusiveWithin(tx, tenant);

    const row = await tx.promotion.findFirst({
      where: { tenantId: tenant, id: promotionId },
      include: { products: { select: { productId: true } }, _count: { select: { coupons: true } } },
    });
    if (row === null) throw new PromotionAdminRefusedError('promotion-not-found');
    if (row.revision !== revision(input.expectedRevision)) {
      throw new PromotionAdminRefusedError('stale-revision');
    }
    if (row.status === 'archived') throw new PromotionAdminRefusedError('invalid-state');

    const nextTargetKind = input.targetKind ?? targetKind(row.targetKind);
    const nextActivationMode = input.activationMode ?? activationMode(row.activationMode);
    const nextStatus = input.status ?? promotionStatus(row.status);
    const productTargets = input.productTargets;
    if (productTargets !== undefined && row.status === 'active') {
      throw new PromotionAdminRefusedError('invalid-state');
    }
    if (nextTargetKind === 'basket' && productTargets !== undefined && productTargets.length !== 0) {
      throw new PromotionAdminRefusedError('invalid-input');
    }
    if (nextTargetKind === 'products') {
      const nextProductIds =
        productTargets?.map((target) => target.productId) ??
        row.products.map((entry) => entry.productId);
      if (nextProductIds.length === 0) throw new PromotionAdminRefusedError('invalid-input');
      await proveProducts(tx, tenant, nextProductIds);
    }
    if (nextActivationMode !== 'coupon' && row._count.coupons > 0) {
      throw new PromotionAdminRefusedError('invalid-state');
    }

    const nextStarts = input.startsAt === undefined ? iso(row.startsAt) : input.startsAt;
    const nextEnds = input.endsAt === undefined ? iso(row.endsAt) : input.endsAt;
    validateWindow(nextStarts, nextEnds);

    const nextEffectKind = input.effectKind ?? effectKind(row.effectKind);
    const nextEffectValue = input.effectValue ?? row.effectValue.toString();
    const effectValue = validateEffect(nextEffectKind, nextEffectValue);
    const minimum = validateMinimum(
      input.minimumEligibleSubtotalMinor ?? row.minimumEligibleSubtotalMinor.toString(),
    );

    if (input.targetKind === 'basket') {
      await tx.promotionProduct.deleteMany({
        where: { tenantId: tenant, promotionId },
      });
    }

    const afterChildDelete = await tx.promotion.findFirst({
      where: { tenantId: tenant, id: promotionId },
      select: { revision: true },
    });
    if (afterChildDelete === null) throw new PromotionAdminRefusedError('promotion-not-found');

    const parentChanged =
      input.merchantCode !== undefined ||
      input.name !== undefined ||
      input.status !== undefined ||
      input.activationMode !== undefined ||
      input.priority !== undefined ||
      input.stackingMode !== undefined ||
      input.startsAt !== undefined ||
      input.endsAt !== undefined ||
      input.effectKind !== undefined ||
      input.effectValue !== undefined ||
      input.minimumEligibleSubtotalMinor !== undefined ||
      input.targetKind !== undefined;

    if (parentChanged) {
      if (input.merchantCode !== undefined && input.merchantCode !== row.merchantCode) {
        const codeTaken = await tx.promotion.count({
          where: {
            tenantId: tenant,
            merchantCode: input.merchantCode,
            NOT: { id: promotionId },
          },
        });
        if (codeTaken !== 0) throw new PromotionAdminRefusedError('promotion-code-taken');
      }

      await tx.promotion.update({
        where: { tenantId_id: { tenantId: tenant, id: promotionId } },
        data: {
          ...(input.merchantCode === undefined ? {} : { merchantCode: input.merchantCode }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.status === undefined ? {} : { status: nextStatus }),
          ...(input.activationMode === undefined ? {} : { activationMode: nextActivationMode }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.stackingMode === undefined ? {} : { stackingMode: input.stackingMode }),
          ...(input.startsAt === undefined ? {} : { startsAt: date(nextStarts) }),
          ...(input.endsAt === undefined ? {} : { endsAt: date(nextEnds) }),
          ...(input.effectKind === undefined ? {} : { effectKind: nextEffectKind }),
          ...(input.effectValue === undefined ? {} : { effectValue }),
          ...(input.minimumEligibleSubtotalMinor === undefined
            ? {}
            : { minimumEligibleSubtotalMinor: minimum }),
          ...(input.targetKind === undefined ? {} : { targetKind: nextTargetKind }),
          revision: afterChildDelete.revision + 1n,
          updatedAt: new Date(input.occurredAt),
        },
      });
    }

    if (productTargets !== undefined && nextTargetKind === 'products') {
      await tx.promotionProduct.deleteMany({
        where: { tenantId: tenant, promotionId },
      });
      if (productTargets.length > 0) {
        await tx.promotionProduct.createMany({
          data: productTargets.map((target) => ({
            id: target.id,
            tenantId: tenant,
            promotionId,
            productId: target.productId,
          })),
        });
      }
    }

    await appendAudit(tx, tenant, actor, {
      id: input.auditId,
      eventType: input.status === undefined ? 'promotion.updated' : 'promotion.status-changed',
      entityType: 'promotion',
      entityId: promotionId,
      metadata: {
        previousStatus: promotionStatus(row.status),
        currentStatus: nextStatus,
      },
      occurredAt: input.occurredAt,
    });

    const updated = await loadPromotion(tx, tenant, promotionId);
    if (updated === null) throw new Error('Promotion was updated but could not be reloaded.');
    return updated;
  });
}

export async function createMerchantCoupon(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: PromotionAdminActor,
  input: CouponCreateRequest,
): Promise<PromotionAdminCoupon> {
  validateWindow(input.startsAt, input.endsAt);
  if (input.totalRedemptionLimit !== null && input.totalRedemptionLimit <= 0) {
    throw new PromotionAdminRefusedError('invalid-input');
  }
  const normalizedCode = normalizedCoupon(input.code);

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockPromotionPolicyExclusiveWithin(tx, tenant);

    const promotion = await tx.promotion.findFirst({
      where: { tenantId: tenant, id: input.promotionId },
    });
    if (promotion === null) throw new PromotionAdminRefusedError('promotion-not-found');
    if (promotion.status === 'archived' || promotion.activationMode !== 'coupon') {
      throw new PromotionAdminRefusedError('invalid-state');
    }

    const codeTaken = await tx.coupon.count({
      where: { tenantId: tenant, normalizedCode },
    });
    if (codeTaken !== 0) throw new PromotionAdminRefusedError('coupon-code-taken');

    const row = (await tx.coupon.create({
      data: {
        id: input.id,
        tenantId: tenant,
        promotionId: input.promotionId,
        normalizedCode,
        status: input.status,
        startsAt: date(input.startsAt),
        endsAt: date(input.endsAt),
        totalRedemptionLimit: input.totalRedemptionLimit,
        revision: 1n,
        updatedAt: new Date(input.occurredAt),
      },
      include: { _count: { select: { redemptions: true } } },
    })) as CouponRow;

    await appendAudit(tx, tenant, actor, {
      id: input.auditId,
      eventType: 'coupon.created',
      entityType: 'coupon',
      entityId: input.id,
      metadata: {
        promotionId: input.promotionId,
        normalizedCode,
        status: input.status,
      },
      occurredAt: input.occurredAt,
    });

    return couponToAdmin(row);
  });
}

export async function updateMerchantCoupon(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: PromotionAdminActor,
  couponId: string,
  input: CouponUpdateRequest,
): Promise<PromotionAdminCoupon> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    await lockPromotionPolicyExclusiveWithin(tx, tenant);

    const row = await tx.coupon.findFirst({
      where: { tenantId: tenant, id: couponId },
    });
    if (row === null) throw new PromotionAdminRefusedError('coupon-not-found');
    if (row.revision !== revision(input.expectedRevision)) {
      throw new PromotionAdminRefusedError('stale-revision');
    }
    if (row.status === 'retired') throw new PromotionAdminRefusedError('invalid-state');

    const nextStarts = input.startsAt === undefined ? iso(row.startsAt) : input.startsAt;
    const nextEnds = input.endsAt === undefined ? iso(row.endsAt) : input.endsAt;
    validateWindow(nextStarts, nextEnds);
    if (
      input.totalRedemptionLimit !== undefined &&
      input.totalRedemptionLimit !== null &&
      input.totalRedemptionLimit <= 0
    ) {
      throw new PromotionAdminRefusedError('invalid-input');
    }

    const normalizedCode =
      input.code === undefined ? row.normalizedCode : normalizedCoupon(input.code);
    if (normalizedCode !== row.normalizedCode) {
      const codeTaken = await tx.coupon.count({
        where: {
          tenantId: tenant,
          normalizedCode,
          NOT: { id: couponId },
        },
      });
      if (codeTaken !== 0) throw new PromotionAdminRefusedError('coupon-code-taken');
    }

    const updated = (await tx.coupon.update({
      where: { tenantId_id: { tenantId: tenant, id: couponId } },
      data: {
        ...(input.code === undefined ? {} : { normalizedCode }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsAt === undefined ? {} : { startsAt: date(nextStarts) }),
        ...(input.endsAt === undefined ? {} : { endsAt: date(nextEnds) }),
        ...(input.totalRedemptionLimit === undefined
          ? {}
          : { totalRedemptionLimit: input.totalRedemptionLimit }),
        revision: row.revision + 1n,
        updatedAt: new Date(input.occurredAt),
      },
      include: { _count: { select: { redemptions: true } } },
    })) as CouponRow;

    await appendAudit(tx, tenant, actor, {
      id: input.auditId,
      eventType: input.status === undefined ? 'coupon.updated' : 'coupon.status-changed',
      entityType: 'coupon',
      entityId: couponId,
      metadata: {
        promotionId: row.promotionId,
        previousStatus: couponStatus(row.status),
        currentStatus: input.status ?? couponStatus(row.status),
      },
      occurredAt: input.occurredAt,
    });

    return couponToAdmin(updated);
  });
}
