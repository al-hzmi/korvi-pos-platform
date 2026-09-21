import { z } from 'zod';
import type {
  MerchantRestaurantRecipeService,
  RestaurantRecipeServiceResult,
} from '../restaurant/recipe-service.js';
import type { RestaurantRecipeRefusal } from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID = z.string().uuid();
const POSITIVE_QUANTITY = z.string().regex(/^[1-9][0-9]{0,18}$/);
const PARAMS = z.object({ productId: UUID }).strict();
const BODY = z
  .object({
    operationId: UUID,
    expectedRevision: POSITIVE_QUANTITY.nullable(),
    yieldQuantityScaled: POSITIVE_QUANTITY,
    ingredients: z
      .array(
        z
          .object({
            productId: UUID,
            quantityScaled: POSITIVE_QUANTITY,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const STATUS: Readonly<Record<RestaurantRecipeRefusal, number>> = {
  'restaurant-mode-required': 422,
  'unknown-product': 404,
  'product-unavailable': 422,
  'invalid-quantity': 422,
  'duplicate-ingredient': 422,
  'self-ingredient': 422,
  'nested-recipe-unsupported': 422,
  'recipe-product-used-as-ingredient': 422,
  'stale-revision': 409,
  'idempotency-conflict': 409,
  'operation-in-progress': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond<T>(reply: FastifyReply, result: RestaurantRecipeServiceResult<T>): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason]).send({
      error: result.reason.replace(/-/g, '_'),
    });
  }
  return reply.send(result.value);
}

export function registerRestaurantRecipeRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantRestaurantRecipeService; readonly guards: Guards },
): void {
  const { service, guards } = options;

  app.get(
    '/v1/admin/restaurant/recipes/:productId',
    { preHandler: [guards.requireSession, guards.requirePermission('product.read')] },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = PARAMS.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const result = await service.detail(principal, params.data.productId);
      if (result.outcome === 'success' && result.value === null) {
        return reply.code(404).send({ error: 'restaurant_recipe_not_found' });
      }
      return respond(reply, result);
    },
  );

  app.put(
    '/v1/admin/restaurant/recipes/:productId',
    {
      preHandler: [
        guards.requireSession,
        guards.requirePermission('product.write'),
        guards.requirePermission('inventory.adjust'),
      ],
    },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = PARAMS.safeParse(request.params);
      const body = BODY.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      return respond(reply, await service.set(principal, params.data.productId, body.data));
    },
  );
}
