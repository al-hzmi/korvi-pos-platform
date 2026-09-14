import { z } from 'zod';
import { UUID } from './validation.js';
import type { MerchantSalesReadService } from '../sales/read-service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MAX_SALES_PAGE = 100;

const saleParams = z.object({ saleId: UUID }).strict();
const salesQuery = z
  .object({
    branchId: UUID.optional(),
    terminalId: UUID.optional(),
    userId: UUID.optional(),
    status: z.enum(['finalized', 'voided']).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    search: z.string().trim().max(120).optional(),
    cursor: UUID.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SALES_PAGE).optional(),
  })
  .strict()
  .refine(
    (value) => value.from === undefined || value.to === undefined || value.from <= value.to,
    { message: 'from must not be later than to', path: ['from'] },
  );

export interface SalesReadRouteOptions {
  readonly service: MerchantSalesReadService;
  readonly guards: Guards;
}

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

export function registerSalesReadRoutes(
  app: FastifyInstance,
  options: SalesReadRouteOptions,
): void {
  const { service, guards } = options;
  const canRead = [guards.requireSession, guards.requirePermission('report.read')];

  app.get('/v1/admin/sales', { preHandler: canRead }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = salesQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    const page = await service.list(principal, {
      ...(parsed.data.branchId === undefined ? {} : { branchId: parsed.data.branchId }),
      ...(parsed.data.terminalId === undefined ? {} : { terminalId: parsed.data.terminalId }),
      ...(parsed.data.userId === undefined ? {} : { userId: parsed.data.userId }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      ...(parsed.data.from === undefined ? {} : { from: new Date(parsed.data.from) }),
      ...(parsed.data.to === undefined ? {} : { to: new Date(parsed.data.to) }),
      ...(parsed.data.search === undefined || parsed.data.search === ''
        ? {}
        : { search: parsed.data.search }),
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });
    return reply.code(200).send(page);
  });

  app.get('/v1/admin/sales/:saleId', { preHandler: canRead }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = saleParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_params' });

    const sale = await service.detail(principal, parsed.data.saleId);
    if (sale === null) return reply.code(404).send({ error: 'sale_not_found' });
    return reply.code(200).send(sale);
  });
}
