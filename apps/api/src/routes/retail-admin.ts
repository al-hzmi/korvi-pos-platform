import { z } from 'zod';
import type {
  MerchantRetailAdminService,
  RetailAdminFailureReason,
} from '../retail-admin/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID = z.string().uuid();
const REVISION = z.string().regex(/^[1-9][0-9]{0,18}$/);
const MINOR = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const FACTOR = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) > 1_000n && BigInt(value) % 1_000n === 0n);
const CODE = z.string().trim().min(1).max(64);
const NAME = z.string().trim().min(1).max(200);
const UNIT = z.string().trim().min(1).max(32);
const BARCODE = z.string().trim().min(1).max(64);

const productParams = z.object({ productId: UUID }).strict();
const packageParams = z.object({ packageId: UUID }).strict();
const priceListParams = z.object({ priceListId: UUID }).strict();
const entryParams = z.object({ entryId: UUID }).strict();

const packageCreateBody = z
  .object({
    code: CODE,
    nameAr: NAME,
    nameEn: NAME.nullable().optional().default(null),
    unitLabel: UNIT,
    baseQuantityScaled: FACTOR,
    barcode: BARCODE.nullable().optional().default(null),
  })
  .strict();

const packageUpdateBody = z
  .object({
    expectedRevision: REVISION,
    code: CODE.optional(),
    nameAr: NAME.optional(),
    nameEn: NAME.nullable().optional(),
    unitLabel: UNIT.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedRevision'), {
    message: 'empty package patch',
  });

const barcodeCreateBody = z
  .object({
    packageId: UUID.nullable().optional().default(null),
    barcode: BARCODE,
  })
  .strict();

const basePriceBody = z
  .object({
    expectedPriceMinor: MINOR,
    priceMinor: MINOR,
  })
  .strict()
  .refine((body) => body.expectedPriceMinor !== body.priceMinor, {
    message: 'unchanged price',
  });

const priceListCreateBody = z
  .object({
    code: CODE,
    name: z.string().trim().min(1).max(160),
    context: z.enum(['retail', 'wholesale']),
  })
  .strict();

const priceListUpdateBody = z
  .object({
    expectedRevision: REVISION,
    name: z.string().trim().min(1).max(160).optional(),
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedRevision'), {
    message: 'empty price-list patch',
  });

const priceEntryCreateBody = z
  .object({
    productId: UUID,
    packageId: UUID.nullable().optional().default(null),
    priceMinor: MINOR,
  })
  .strict();

const priceEntryUpdateBody = z
  .object({
    expectedRevision: REVISION,
    priceMinor: MINOR,
  })
  .strict();

const entryDeleteQuery = z.object({ expectedRevision: REVISION }).strict();

const STATUS: Readonly<Record<RetailAdminFailureReason, number>> = {
  'product-not-found': 404,
  'unit-product-required': 422,
  'package-not-found': 404,
  'package-code-taken': 409,
  'barcode-taken': 409,
  'price-list-not-found': 404,
  'price-list-code-taken': 409,
  'price-list-entry-not-found': 404,
  'price-list-entry-taken': 409,
  'active-context-taken': 409,
  'stale-revision': 409,
  'invalid-state': 409,
  'invalid-input': 422,
};

