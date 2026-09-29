import { z } from 'zod';
import { UUID } from './validation.js';
import type {
  LotAdminFailureReason,
  LotAdminResult,
  MerchantLotAdminService,
} from '../lots/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { ProductLotAdminConfig } from '@korvi/database';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REVISION = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const SIGNED_QUANTITY = z.string().regex(/^-?[1-9][0-9]{0,18}$/);
const OPERATION_ID = z.string().trim().min(1).max(120);
const REASON = z.string().trim().min(1).max(200);

const productParams = z.object({ productId: UUID }).strict();
const lotParams = z.object({ lotId: UUID }).strict();

const enableBody = z
  .object({
    selectionPolicy: z.enum(['fefo', 'fifo']),
    dateRequirement: z.enum(['optional', 'required']),
  })
  .strict();

const policyBody = z
  .object({
    expectedRevision: REVISION,
    selectionPolicy: z.enum(['fefo', 'fifo']).optional(),
    dateRequirement: z.enum(['optional', 'required']).optional(),
  })
  .strict()
  .refine(
    (body) => body.selectionPolicy !== undefined || body.dateRequirement !== undefined,
    { message: 'empty lot policy patch' },
  );

const statusBody = z
  .object({
    expectedRevision: REVISION,
    status: z.enum(['active', 'blocked', 'closed']),
  })
  .strict();

const reclassificationBody = z
  .object({
    operationId: OPERATION_ID,
    productId: UUID,
    branchId: UUID,
    expectedBalanceRevision: REVISION,
    reason: REASON,
    lines: z
      .array(
        z
          .object({
            lotId: UUID,
            quantityScaled: SIGNED_QUANTITY,
          })
          .strict(),
      )
      .min(2)
      .max(500),
  })
  .strict()
  .refine((body) => new Set(body.lines.map((line) => line.lotId)).size === body.lines.length, {
    message: 'duplicate lot',
  });

const MESSAGES: Readonly<Record<LotAdminFailureReason, string>> = {
  'product-not-found': 'الصنف غير موجود.',
  'untracked-product': 'هذا الصنف لا يخضع لتتبع المخزون.',
  'already-enabled': 'تتبع الدفعات مفعل مسبقًا لهذا الصنف.',
  'not-enabled': 'تتبع الدفعات غير مفعل لهذا الصنف.',
  'negative-stock': 'لا يمكن تفعيل تتبع الدفعات مع وجود رصيد سالب.',
  'stale-revision': 'تغيّرت البيانات من جلسة أخرى. حدّث الصفحة ثم أعد المحاولة.',
  'lot-not-found': 'الدفعة غير موجودة.',
  'invalid-state': 'حالة الدفعة الحالية لا تسمح بهذا التعديل.',
  'invalid-input': 'بيانات الدفعة أو السياسة غير صالحة.',
  'stock-changed': 'تغيّر رصيد المخزون أثناء المراجعة. حدّث الأرصدة وأعد المحاولة.',
  'lot-unavailable': 'الكمية المطلوبة غير متاحة في الدفعة.',
  'idempotency-conflict': 'رقم العملية مستخدم لطلب مختلف.',
};

const STATUS: Readonly<Record<LotAdminFailureReason, number>> = {
  'product-not-found': 404,
  'untracked-product': 409,
  'already-enabled': 409,
  'not-enabled': 409,
  'negative-stock': 409,
  'stale-revision': 409,
  'lot-not-found': 404,
  'invalid-state': 409,
  'invalid-input': 422,
  'stock-changed': 409,
  'lot-unavailable': 409,
  'idempotency-conflict': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond(
  reply: FastifyReply,
  result: LotAdminResult<ProductLotAdminConfig>,
  successCode = 200,
): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason]).send({
      error: result.reason.replaceAll('-', '_'),
      message: MESSAGES[result.reason],
    });
  }
  return reply.code(successCode).send({ config: result.value });
}

export function registerLotAdminRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantLotAdminService; readonly guards: Guards },
): void {
  const { service, guards } = options;
  const manage = [guards.requireSession, guards.requirePermission('lot.manage')];

  app.get('/v1/admin/lots/products/:productId', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const config = await service.read(principal, params.data.productId);
    if (config === null) {
      return reply.code(404).send({ error: 'product_not_found', message: MESSAGES['product-not-found'] });
    }
    return reply.code(200).send({ config });
  });

  app.post(
    '/v1/admin/lots/products/:productId/enable',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = enableBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.enable(principal, params.data.productId, body.data),
        201,
      );
    },
  );

  app.patch(
    '/v1/admin/lots/products/:productId/policy',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = policyBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updatePolicy(principal, params.data.productId, body.data),
      );
    },
  );

  app.patch('/v1/admin/lots/:lotId/status', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const params = lotParams.safeParse(request.params);
    const body = statusBody.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    return respond(reply, await service.updateStatus(principal, params.data.lotId, body.data));
  });

  app.post('/v1/admin/lots/reclassifications', { preHandler: manage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = reclassificationBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    return respond(reply, await service.reclassify(principal, body.data), 201);
  });
}
