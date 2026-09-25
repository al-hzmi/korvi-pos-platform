import { z } from 'zod';
import { MINOR, UUID } from './validation.js';
import type {
  CouponCreateInput,
  CouponUpdateInput,
  MerchantPromotionAdminService,
  PromotionAdminFailureReason,
  PromotionAdminResult,
  PromotionCreateInput,
  PromotionUpdateInput,
} from '../promotions/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REVISION = z.string().regex(/^[1-9][0-9]{0,18}$/);
const OPTIONAL_TIME = z.string().min(1).max(40).nullable();
const MERCHANT_CODE = z.string().trim().min(1).max(64);
const PROMOTION_NAME = z.string().trim().min(1).max(160);
const COUPON_CODE = z.string().trim().min(1).max(64);
const PRIORITY = z.number().int().min(-1_000_000).max(1_000_000);
const LIMIT = z.number().int().min(1).max(2_147_483_647).nullable();

const promotionParams = z.object({ promotionId: UUID }).strict();
const couponParams = z.object({ couponId: UUID }).strict();

const promotionCreateBody = z
  .object({
    merchantCode: MERCHANT_CODE,
    name: PROMOTION_NAME,
    activationMode: z.enum(['automatic', 'coupon']),
    priority: PRIORITY,
    stackingMode: z.enum(['stackable', 'exclusive']),
    startsAt: OPTIONAL_TIME.optional().default(null),
    endsAt: OPTIONAL_TIME.optional().default(null),
    effectKind: z.enum(['fixed', 'percentage']),
    effectValue: MINOR,
    minimumEligibleSubtotalMinor: MINOR.optional().default('0'),
    targetKind: z.enum(['basket', 'products']),
    productIds: z.array(UUID).max(500).optional().default([]),
  })
  .strict()
  .refine(
    (body) =>
      (body.targetKind === 'basket' && body.productIds.length === 0) ||
      (body.targetKind === 'products' && body.productIds.length > 0),
    { message: 'target/product mismatch' },
  );

const promotionUpdateBody = z
  .object({
    expectedRevision: REVISION,
    merchantCode: MERCHANT_CODE.optional(),
    name: PROMOTION_NAME.optional(),
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
    activationMode: z.enum(['automatic', 'coupon']).optional(),
    priority: PRIORITY.optional(),
    stackingMode: z.enum(['stackable', 'exclusive']).optional(),
    startsAt: OPTIONAL_TIME.optional(),
    endsAt: OPTIONAL_TIME.optional(),
    effectKind: z.enum(['fixed', 'percentage']).optional(),
    effectValue: MINOR.optional(),
    minimumEligibleSubtotalMinor: MINOR.optional(),
    targetKind: z.enum(['basket', 'products']).optional(),
    productIds: z.array(UUID).max(500).optional(),
  })
  .strict()
  .refine(
    (body) =>
      Object.keys(body).some((key) => key !== 'expectedRevision'),
    { message: 'empty promotion patch' },
  )
  .refine(
    (body) => body.targetKind !== 'basket' || body.productIds === undefined || body.productIds.length === 0,
    { message: 'basket target cannot carry product ids' },
  );

const couponCreateBody = z
  .object({
    code: COUPON_CODE,
    status: z.enum(['active', 'paused']).optional().default('active'),
    startsAt: OPTIONAL_TIME.optional().default(null),
    endsAt: OPTIONAL_TIME.optional().default(null),
    totalRedemptionLimit: LIMIT.optional().default(null),
  })
  .strict();