const MESSAGE: Readonly<Record<RetailAdminFailureReason, string>> = {
  'product-not-found': 'الصنف غير موجود.',
  'unit-product-required': 'التعبئة الثابتة متاحة للأصناف بالوحدة فقط.',
  'package-not-found': 'التعبئة غير موجودة أو غير متاحة لهذا الصنف.',
  'package-code-taken': 'رمز التعبئة مستخدم لهذا الصنف.',
  'barcode-taken': 'الباركود مرتبط بوحدة بيع أخرى في المنشأة.',
  'price-list-not-found': 'قائمة الأسعار غير موجودة.',
  'price-list-code-taken': 'رمز قائمة الأسعار مستخدم بالفعل.',
  'price-list-entry-not-found': 'سعر القائمة غير موجود.',
  'price-list-entry-taken': 'يوجد سعر مسجل مسبقاً لنفس الصنف ووحدة البيع.',
  'active-context-taken': 'توجد قائمة أسعار نشطة بالفعل لهذا السياق.',
  'stale-revision': 'تغيّرت البيانات من جلسة أخرى. أعد تحميلها قبل الحفظ.',
  'invalid-state': 'الحالة الحالية لا تسمح بهذا التعديل.',
  'invalid-input': 'بيانات التعبئة أو التسعير غير صالحة.',
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function failure(reply: FastifyReply, reason: RetailAdminFailureReason): FastifyReply {
  return reply.code(STATUS[reason]).send({
    error: reason.replaceAll('-', '_'),
    message: MESSAGE[reason],
  });
}

function respond<T>(
  reply: FastifyReply,
  result:
    | { readonly outcome: 'success'; readonly value: T }
    | {
        readonly outcome: 'failure';
        readonly reason: RetailAdminFailureReason;
      },
  successCode = 200,
): FastifyReply {
  return result.outcome === 'failure'
    ? failure(reply, result.reason)
    : reply.code(successCode).send(result.value);
}

export function registerRetailAdminRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantRetailAdminService; readonly guards: Guards },
): void {
  const { service, guards } = options;
  const productWrite = [guards.requireSession, guards.requirePermission('product.write')];
  const priceManage = [guards.requireSession, guards.requirePermission('price-list.manage')];

  app.get(
    '/v1/admin/products/:productId/commercial',
    { preHandler: productWrite },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      return respond(reply, await service.productCommercial(principal, params.data.productId));
    },
  );

  app.post(
    '/v1/admin/products/:productId/packages',
    { preHandler: productWrite },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = packageCreateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.createPackage(principal, {
          productId: params.data.productId,
          ...body.data,
        }),
        201,
      );
    },
  );

  app.patch(
    '/v1/admin/packages/:packageId',
    { preHandler: productWrite },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = packageParams.safeParse(request.params);
      const body = packageUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updatePackage(principal, params.data.packageId, body.data),
      );
    },
  );

  app.post(
    '/v1/admin/products/:productId/barcodes',
    { preHandler: productWrite },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = barcodeCreateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.addBarcode(principal, {
          productId: params.data.productId,
          packageId: body.data.packageId,
          barcode: body.data.barcode,
        }),
        201,
      );
    },
  );

  app.patch(
    '/v1/admin/products/:productId/base-price',
    { preHandler: productWrite },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = basePriceBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updateBasePrice(principal, params.data.productId, body.data),
      );
    },
  );

  app.get('/v1/admin/price-lists', { preHandler: priceManage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send({ priceLists: await service.priceLists(principal) });
  });

  app.post('/v1/admin/price-lists', { preHandler: priceManage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = priceListCreateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    return respond(reply, await service.createPriceList(principal, body.data), 201);
  });

  app.patch(
    '/v1/admin/price-lists/:priceListId',
    { preHandler: priceManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = priceListParams.safeParse(request.params);
      const body = priceListUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updatePriceList(principal, params.data.priceListId, body.data),
      );
    },
  );

  app.post(
    '/v1/admin/price-lists/:priceListId/entries',
    { preHandler: priceManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = priceListParams.safeParse(request.params);
      const body = priceEntryCreateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.createPriceListEntry(principal, params.data.priceListId, body.data),
        201,
      );
    },
  );

  app.patch(
    '/v1/admin/price-list-entries/:entryId',
    { preHandler: priceManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = entryParams.safeParse(request.params);
      const body = priceEntryUpdateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.updatePriceListEntry(principal, params.data.entryId, body.data),
      );
    },
  );

  app.delete(
    '/v1/admin/price-list-entries/:entryId',
    { preHandler: priceManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = entryParams.safeParse(request.params);
      const query = entryDeleteQuery.safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ error: 'invalid_query' });
      return respond(
        reply,
        await service.deletePriceListEntry(
          principal,
          params.data.entryId,
          query.data.expectedRevision,
        ),
      );
    },
  );
}
