import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { newId } from '@korvi/domain';
import { registerHealthRoutes } from './routes/health.js';
import type { ApiConfig } from './config.js';

export function buildServer(config: ApiConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The central Korvi generator, not crypto.randomUUID. A v4 carries no
    // time, so a request log line could not be ordered against a sale that was
    // rung up offline and synced later. Every identifier in the system comes
    // from one place (ADR-0003).
    genReqId: () => newId(),
  });

  registerHealthRoutes(app);
  return app;
}
