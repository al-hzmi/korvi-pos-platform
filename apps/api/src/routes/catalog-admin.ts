import { z } from 'zod';
import {
  MAX_PRODUCT_BARCODE,
  MAX_PRODUCT_NAME,
  MAX_PRODUCT_SKU,
  MAX_UNIT_LABEL,
} from '@korvi/domain';
import { BASIS_POINTS, MINOR } from './validation.js';
import type { MerchantProductService, ProductAdminFailureReason } from '../catalog/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The narrow catalogue write required by onboarding.
 *
 * No stock quantity, lifecycle state, tenant id, actor id, active flag or price
 * history can arrive from the browser. Those are either derived by the server
 * or belong to later authorities.
 */

const productCreateBody = z
  .object({
    sku: z.string().min(1).max(MAX_PRODUCT_SKU),
    nameAr: z.string().min(1).max(MAX_PRODUCT_NAME),
    nameEn: z.string().max(MAX_PRODUCT_NAME).nullable().optional(),
    productType: z.enum(['unit', 'weighted']),
    unitLabel: z.string().min(1).max(MAX_UNIT_LABEL),
    priceMinor: MINOR,
    vatBasisPoints: BASIS_POINTS.optional(),
    barcode: z.string().max(MAX_PRODUCT_BARCODE).nullable().optional(),
  })
  .strict();

const FORBIDDEN_PRODUCT_FIELDS = [
  'tenantId',
  'tenant',
  'userId',
  'actorUserId',
  'sessionId',
  'categoryId',
  'trackInventory',
  'isActive',
  'createdAt',
  'updatedAt',
  'effectiveFrom',
  'effectiveTo',
  'priceHistory',
  'inventory',
  'inventoryBalance',
  'quantityScaled',
  'roles',
  'permissions',
] as const;

function forbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of FORBIDDEN_PRODUCT_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}

const MESSAGES: Readonly<Record<ProductAdminFailureReason, string>> = {
  'invalid-input': 'بيانات الصنف غير صالحة.',
  'settings-missing': 'إعدادات المنشأة غير مكتملة.',
  'barcode-required': 'إعدادات المنشأة تتطلب باركود لهذا الصنف.',
  'weighted-disabled': 'الأصناف الموزونة غير مفعلة في إعدادات المنشأة.',
  'sku-taken': 'رقم الصنف مستخدم بالفعل في هذه المنشأة.',
  'barcode-taken': 'الباركود مستخدم بالفعل في هذه المنشأة.',
};

const STATUS: Readonly<Record<ProductAdminFailureReason, number>> = {
  'invalid-input': 422,
  'settings-missing': 409,
  'barcode-required': 409,
  'weighted-disabled': 409,
  'sku-taken': 409,
  'barcode-taken': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

export function registerCatalogAdminRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantProductService; readonly guards: Guards },
): void {
  const { service, guards } = options;

  app.post(
    '/v1/admin/products',
    { preHandler: [guards.requireSession, guards.requirePermission('product.write')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

      const field = forbiddenField(request.body);
      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });

      const parsed = productCreateBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await service.create(principal, parsed.data);
      if (result.outcome === 'failure') {
        return reply.code(STATUS[result.reason]).send({
          error: result.reason.replace(/-/g, '_'),
          message: MESSAGES[result.reason],
        });
      }

      return reply.code(201).send(result.value);
    },
  );
}
