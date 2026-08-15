import type { MerchantOnboardingService } from '../onboarding/service.js';
import type { Guards } from '../auth/guards.js';
import type { FastifyInstance } from 'fastify';

const UNAUTHENTICATED = { error: 'unauthenticated' } as const;

/**
 * Read-only onboarding surface.
 *
 * No request-controlled tenant identity exists here. The service receives only
 * request.auth, which was reconstructed from the authenticated session.
 */
export interface OnboardingRouteOptions {
  readonly service: MerchantOnboardingService;
  readonly guards: Guards;
}

function hasQueryFields(query: unknown): boolean {
  return typeof query === 'object' && query !== null && Object.keys(query).length !== 0;
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  options: OnboardingRouteOptions,
): void {
  const { service, guards } = options;

  app.get(
    '/v1/admin/onboarding/readiness',
    {
      preHandler: [guards.requireSession, guards.requirePermission('settings.manage')],
    },
    async (request, reply) => {
      const principal = request.auth;
      if (principal === undefined) {
        return reply.code(401).send(UNAUTHENTICATED);
      }

      // There is no legitimate query parameter on this endpoint. In
      // particular, a client may not attempt to redirect the read by sending
      // tenantId, actorUserId or similar authority-bearing input.
      if (hasQueryFields(request.query)) {
        return reply.code(400).send({ error: 'invalid_query' });
      }

      const readiness = await service.readReadiness(principal);

      // An authenticated principal should normally make this impossible, but
      // fail closed rather than manufacturing a "not ready" merchant from a
      // missing tenant row.
      if (readiness === null) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return reply.code(200).send(readiness);
    },
  );
}
