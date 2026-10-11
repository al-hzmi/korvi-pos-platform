import { z } from 'zod';
import {
  MAX_ZATCA_STATUS_SUBMISSIONS,
  MAX_ZATCA_STATUS_TERMINALS,
  MerchantZatcaStatusRefusedError,
} from '@korvi/database/zatca-merchant';
import type { MerchantZatcaStatusQuery } from '@korvi/database/zatca-merchant';
import type { MerchantZatcaService } from '../zatca/merchant-service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const statusQuery = z
  .object({
    terminalLimit: z.coerce.number().int().min(1).max(MAX_ZATCA_STATUS_TERMINALS).optional(),
    submissionLimit: z.coerce.number().int().min(1).max(MAX_ZATCA_STATUS_SUBMISSIONS).optional(),
  })
  .strict();

export interface ZatcaRouteOptions {
  readonly service: MerchantZatcaService;
  readonly guards: Guards;
}

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

export function registerZatcaRoutes(app: FastifyInstance, options: ZatcaRouteOptions): void {
  const { service, guards } = options;
  const canManage = [guards.requireSession, guards.requirePermission('zatca.manage')];

  app.get('/v1/admin/zatca/status', { preHandler: canManage }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = statusQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    const query: MerchantZatcaStatusQuery = {
      ...(parsed.data.terminalLimit === undefined
        ? {}
        : { terminalLimit: parsed.data.terminalLimit }),
      ...(parsed.data.submissionLimit === undefined
        ? {}
        : { submissionLimit: parsed.data.submissionLimit }),
    };

    try {
      const status = await service.status(principal, query);
      return reply.code(200).send(status);
    } catch (error) {
      if (error instanceof MerchantZatcaStatusRefusedError) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      throw error;
    }
  });
}
