import type { FastifyInstance } from 'fastify';

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownRuntime {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface GracefulShutdownOptions {
  readonly runtime?: ShutdownRuntime;
  readonly timeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Install one bounded drain path for every API entrypoint.
 *
 * A termination signal stops Fastify from accepting new work and lets in-flight
 * requests finish through `app.close()`. The hard deadline is deliberately
 * shorter than a typical platform termination window so a wedged close cannot
 * leave the process half-alive indefinitely.
 *
 * The callback is idempotent because SIGTERM followed by SIGINT must not start
 * two concurrent close sequences. Raw close errors are not logged: adapter
 * errors may carry connection details and the operator already has the request
 * / deployment correlation needed to investigate safely.
 */
export function installGracefulShutdown(
  app: FastifyInstance,
  options: GracefulShutdownOptions = {},
): () => void {
  const runtime = options.runtime ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Graceful shutdown timeout must be a positive integer.');
  }

  let stopping = false;
  let deadline: NodeJS.Timeout | null = null;

  const clearDeadline = () => {
    if (deadline === null) return;
    clearTimeout(deadline);
    deadline = null;
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;

    app.log.info({ timeoutMs }, 'graceful shutdown started');
    deadline = setTimeout(() => {
      app.log.error('graceful shutdown deadline exceeded');
      runtime.exit(1);
    }, timeoutMs);
    deadline.unref();

    void app.close().then(
      () => {
        clearDeadline();
        runtime.exit(0);
      },
      () => {
        clearDeadline();
        app.log.error('graceful shutdown failed');
        runtime.exit(1);
      },
    );
  };

  runtime.once('SIGTERM', stop);
  runtime.once('SIGINT', stop);

  return () => {
    runtime.removeListener('SIGTERM', stop);
    runtime.removeListener('SIGINT', stop);
    clearDeadline();
  };
}
