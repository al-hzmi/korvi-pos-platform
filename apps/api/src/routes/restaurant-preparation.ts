import { z } from 'zod';
import type {
  MerchantPreparationService,
  PreparationServiceResult,
} from '../restaurant/preparation-service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID = z.string().uuid();
const OPERATION = UUID;
const branchQuery = z
  .object({
    branchId: UUID,
    activeOnly: z.enum(['true', 'false']).optional(),
  })
  .strict();
const createStationBody = z
  .object({
    operationId: OPERATION,
    branchId: UUID,
    code: z.string().min(1).max(40),
    nameAr: z.string().min(1).max(80),
    sortOrder: z.number().int().min(0).max(100000),
  })
  .strict();
const productParams = z.object({ productId: UUID }).strict();
const orderParams = z.object({ orderId: UUID }).strict();
const stationParams = z.object({ stationId: UUID }).strict();
const taskParams = z.object({ taskId: UUID }).strict();
const routesBody = z
  .object({
    operationId: OPERATION,
    branchId: UUID,
    stationIds: z.array(UUID).max(32),
  })
  .strict();
const fireBody = z
  .object({
    operationId: OPERATION,
    expectedOrderRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();
const taskStatusBody = z
  .object({
    operationId: OPERATION,
    expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
    status: z.enum(['preparing', 'ready', 'served']),
  })
  .strict();
const taskQuery = z
  .object({
    includeServed: z.enum(['true', 'false']).optional(),
  })
  .strict();

const STATUS: Record<string, number> = {
  'restaurant-mode-required': 422,
  'unknown-branch': 404,
  'unknown-station': 404,
  'station-code-taken': 409,
  'unknown-product': 404,
  'invalid-input': 422,
  'idempotency-conflict': 409,
  'operation-in-progress': 409,
  'unknown-order': 404,
  'order-not-open': 409,
  'stale-order': 409,
  'unrouted-lines': 422,
  'unknown-task': 404,
  'stale-task': 409,
  'invalid-transition': 409,
};

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

function respond<T>(
  reply: FastifyReply,
  result: PreparationServiceResult<T>,
  code = 200,
): FastifyReply {
  if (result.outcome === 'failure') {
    return reply.code(STATUS[result.reason] ?? 422).send({
      error: result.reason.replace(/-/g, '_'),
    });
  }
  return reply.code(code).send(result.value);
}

export function registerRestaurantPreparationRoutes(
  app: FastifyInstance,
  options: { readonly service: MerchantPreparationService; readonly guards: Guards },
): void {
  const { service, guards } = options;
  const manage = [guards.requireSession, guards.requirePermission('settings.manage')];
  const operate = [guards.requireSession, guards.requirePermission('sale.create')];

  app.get(
    '/v1/admin/restaurant/preparation-stations',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const parsed = branchQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      return respond(
        reply,
        await service.listStations(
          principal,
          parsed.data.branchId,
          parsed.data.activeOnly !== 'false',
        ),
      );
    },
  );

  app.post(
    '/v1/admin/restaurant/preparation-stations',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const parsed = createStationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.createStation(principal, parsed.data), 201);
    },
  );

  app.get(
    '/v1/admin/restaurant/preparation-routes',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const parsed = branchQuery.omit({ activeOnly: true }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
      return respond(reply, await service.listRoutes(principal, parsed.data.branchId));
    },
  );

  app.put(
    '/v1/admin/restaurant/preparation-routes/:productId',
    { preHandler: manage },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = productParams.safeParse(request.params);
      const body = routesBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(
        reply,
        await service.setProductRoutes(principal, {
          operationId: body.data.operationId,
          branchId: body.data.branchId,
          productId: params.data.productId,
          stationIds: body.data.stationIds,
        }),
      );
    },
  );

  app.get(
    '/v1/restaurant/orders/:orderId/preparation-routing',
    { preHandler: operate },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = orderParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const result = await service.routing(principal, params.data.orderId);
      if (result.outcome === 'success' && result.value === null) {
        return reply.code(404).send({ error: 'restaurant_order_not_found' });
      }
      return respond(reply, result);
    },
  );

  app.post(
    '/v1/restaurant/orders/:orderId/preparation/fire',
    { preHandler: operate },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = orderParams.safeParse(request.params);
      const body = fireBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.fire(principal, params.data.orderId, body.data));
    },
  );

  app.get(
    '/v1/restaurant/preparation-stations/:stationId/tasks',
    { preHandler: operate },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = stationParams.safeParse(request.params);
      const query = taskQuery.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_query' });
      return respond(
        reply,
        await service.tasks(
          principal,
          params.data.stationId,
          query.data.includeServed === 'true',
        ),
      );
    },
  );

  app.post(
    '/v1/restaurant/preparation-tasks/:taskId/status',
    { preHandler: operate },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });
      const params = taskParams.safeParse(request.params);
      const body = taskStatusBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
      return respond(reply, await service.updateTask(principal, params.data.taskId, body.data));
    },
  );

}
