import type { FastifyInstance } from 'fastify';

export type ProcessExit = (code: 0 | 1) => void;

/**
 * Build an idempotent signal handler that drains Fastify before exit.
 *
 * Fastify's `close()` stops accepting new connections, waits for in-flight
 * requests, and triggers `onClose` hooks (including the shared Prisma
 * disconnect). The hard deadline is deliberately longer than ordinary request
 * latency but finite so a broken close hook cannot wedge a deployment forever.
 */
export function createGracefulShutdown(
  app: FastifyInstance,
  exit: ProcessExit = (code) => process.exit(code),
  timeoutMs = 25_000,
): () => void {
  let stopping = false;

  return () => {
    if (stopping) return;
    stopping = true;

    const deadline = setTimeout(() => exit(1), timeoutMs);
    deadline.unref();

    void app.close().then(
      () => {
        clearTimeout(deadline);
        exit(0);
      },
      () => {
        clearTimeout(deadline);
        exit(1);
      },
    );
  };
}
