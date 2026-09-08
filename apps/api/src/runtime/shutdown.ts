import type { FastifyInstance } from 'fastify';

export interface ShutdownRuntime {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code: number): never | void;
  setTimeout(listener: () => void, timeoutMs: number): NodeJS.Timeout;
}

const processRuntime: ShutdownRuntime = {
  once: (signal, listener) => {
    process.once(signal, listener);
  },
  exit: (code) => process.exit(code),
  setTimeout: (listener, timeoutMs) => setTimeout(listener, timeoutMs),
};

/**
 * Install one idempotent graceful-shutdown path for both production and staging.
 *
 * Fastify stops accepting new work and waits for in-flight requests when
 * `close()` runs. A hard deadline prevents a wedged dependency from leaving an
 * old instance alive indefinitely during replacement. We deliberately avoid
 * logging the raw close error because driver errors can contain connection
 * details; the exit code is the operator signal.
 */
export function installGracefulShutdown(
  app: Pick<FastifyInstance, 'close' | 'log'>,
  runtime: ShutdownRuntime = processRuntime,
  timeoutMs = 25_000,
): void {
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;

    const deadline = runtime.setTimeout(() => runtime.exit(1), timeoutMs);
    deadline.unref();

    void app.close().then(
      () => runtime.exit(0),
      () => {
        app.log.error('graceful shutdown failed');
        runtime.exit(1);
      },
    );
  };

  runtime.once('SIGTERM', stop);
  runtime.once('SIGINT', stop);
}