const couponUpdateBody = z
  .object({
    expectedRevision: REVISION,
    code: COUPON_CODE.optional(),
    status: z.enum(['active', 'paused', 'retired']).optional(),
    startsAt: OPTIONAL_TIME.optional(),
    endsAt: OPTIONAL_TIME.optional(),
    totalRedemptionLimit: LIMIT.optional(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'expectedRevision'),
    { message: 'empty coupon patch' },
  );

const MESSAGES: Readonly<Record<PromotionAdminFailureReason, string>> = {
  'promotion-not-found': 'العرض غير موجود.',
  'coupon-not-found': 'الكوبون غير موجود.',
  'promotion-code-taken': 'رمز العرض مستخدم بالفعل.',
  'coupon-code-taken': 'كود الخصم مستخدم بالفعل.',
  'stale-revision': 'تم تعديل البيانات من جلسة أخرى. أعد تحميل الصفحة.',
  'invalid-state': 'الحالة الحالية لا تسمح بهذا التعديل.',
  'product-not-found': 'أحد الأصناف المحددة غير موجود.',
  'invalid-input': 'بيانات العرض أو الكوبون غير صالحة.',
};

const STATUS: Readonly<Record<PromotionAdminFailureReason, number>> = {
  'promotion-not-found': 404,
  'coupon-not-found': 404,
  'promotion-code-taken': 409,
  'coupon-code-taken': 409,
  'stale-revision': 409,
  'invalid-state': 409,
  'product-not-found': 404,
  'invalid-input': 422,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond<T>(
  reply: FastifyReply,
  result: PromotionAdminResult<T>,
  successCode = 200,
): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason]).send({
      error: result.reason.replace(/-/g, '_'),
      message: MESSAGES[result.reason],
    });
  }
  return reply.code(successCode).send(result.value);
}

function createInput(body: z.infer<typeof promotionCreateBody>): PromotionCreateInput {
  return {
    merchantCode: body.merchantCode,
    name: body.name,
    activationMode: body.activationMode,
    priority: body.priority,
    stackingMode: body.stackingMode,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    effectKind: body.effectKind,
    effectValue: body.effectValue,
    minimumEligibleSubtotalMinor: body.minimumEligibleSubtotalMinor,
    targetKind: body.targetKind,
    productIds: body.productIds,
  };
}

function updateInput(body: z.infer<typeof promotionUpdateBody>): PromotionUpdateInput {
  return {
    expectedRevision: body.expectedRevision,
    ...(body.merchantCode === undefined ? {} : { merchantCode: body.merchantCode }),
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.activationMode === undefined ? {} : { activationMode: body.activationMode }),
    ...(body.priority === undefined ? {} : { priority: body.priority }),
    ...(body.stackingMode === undefined ? {} : { stackingMode: body.stackingMode }),
    ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt }),
    ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
    ...(body.effectKind === undefined ? {} : { effectKind: body.effectKind }),
    ...(body.effectValue === undefined ? {} : { effectValue: body.effectValue }),
    ...(body.minimumEligibleSubtotalMinor === undefined
      ? {}
      : { minimumEligibleSubtotalMinor: body.minimumEligibleSubtotalMinor }),
    ...(body.targetKind === undefined ? {} : { targetKind: body.targetKind }),
    ...(body.productIds === undefined ? {} : { productIds: body.productIds }),
  };
}

function couponCreateInput(body: z.infer<typeof couponCreateBody>): CouponCreateInput {
  return {
    code: body.code,
    status: body.status,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    totalRedemptionLimit: body.totalRedemptionLimit,
  };
}

function couponUpdateInput(body: z.infer<typeof couponUpdateBody>): CouponUpdateInput {
  return {
    expectedRevision: body.expectedRevision,
    ...(body.code === undefined ? {} : { code: body.code }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt }),
    ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
    ...(body.totalRedemptionLimit === undefined
      ? {}
      : { totalRedemptionLimit: body.totalRedemptionLimit }),
  };
}

export function registerPromotionAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service: MerchantPromotionAdminService;
    readonly guards: Guards;
  },
): void {
  const { service, guards } = options;
  const manage = [guards.requireSession, guards.requirePermission('promotion.manage')];

  app.get('/v1/admin/promotions', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send({ promotions: await service.list(principal) });
  });

  app.post('/v1/admin/promotions', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const parsed = promotionCreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    return respond(reply, await service.createPromotion(principal, createInput(parsed.data)), 201);
  });

  app.patch(
    '/v1/admin/promotions/:promotionId',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = promotionParams.safeParse(request.params);
      const parsed = promotionUpdateBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updatePromotion(
          principal,
          params.data.promotionId,
          updateInput(parsed.data),
        ),
      );
    },
  );

  app.post(
    '/v1/admin/promotions/:promotionId/coupons',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = promotionParams.safeParse(request.params);
      const parsed = couponCreateBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.createCoupon(
          principal,
          params.data.promotionId,
          couponCreateInput(parsed.data),
        ),
        201,
      );
    },
  );

  app.patch('/v1/admin/coupons/:couponId', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const params = couponParams.safeParse(request.params);
    const parsed = couponUpdateBody.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    return respond(
      reply,
      await service.updateCoupon(principal, params.data.couponId, couponUpdateInput(parsed.data)),
    );
  });
}
