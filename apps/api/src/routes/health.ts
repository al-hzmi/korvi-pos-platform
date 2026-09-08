import type { FastifyInstance } from 'fastify';

export interface HealthRouteDeps {
  readonly readiness: () => Promise<boolean>;
}

/**
 * Process liveness and traffic readiness are deliberately separate.
 *
 * `/health` never touches PostgreSQL: an orchestrator must not restart a good
 * process merely because the database has a brief outage. `/ready` is the
 * deployment/load-balancer gate and therefore checks whether the application
 * can reach its runtime database now. No driver detail is exposed to callers.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      if (await deps.readiness()) return reply.code(200).send({ status: 'ready' });
    } catch {
      // The database/driver error belongs in operational telemetry, not in a
      // public probe response. Readiness is binary at this boundary.
    }
    return reply.code(503).send({ status: 'unavailable' });
  });

  app.get('/version', () => ({
    name: 'korvi-pos-api',
    phase: 'stage-5d-closure',
  }));
}
