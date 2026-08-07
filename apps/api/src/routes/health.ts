import type { FastifyInstance } from 'fastify';

/**
 * Liveness only.
 *
 * It does not touch the database on purpose: a health check that fails when
 * Postgres blinks causes the orchestrator to restart a process that was fine,
 * turning a brief database hiccup into an outage. Readiness lands separately.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.get('/version', () => ({
    name: 'korvi-pos-api',
    phase: 'foundation',
  }));
}
