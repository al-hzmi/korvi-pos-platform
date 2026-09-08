import { createPrismaClient, type PrismaClient } from '@korvi/database';
import type { ApiConfig } from '../config.js';
import type { FastifyInstance } from 'fastify';

export interface ReadinessProbe {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export interface OperationalReadinessOptions {
  readonly probe?: ReadinessProbe;
}

/**
 * Database reachability for orchestration readiness, not liveness.
 *
 * The client is lazy so boot and `/health` stay independent from PostgreSQL.
 * A missing DATABASE_URL is a deterministic not-ready state rather than an
 * exception. Query failures are collapsed to `false`: driver text may include
 * connection details and a public readiness endpoint must never echo it.
 */
export function createDatabaseReadinessProbe(connectionString: string | undefined): ReadinessProbe {
  let client: PrismaClient | null = null;

  const resolve = (): PrismaClient | null => {
    if (connectionString === undefined) return null;
    client ??= createPrismaClient(connectionString);
    return client;
  };

  return {
    async check(): Promise<boolean> {
      const prisma = resolve();
      if (prisma === null) return false;
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      if (client === null) return;
      const current = client;
      client = null;
      await current.$disconnect();
    },
  };
}

/**
 * Register readiness separately from the server's liveness endpoint.
 *
 * `/health` answers whether the process event loop can serve HTTP. `/ready`
 * answers whether this instance should receive business traffic. Conflating
 * the two would make a brief database outage trigger process restart storms.
 */
export function registerOperationalReadiness(
  app: FastifyInstance,
  config: ApiConfig,
  options: OperationalReadinessOptions = {},
): void {
  const probe = options.probe ?? createDatabaseReadinessProbe(config.DATABASE_URL);

  app.get('/ready', async (_request, reply) => {
    let ready = false;
    try {
      ready = await probe.check();
    } catch {
      ready = false;
    }

    if (!ready) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return reply.code(200).send({ status: 'ready' });
  });

  app.addHook('onClose', async () => {
    await probe.close();
  });
}
