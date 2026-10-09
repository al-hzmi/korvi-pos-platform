import { z } from 'zod';
import { RestaurantModifierAdminRefusedError } from '@korvi/database';
import { UUID } from './validation.js';
import type {
  MerchantRestaurantModifierService,
  RestaurantModifierAdminResult,
} from '../restaurant/modifier-service.js';
import type { RestaurantModifierAdminRefusal } from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REVISION = z.string().regex(/^[1-9][0-9]{0,18}$/);
const NON_NEGATIVE_MINOR = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const CODE = z.string().trim().min(1).max(40).regex(/^\S+$/);
const NAME = z.string().trim().min(1).max(120);
const OPTIONAL_NAME = z.string().trim().min(1).max(120).nullable();
const SORT_ORDER = z.number().int().min(0).max(1_000_000);

const groupCreateBody = z
  .object({
    code: CODE,
    nameAr: NAME,
    nameEn: OPTIONAL_NAME,
    minSelections: z.number().int().min(0).max(32),
    maxSelections: z.number().int().min(1).max(32),
    sortOrder: SORT_ORDER,
  })
  .strict()
  .refine((body) => body.minSelections <= body.maxSelections, {
    message: 'modifier selection bounds are reversed',
  });

const groupPatchBody = z
  .object({
    expectedRevision: REVISION,
    nameAr: NAME.optional(),
    nameEn: OPTIONAL_NAME.optional(),
    minSelections: z.number().int().min(0).max(32).optional(),
    maxSelections: z.number().int().min(1).max(32).optional(),
    sortOrder: SORT_ORDER.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const optionCreateBody = z
  .object({
    code: CODE,
    nameAr: NAME,
    nameEn: OPTIONAL_NAME,
    priceDeltaMinor: NON_NEGATIVE_MINOR,
    sortOrder: SORT_ORDER,
  })
  .strict();

const optionPatchBody = z
  .object({
    expectedRevision: REVISION,
    nameAr: NAME.optional(),
    nameEn: OPTIONAL_NAME.optional(),
    priceDeltaMinor: NON_NEGATIVE_MINOR.optional(),
    sortOrder: SORT_ORDER.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const setGroupsBody = z
  .object({
    expectedGroupIds: z.array(UUID).max(100),
    groupIds: z.array(UUID).max(100),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (new Set(body.expectedGroupIds).size !== body.expectedGroupIds.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate expected group' });
    }
    if (new Set(body.groupIds).size !== body.groupIds.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate target group' });
    }
  });

const ID = z.object({ id: UUID }).strict();

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function refusal(reply: FastifyReply, reason: RestaurantModifierAdminRefusal) {
  switch (reason) {
    case 'restaurant-mode-required':
      return reply.code(409).send({ error: 'restaurant_mode_required' });
    case 'unknown-group':
      return reply.code(404).send({ error: 'modifier_group_not_found' });
    case 'unknown-option':
      return reply.code(404).send({ error: 'modifier_option_not_found' });
    case 'unknown-product':
      return reply.code(404).send({ error: 'product_not_found' });
    case 'stale-revision':
    case 'stale-attachments':
      return reply.code(409).send({ error: reason.replaceAll('-', '_') });
    case 'invalid-definition':
      return reply.code(422).send({ error: 'invalid_modifier_definition' });
    case 'code-conflict':
      return reply.code(409).send({ error: 'modifier_code_conflict' });
  }
}

function mutation<T>(
  reply: FastifyReply,
  result: RestaurantModifierAdminResult<T>,
  created = false,
) {
  if (result.outcome === 'failure') return refusal(reply, result.reason);
  return reply.code(created ? 201 : 200).send(result.value);
}

export function registerRestaurantModifierRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantRestaurantModifierService; readonly guards: Guards },
): void {
  const { service, guards } = options;
  const canSell = [guards.requireSession, guards.requirePermission('sale.create')];
  const canManage = [guards.requireSession, guards.requirePermission('restaurant.menu.manage')];

  app.get(
    '/v1/restaurant/modifiers/products/:id',
    { preHandler: canSell },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      try {
        return reply.code(200).send({ groups: await service.menu(principal, params.data.id) });
      } catch (error) {
        if (error instanceof RestaurantModifierAdminRefusedError) {
          return refusal(reply, error.detail);
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/admin/restaurant/modifier-groups',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      try {
        return reply.code(200).send({ groups: await service.list(principal) });
      } catch (error) {
        if (error instanceof RestaurantModifierAdminRefusedError) {
          return refusal(reply, error.detail);
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/admin/restaurant/modifier-groups',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = groupCreateBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return mutation(reply, await service.createGroup(principal, body.data), true);
    },
  );

  app.patch(
    '/v1/admin/restaurant/modifier-groups/:id',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      const body = groupPatchBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return mutation(reply, await service.updateGroup(principal, params.data.id, body.data));
    },
  );

  app.post(
    '/v1/admin/restaurant/modifier-groups/:id/options',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      const body = optionCreateBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return mutation(
        reply,
        await service.createOption(principal, params.data.id, body.data),
        true,
      );
    },
  );

  app.patch(
    '/v1/admin/restaurant/modifier-options/:id',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      const body = optionPatchBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return mutation(reply, await service.updateOption(principal, params.data.id, body.data));
    },
  );

  app.get(
    '/v1/admin/restaurant/products/:id/modifier-groups',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const result = await service.productGroups(principal, params.data.id);
      if (result.outcome === 'failure') return refusal(reply, result.reason);
      return reply.code(200).send({ groupIds: result.value });
    },
  );

  app.put(
    '/v1/admin/restaurant/products/:id/modifier-groups',
    { preHandler: canManage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = ID.safeParse(request.params);
      const body = setGroupsBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return mutation(reply, await service.setProductGroups(principal, params.data.id, body.data));
    },
  );
}
