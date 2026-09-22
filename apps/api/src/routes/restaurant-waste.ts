import { z } from 'zod';
import type {
  MerchantRestaurantWasteService,
  RestaurantWasteServiceResult,
} from '../restaurant/waste-service.js';
import type { RestaurantWasteRefusal } from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID = z.string().uuid();
const POSITIVE_QUANTITY = z.string().regex(/^[1-9][0-9]{0,18}$/);

const BODY = z
  .object({
    operationId: UUID,
    branchId: UUID,
    reasonType: z.enum(['waste', 'spoilage']),
    note: z.string().trim().min(1).max(200).nullable(),
    lines: z
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

const STATUS: Readonly<Record<RestaurantWasteRefusal, number>> = {
  'restaurant-mode-required': 422,
  'unknown-branch': 404,
  'inactive-branch': 422,
  'unknown-product': 404,
  'inactive-product': 422,
  'untracked-product': 422,
  'invalid-quantity': 422,
  'invalid-lines': 422,
  'duplicate-product': 422,
  'invalid-note': 422,
  'insufficient-stock': 409,
  'idempotency-conflict': 409,
  'operation-in-progress': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond<T>(reply: FastifyReply, result: RestaurantWasteServiceResult<T>): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason]).send({
      error: result.reason.replace(/-/g, '_'),
    });
  }
  return reply.send(result.value);
}

export function registerRestaurantWasteRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantRestaurantWasteService; readonly guards: Guards },
): void {
  const { service, guards } = options;

  app.post(
    '/v1/admin/restaurant/waste',
    {
      preHandler: [
        guards.requireSession,
        guards.requirePermission('product.read'),
        guards.requirePermission('inventory.adjust'),
      ],
    },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const body = BODY.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.record(principal, body.data));
    },
  );
}
