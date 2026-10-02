import { createPrismaClient } from '@korvi/database';
import type { ApiConfig } from '../config.js';
import type { FastifyInstance } from 'fastify';

export interface ReadinessProbe {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export interface OperationalReadinessOptions {
  readonly probe?: ReadinessProbe;
  /**
   * Maximum time a request may wait for dependency readiness.
   *
   * The underlying probe is deliberately not cancelled when this expires:
   * database drivers do not provide a safe generic cancellation primitive at
   * this boundary. The single-flight guard below keeps that one unresolved
   * probe from becoming a thundering herd of additional database work.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_500;

function databaseProbe(connectionString: string | undefined): ReadinessProbe {
  let prisma: ReturnType<typeof createPrismaClient> | null = null;

  const resolve = () => {
    if (connectionString === undefined) return null;
    if (prisma !== null) return prisma;
    prisma = createPrismaClient(connectionString);
    return prisma;
  };

  return {
    check: async () => {
      const client = resolve();
      if (client === null) return false;
      try {
        await client.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      if (prisma === null) return;
      await prisma.$disconnect();
      prisma = null;
    },
  };
}

/**
 * Dependency readiness, deliberately separate from `/health` liveness.
 *
 * Liveness answers whether this process/event loop is alive. Readiness answers
 * whether it can currently reach the authoritative database and should receive
 * new traffic. A dependency outage must therefore yield 503 without causing an
 * orchestrator restart storm.
 */
export function registerOperationalReadiness(
  app: FastifyInstance,
  config: ApiConfig,
  options: OperationalReadinessOptions = {},
): void {
  const probe = options.probe ?? databaseProbe(config.DATABASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('readiness timeoutMs must be a positive safe integer');
  }

  // One dependency operation at a time per process. If PostgreSQL or the
  // driver stalls beyond the public deadline, later probes reuse the same
  // pending operation rather than multiplying work and connection pressure.
  let inFlight: Promise<boolean> | null = null;

  const checkDependency = (): Promise<boolean> => {
    if (inFlight !== null) return inFlight;

    const operation = (async () => {
      try {
        return await probe.check();
      } catch {
        return false;
      }
    })();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  const checkWithinDeadline = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([checkDependency(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  app.get('/ready', async (_request, reply) => {
    const ready = await checkWithinDeadline();
    if (!ready) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return reply.code(200).send({ status: 'ready' });
  });

  app.addHook('onClose', async () => {
    try {
      await probe.close();
    } catch (error) {
      app.log.error(
        { error: error instanceof Error ? error.name : 'unknown' },
        'readiness probe cleanup failed',
      );
    }
  });
}
