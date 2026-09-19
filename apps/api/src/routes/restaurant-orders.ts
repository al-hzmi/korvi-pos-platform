import { z } from 'zod';
import { RestaurantOrderRefusedError } from '@korvi/database';
import { UUID } from './validation.js';
import type {
  MerchantRestaurantOrderService,
  RestaurantOrderCommandResult,
} from '../restaurant/order-service.js';
import type { RestaurantOrderRefusal } from '@korvi/database';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const QUANTITY = z.string().regex(/^[1-9][0-9]{0,18}$/);
const OPTIONAL_PREP = z.string().trim().max(500).nullable();
const orderParams = z.object({ orderId: UUID }).strict();
const orderLine = z
  .object({
    productId: UUID,
    quantityScaled: QUANTITY,
    preparationNote: OPTIONAL_PREP.optional().default(null),
    preparationOptions: OPTIONAL_PREP.optional().default(null),
  })
  .strict();
const createBody = z
  .object({
    operationId: UUID,
    terminalId: UUID,
    orderType: z.enum(['dine-in', 'takeaway', 'delivery']),
    tableId: UUID.nullable().optional().default(null),
    lines: z.array(orderLine).min(1).max(200),
  })
  .strict();
const cancelBody = z
  .object({
    operationId: UUID,
    expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
const transferTableBody = z
  .object({
    operationId: UUID,
    expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
    tableId: UUID,
  })
  .strict();

export interface RestaurantOrderRouteOptions {
  readonly service: MerchantRestaurantOrderService;
  readonly guards: Guards;
}

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function refusal(reply: FastifyReply, reason: RestaurantOrderRefusal) {
  switch (reason) {
    case 'restaurant-mode-required':
      return reply.code(409).send({ error: 'restaurant_mode_required' });
    case 'branch-required':
      return reply.code(409).send({ error: 'branch_required' });
    case 'unknown-terminal':
      return reply.code(404).send({ error: 'unknown_terminal' });
    case 'unknown-table':
      return reply.code(404).send({ error: 'unknown_table' });
    case 'table-occupied':
      return reply.code(409).send({ error: 'table_occupied' });
    case 'table-not-applicable':
      return reply.code(422).send({ error: 'table_not_applicable' });
    case 'unknown-product':
      return reply.code(422).send({ error: 'unknown_product' });
    case 'product-unavailable':
      return reply.code(409).send({ error: 'product_unavailable' });
    case 'invalid-quantity':
      return reply.code(422).send({ error: 'invalid_quantity' });
    case 'unknown-order':
      return reply.code(404).send({ error: 'restaurant_order_not_found' });
    case 'order-not-open':
      return reply.code(409).send({ error: 'restaurant_order_not_open' });
    case 'stale-revision':
      return reply.code(409).send({ error: 'restaurant_order_stale' });
    case 'idempotency-conflict':
      return reply.code(409).send({ error: 'idempotency_conflict' });
    case 'operation-in-progress':
      return reply.code(409).send({ error: 'operation_in_progress' });
  }
}

function command(reply: FastifyReply, result: RestaurantOrderCommandResult, created: boolean) {
  if (result.outcome === 'failure') return refusal(reply, result.reason);
  return reply.code(created && !result.value.replayed ? 201 : 200).send(result.value);
}

export function registerRestaurantOrderRoutes(
  app: FastifyInstance,
  options: RestaurantOrderRouteOptions,
): void {
  const { service, guards } = options;
  const canOperate = [guards.requireSession, guards.requirePermission('sale.create')];
  const canCancel = [guards.requireSession, guards.requirePermission('sale.void')];

  app.get('/v1/restaurant/orders', { preHandler: canOperate }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    try {
      return reply.code(200).send({ orders: await service.listOpen(principal) });
    } catch (error) {
      if (error instanceof RestaurantOrderRefusedError) return refusal(reply, error.detail);
      throw error;
    }
  });

  app.get('/v1/restaurant/orders/:orderId', { preHandler: canOperate }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const params = orderParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });

    try {
      const order = await service.detail(principal, params.data.orderId);
      if (order === null) return reply.code(404).send({ error: 'restaurant_order_not_found' });
      return reply.code(200).send(order);
    } catch (error) {
      if (error instanceof RestaurantOrderRefusedError) return refusal(reply, error.detail);
      throw error;
    }
  });

  app.post('/v1/restaurant/orders', { preHandler: canOperate }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    return command(reply, await service.create(principal, body.data), true);
  });

  app.post(
    '/v1/restaurant/orders/:orderId/transfer-table',
    { preHandler: canOperate },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = orderParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const body = transferTableBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return command(
        reply,
        await service.transferTable(principal, params.data.orderId, body.data),
        false,
      );
    },
  );

  app.post(
    '/v1/restaurant/orders/:orderId/cancel',
    { preHandler: canCancel },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = orderParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const body = cancelBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      return command(reply, await service.cancel(principal, params.data.orderId, body.data), false);
    },
  );
}
